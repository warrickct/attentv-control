import fs from 'node:fs'
import type { Express, Request, Response } from 'express'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { ScanCommand } from '@aws-sdk/lib-dynamodb'
import { Pool } from 'pg'
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector'
import { GoogleAuth } from 'google-auth-library'
import {
  type BaselineSummary,
  type BreakComparison,
  type ChannelBreakdownResponse,
  type ChannelBreakdownRow,
  type ChannelDetailResponse,
  type DetailScopeType,
  type ModelInterval,
  type OverviewResponse,
  type OverviewWindowSummary,
  type PerformanceMetrics,
  type ShortTermWindowKey,
  type TrendBucketKey,
  type TrendPoint,
  type TrendRangeKey,
  type TrendsResponse,
  type TruthInterval,
  SHORT_TERM_WINDOWS,
  buildRecordingBreakdown,
  buildBreakComparisons,
  buildDurationBreakdown,
  buildHourOfDayBreakdown,
  buildTrendPoints,
  clipInterval,
  computePerformanceMetrics,
  createBaselineSummary,
  emptyPerformanceMetrics,
  normalizeRecordingLookupValue,
  summarizeWindowComparisons,
} from '../shared/modelPerformance'
import {
  DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
  dayWindow,
  parseTimestampInTimeZone,
  toIsoString,
} from '../shared/timezone'

interface RegisterModelPerformanceRoutesOptions {
  app: Express
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
}

interface AggregateMetricRow {
  channel: string
  bucketStartMs: number
  bucketEndMs: number
  metrics: PerformanceMetrics
  latencySampleCount: number
  startLatencySumSec: number
  overCaptureTailSampleCount: number
  overCaptureTailSumSec: number
}

interface WindowData {
  truthIntervals: TruthInterval[]
  modelIntervals: ModelInterval[]
  breakComparisons: BreakComparison[]
  metrics: PerformanceMetrics
}

interface RecordingInspectionScope {
  channel: string
  normalizedRecordingName: string
  lookupValue: string
  audioPath: string | null
  recordingStartedAt: string | null
  windowStartMs: number
  windowEndMs: number
  truthIntervals: TruthInterval[]
}

interface CacheEntry<T> {
  data: T
  timestamp: number
}

const MODEL_PERFORMANCE_CACHE_TTL_MS = 60 * 1000
const TABLE_CHECK_CACHE_TTL_MS = 5 * 60 * 1000
const performanceCache = new Map<string, CacheEntry<unknown>>()
const tableExistsCache = new Map<string, CacheEntry<boolean>>()

let pgPoolPromise: Promise<Pool> | null = null
let cloudSqlConnector: Connector | null = null

const AGGREGATE_TABLES: Record<TrendBucketKey, string> = {
  '15m': 'model_performance_15min',
  '1h': 'model_performance_hourly',
  '1d': 'model_performance_daily',
}

const WINDOW_TO_BUCKET: Record<ShortTermWindowKey, TrendBucketKey> = {
  '15m': '15m',
  '1h': '1h',
  '24h': '1d',
}

function getCached<T>(key: string, ttlMs: number = MODEL_PERFORMANCE_CACHE_TTL_MS): T | null {
  const entry = performanceCache.get(key) as CacheEntry<T> | undefined
  if (!entry) {
    return null
  }

  if (Date.now() - entry.timestamp > ttlMs) {
    performanceCache.delete(key)
    return null
  }

  return entry.data
}

function setCached<T>(key: string, data: T): void {
  performanceCache.set(key, { data, timestamp: Date.now() })
}

function normalizeChannelValue(channel: unknown): string {
  if (typeof channel !== 'string' || channel.trim() === '' || channel === 'all') {
    return 'all'
  }

  const numericValue = Number.parseInt(channel, 10)
  if (!Number.isFinite(numericValue)) {
    throw new Error(`Invalid channel: ${String(channel)}`)
  }

  return String(numericValue)
}

function parseBoolean(value: unknown, defaultValue: boolean = false): boolean {
  if (typeof value !== 'string') {
    return defaultValue
  }

  return value === 'true' || value === '1'
}

function getTimeZone(request: Request): string {
  const requestedTimeZone = typeof request.query.timezone === 'string' ? request.query.timezone : undefined
  return requestedTimeZone || process.env.MODEL_PERFORMANCE_TIMEZONE || DEFAULT_MODEL_PERFORMANCE_TIMEZONE
}

function shouldUseCloudSqlConnector(): boolean {
  return Boolean(
    process.env.INSTANCE_CONNECTION_NAME ||
      process.env.MODEL_PERFORMANCE_INSTANCE_CONNECTION_NAME,
  )
}

function getCloudSqlCredentialsAuth(): GoogleAuth | undefined {
  const inlineCredentialsJson =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON ||
    process.env.GCP_SERVICE_ACCOUNT_JSON

  const credentialsJson = inlineCredentialsJson ||
    (() => {
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
      if (!credentialsPath || !fs.existsSync(credentialsPath)) {
        return null
      }
      return fs.readFileSync(credentialsPath, 'utf8')
    })()

  if (!credentialsJson) {
    return undefined
  }

  return new GoogleAuth({
    credentials: JSON.parse(credentialsJson),
    scopes: ['https://www.googleapis.com/auth/sqlservice.admin'],
  })
}

async function getPool(): Promise<Pool> {
  if (pgPoolPromise) {
    return pgPoolPromise
  }

  pgPoolPromise = (async () => {
    const connectionString = process.env.MODEL_PERFORMANCE_DATABASE_URL || process.env.DATABASE_URL
    const sslEnabled = parseBoolean(process.env.MODEL_PERFORMANCE_DB_SSL || process.env.PGSSLMODE)

    if (connectionString && !shouldUseCloudSqlConnector()) {
      return new Pool({
        connectionString,
        ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
      })
    }

    if (shouldUseCloudSqlConnector()) {
      const instanceConnectionName =
        process.env.MODEL_PERFORMANCE_INSTANCE_CONNECTION_NAME || process.env.INSTANCE_CONNECTION_NAME
      if (!instanceConnectionName) {
        throw new Error('INSTANCE_CONNECTION_NAME is required when using the Cloud SQL connector.')
      }

      const auth = getCloudSqlCredentialsAuth()
      cloudSqlConnector = new Connector(auth ? { auth } : undefined)
      const clientOptions = await cloudSqlConnector.getOptions({
        instanceConnectionName,
        ipType: (process.env.MODEL_PERFORMANCE_CLOUD_SQL_IP_TYPE || process.env.CLOUD_SQL_IP_TYPE || 'PUBLIC') as IpAddressTypes,
      })

      return new Pool({
        ...clientOptions,
        user: process.env.MODEL_PERFORMANCE_DB_USER || process.env.DB_USER || process.env.PGUSER || 'postgres',
        password:
          process.env.MODEL_PERFORMANCE_DB_PASSWORD ||
          process.env.GOOGLE_SQL_PASS ||
          process.env.PGPASSWORD,
        database: process.env.MODEL_PERFORMANCE_DB_NAME || process.env.DB_NAME || process.env.PGDATABASE || 'fingerprints',
        max: Number.parseInt(process.env.MODEL_PERFORMANCE_DB_POOL_MAX || '5', 10),
      })
    }

    return new Pool({
      host: process.env.MODEL_PERFORMANCE_DB_HOST || process.env.PGHOST || '127.0.0.1',
      port: Number.parseInt(process.env.MODEL_PERFORMANCE_DB_PORT || process.env.PGPORT || '5432', 10),
      user: process.env.MODEL_PERFORMANCE_DB_USER || process.env.DB_USER || process.env.PGUSER || 'postgres',
      password:
        process.env.MODEL_PERFORMANCE_DB_PASSWORD ||
        process.env.GOOGLE_SQL_PASS ||
        process.env.PGPASSWORD,
      database: process.env.MODEL_PERFORMANCE_DB_NAME || process.env.DB_NAME || process.env.PGDATABASE || 'fingerprints',
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
    })
  })()

  return pgPoolPromise
}

async function tableExists(tableName: string): Promise<boolean> {
  const cached = tableExistsCache.get(tableName)
  if (cached && Date.now() - cached.timestamp <= TABLE_CHECK_CACHE_TTL_MS) {
    return cached.data
  }

  const pool = await getPool()
  const result = await pool.query<{ present: string | null }>('SELECT to_regclass($1) AS present', [tableName])
  const exists = Boolean(result.rows[0]?.present)
  tableExistsCache.set(tableName, { data: exists, timestamp: Date.now() })
  return exists
}

async function fetchAvailableChannels(): Promise<string[]> {
  const cacheKey = 'model-performance:channels'
  const cached = getCached<string[]>(cacheKey, TABLE_CHECK_CACHE_TTL_MS)
  if (cached) {
    return cached
  }

  const pool = await getPool()
  const result = await pool.query<{ channel: string }>(`
    SELECT DISTINCT channel::text AS channel
    FROM comskip_ground_truth_recordings
    ORDER BY channel::int
  `)
  const channels = result.rows.map((row) => row.channel)
  setCached(cacheKey, channels)
  return channels
}

function buildTruthInterval(row: Record<string, unknown>): TruthInterval {
  const playedAtStart = new Date(String(row.played_at_start))
  const playedAtEnd = new Date(String(row.played_at_end))

  return {
    startMs: playedAtStart.getTime(),
    endMs: playedAtEnd.getTime(),
    sourceId: `${row.recording_name}#${row.break_number}`,
    label: 'truth',
    metadata: {
      channel: String(row.channel),
      recordingId: Number(row.recording_id),
      recordingName: String(row.recording_name),
      breakId: Number(row.break_id),
      breakNumber: Number(row.break_number),
      audioPath: typeof row.audio_path === 'string' ? row.audio_path : undefined,
      recordingStartedAt: String(row.recording_started_at),
      startOffsetSec: Number(row.start_offset_sec),
      endOffsetSec: Number(row.end_offset_sec),
    },
  }
}

async function fetchTruthIntervals(channel: string, windowStartMs: number, windowEndMs: number): Promise<TruthInterval[]> {
  const pool = await getPool()
  const channelValue = channel === 'all' ? null : Number.parseInt(channel, 10)
  const result = await pool.query<Record<string, unknown>>(`
    SELECT
      r.recording_id,
      r.recording_name,
      r.channel,
      r.audio_path,
      r.recording_started_at,
      b.break_id,
      b.break_number,
      b.start_offset_sec,
      b.end_offset_sec,
      b.played_at_start,
      b.played_at_end
    FROM comskip_ground_truth_breaks b
    JOIN comskip_ground_truth_recordings r ON r.recording_id = b.recording_id
    WHERE b.played_at_end > $1
      AND b.played_at_start < $2
      AND ($3::int IS NULL OR r.channel = $3)
    ORDER BY r.channel, b.played_at_start, b.break_number
  `, [
    new Date(windowStartMs).toISOString(),
    new Date(windowEndMs).toISOString(),
    channelValue,
  ])

  return result.rows.map((row) => buildTruthInterval(row as Record<string, unknown>))
}

function buildModelIntervalFromSqlRow(row: Record<string, unknown>): ModelInterval {
  return {
    startMs: new Date(String(row.started_at)).getTime(),
    endMs: new Date(String(row.ended_at)).getTime(),
    sourceId: String(row.id),
    label: 'model',
    metadata: {
      channel: String(row.channel),
      isTest: Boolean(row.is_test),
      userName: typeof row.user_name === 'string' ? row.user_name : null,
      rawId: String(row.id),
      source: typeof row.source === 'string' ? row.source : 'sql',
    },
  }
}

async function fetchModelIntervalsFromSql(channel: string, windowStartMs: number, windowEndMs: number): Promise<ModelInterval[]> {
  const pool = await getPool()
  const channelValue = channel === 'all' ? null : Number.parseInt(channel, 10)
  const result = await pool.query<Record<string, unknown>>(`
    SELECT id, channel, started_at, ended_at, is_test, user_name, source
    FROM model_detection_events
    WHERE ended_at > $1
      AND started_at < $2
      AND ($3::int IS NULL OR channel = $3)
      AND COALESCE(is_test, false) = false
    ORDER BY channel, started_at
  `, [
    new Date(windowStartMs).toISOString(),
    new Date(windowEndMs).toISOString(),
    channelValue,
  ])

  return result.rows.map((row) => buildModelIntervalFromSqlRow(row as Record<string, unknown>))
}

function buildModelIntervalFromDynamoItem(
  item: Record<string, unknown>,
  timeZone: string,
): ModelInterval | null {
  const start = parseTimestampInTimeZone(typeof item.startTime === 'string' ? item.startTime : null, timeZone)
  const stop = parseTimestampInTimeZone(typeof item.stopTime === 'string' ? item.stopTime : null, timeZone)
  const durationRaw = item.duration
  const durationSec = typeof durationRaw === 'number' ? durationRaw : Number.parseFloat(String(durationRaw ?? ''))

  let startMs = start?.getTime() ?? null
  let endMs = stop?.getTime() ?? null

  if (startMs === null && endMs !== null && Number.isFinite(durationSec)) {
    startMs = endMs - durationSec * 1000
  }
  if (endMs === null && startMs !== null && Number.isFinite(durationSec)) {
    endMs = startMs + durationSec * 1000
  }

  if (startMs === null || endMs === null || endMs <= startMs) {
    return null
  }

  return {
    startMs,
    endMs,
    sourceId: String(item.id ?? `${startMs}-${endMs}`),
    label: 'model',
    metadata: {
      channel: String(item.channel ?? ''),
      isTest: Boolean(item.is_test),
      userName: typeof item.userName === 'string' ? item.userName : null,
      rawId: typeof item.id === 'string' ? item.id : undefined,
      source: 'dynamodb',
    },
  }
}

async function fetchModelIntervalsFromDynamo(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  channel: string
  windowStartMs: number
  windowEndMs: number
  timeZone: string
}): Promise<ModelInterval[]> {
  const { docClient, dataLabelsTable, channel, windowStartMs, windowEndMs, timeZone } = params
  const items: Record<string, unknown>[] = []
  let lastEvaluatedKey: Record<string, unknown> | undefined

  do {
    const command = new ScanCommand({
      TableName: dataLabelsTable,
      ProjectionExpression: '#id, #channel, #startTime, #stopTime, #duration, #isTest, #userName',
      ExpressionAttributeNames: {
        '#id': 'id',
        '#channel': 'channel',
        '#startTime': 'startTime',
        '#stopTime': 'stopTime',
        '#duration': 'duration',
        '#isTest': 'is_test',
        '#userName': 'userName',
      },
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 1000,
      ...(channel !== 'all'
        ? {
            FilterExpression: '#channel = :channel',
            ExpressionAttributeValues: { ':channel': channel },
          }
        : undefined),
    })
    const result = await docClient.send(command)
    if (result.Items) {
      items.push(...(result.Items as Record<string, unknown>[]))
    }
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  return items
    .map((item) => buildModelIntervalFromDynamoItem(item, timeZone))
    .filter((interval): interval is ModelInterval => interval !== null)
    .filter((interval) => interval.metadata.isTest !== true)
    .filter((interval) => interval.endMs > windowStartMs && interval.startMs < windowEndMs)
}

async function fetchLatestModelDetectionAt(channel: string): Promise<number | null> {
  if (!(await tableExists('model_detection_events'))) {
    return null
  }

  const pool = await getPool()
  const channelValue = channel === 'all' ? null : Number.parseInt(channel, 10)
  const result = await pool.query<{ latest_model_interval_at: string | null }>(`
    SELECT MAX(ended_at) AS latest_model_interval_at
    FROM model_detection_events
    WHERE ($1::int IS NULL OR channel = $1)
      AND COALESCE(is_test, false) = false
  `, [channelValue])

  const rawValue = result.rows[0]?.latest_model_interval_at
  return rawValue ? new Date(rawValue).getTime() : null
}

function aggregateRowsToMetrics(rows: AggregateMetricRow[], windowStartMs: number, windowEndMs: number): PerformanceMetrics {
  if (rows.length === 0) {
    return emptyPerformanceMetrics(windowStartMs, windowEndMs)
  }

  const groundTruthSeconds = rows.reduce((total, row) => total + row.metrics.groundTruthSeconds, 0)
  const modelSeconds = rows.reduce((total, row) => total + row.metrics.modelSeconds, 0)
  const overlapSeconds = rows.reduce((total, row) => total + row.metrics.overlapSeconds, 0)
  const matchedGroundTruthBreaks = rows.reduce((total, row) => total + row.metrics.matchedGroundTruthBreaks, 0)
  const totalGroundTruthBreaks = rows.reduce((total, row) => total + row.metrics.totalGroundTruthBreaks, 0)
  const totalModelIntervals = rows.reduce((total, row) => total + row.metrics.totalModelIntervals, 0)
  const matchedModelIntervals = rows.reduce((total, row) => total + row.metrics.matchedModelIntervals, 0)
  const totalGroundTruthRecordings = rows.reduce((total, row) => total + row.metrics.totalGroundTruthRecordings, 0)
  const latencySampleCount = rows.reduce((total, row) => total + row.latencySampleCount, 0)
  const overCaptureTailSampleCount = rows.reduce((total, row) => total + row.overCaptureTailSampleCount, 0)
  const startLatencySumSec = rows.reduce((total, row) => total + row.startLatencySumSec, 0)
  const overCaptureTailSumSec = rows.reduce((total, row) => total + row.overCaptureTailSumSec, 0)

  return {
    windowStartMs,
    windowEndMs,
    groundTruthSeconds,
    modelSeconds,
    overlapSeconds,
    recallBySeconds: groundTruthSeconds > 0 ? overlapSeconds / groundTruthSeconds : 0,
    precisionBySeconds: modelSeconds > 0 ? overlapSeconds / modelSeconds : 0,
    breakHitRate: totalGroundTruthBreaks > 0 ? matchedGroundTruthBreaks / totalGroundTruthBreaks : 0,
    missedSeconds: Math.max(0, groundTruthSeconds - overlapSeconds),
    falsePositiveSeconds: Math.max(0, modelSeconds - overlapSeconds),
    averageStartLatencySec: latencySampleCount > 0 ? startLatencySumSec / latencySampleCount : null,
    p95StartLatencySec:
      rows.length > 0
        ? rows.reduce((total, row) => total + (row.metrics.p95StartLatencySec ?? 0), 0) / rows.length
        : null,
    averageOverCaptureTailSec:
      overCaptureTailSampleCount > 0 ? overCaptureTailSumSec / overCaptureTailSampleCount : null,
    totalGroundTruthBreaks,
    matchedGroundTruthBreaks,
    totalModelIntervals,
    matchedModelIntervals,
    totalGroundTruthRecordings,
    latestTruthBreakAtMs: rows.reduce(
      (latest, row) => Math.max(latest, row.metrics.latestTruthBreakAtMs ?? 0),
      0,
    ) || null,
    latestModelIntervalAtMs: rows.reduce(
      (latest, row) => Math.max(latest, row.metrics.latestModelIntervalAtMs ?? 0),
      0,
    ) || null,
  }
}

function mapAggregateRow(row: Record<string, unknown>): AggregateMetricRow {
  const matchedGroundTruthBreaks = Number(row.matched_ground_truth_breaks ?? 0)
  const latencySampleCount = Number(row.latency_sample_count ?? matchedGroundTruthBreaks)
  const overCaptureTailSampleCount = Number(row.over_capture_tail_sample_count ?? matchedGroundTruthBreaks)

  return {
    channel: String(row.channel),
    bucketStartMs: new Date(String(row.bucket_start)).getTime(),
    bucketEndMs: new Date(String(row.bucket_end)).getTime(),
    metrics: {
      windowStartMs: new Date(String(row.bucket_start)).getTime(),
      windowEndMs: new Date(String(row.bucket_end)).getTime(),
      groundTruthSeconds: Number(row.ground_truth_seconds ?? 0),
      modelSeconds: Number(row.model_seconds ?? 0),
      overlapSeconds: Number(row.overlap_seconds ?? 0),
      recallBySeconds:
        row.recall_by_seconds !== undefined
          ? Number(row.recall_by_seconds)
          : Number(row.ground_truth_seconds ?? 0) > 0
            ? Number(row.overlap_seconds ?? 0) / Number(row.ground_truth_seconds)
            : 0,
      precisionBySeconds:
        row.precision_by_seconds !== undefined
          ? Number(row.precision_by_seconds)
          : Number(row.model_seconds ?? 0) > 0
            ? Number(row.overlap_seconds ?? 0) / Number(row.model_seconds)
            : 0,
      breakHitRate:
        row.break_hit_rate !== undefined
          ? Number(row.break_hit_rate)
          : Number(row.total_ground_truth_breaks ?? 0) > 0
            ? Number(row.matched_ground_truth_breaks ?? 0) / Number(row.total_ground_truth_breaks)
            : 0,
      missedSeconds: Number(row.missed_seconds ?? 0),
      falsePositiveSeconds: Number(row.false_positive_seconds ?? 0),
      averageStartLatencySec:
        row.average_start_latency_sec === null || row.average_start_latency_sec === undefined
          ? null
          : Number(row.average_start_latency_sec),
      p95StartLatencySec:
        row.p95_start_latency_sec === null || row.p95_start_latency_sec === undefined
          ? null
          : Number(row.p95_start_latency_sec),
      averageOverCaptureTailSec:
        row.average_over_capture_tail_sec === null || row.average_over_capture_tail_sec === undefined
          ? null
          : Number(row.average_over_capture_tail_sec),
      totalGroundTruthBreaks: Number(row.total_ground_truth_breaks ?? 0),
      matchedGroundTruthBreaks,
      totalModelIntervals: Number(row.total_model_intervals ?? 0),
      matchedModelIntervals: Number(row.matched_model_intervals ?? 0),
      totalGroundTruthRecordings: Number(row.total_ground_truth_recordings ?? 0),
      latestTruthBreakAtMs: row.latest_truth_break_at ? new Date(String(row.latest_truth_break_at)).getTime() : null,
      latestModelIntervalAtMs: row.latest_model_interval_at ? new Date(String(row.latest_model_interval_at)).getTime() : null,
    },
    latencySampleCount,
    startLatencySumSec:
      row.start_latency_sum_sec !== undefined && row.start_latency_sum_sec !== null
        ? Number(row.start_latency_sum_sec)
        : Number(row.average_start_latency_sec ?? 0) * latencySampleCount,
    overCaptureTailSampleCount,
    overCaptureTailSumSec:
      row.over_capture_tail_sum_sec !== undefined && row.over_capture_tail_sum_sec !== null
        ? Number(row.over_capture_tail_sum_sec)
        : Number(row.average_over_capture_tail_sec ?? 0) * overCaptureTailSampleCount,
  }
}

async function fetchAggregateMetricRows(
  bucketKey: TrendBucketKey,
  rangeStartMs: number,
  rangeEndMs: number,
  channel: string,
): Promise<AggregateMetricRow[] | null> {
  const tableName = AGGREGATE_TABLES[bucketKey]
  if (!(await tableExists(tableName))) {
    return null
  }

  const pool = await getPool()
  const channelValue = channel === 'all' ? null : Number.parseInt(channel, 10)
  const result = await pool.query<Record<string, unknown>>(`
    SELECT
      channel::text AS channel,
      bucket_start,
      bucket_end,
      ground_truth_seconds,
      model_seconds,
      overlap_seconds,
      recall_by_seconds,
      precision_by_seconds,
      break_hit_rate,
      missed_seconds,
      false_positive_seconds,
      average_start_latency_sec,
      p95_start_latency_sec,
      average_over_capture_tail_sec,
      total_ground_truth_breaks,
      matched_ground_truth_breaks,
      total_model_intervals,
      matched_model_intervals,
      total_ground_truth_recordings,
      latest_truth_break_at,
      latest_model_interval_at,
      latency_sample_count,
      start_latency_sum_sec,
      over_capture_tail_sample_count,
      over_capture_tail_sum_sec
    FROM ${tableName}
    WHERE bucket_start >= $1
      AND bucket_start < $2
      AND ($3::int IS NULL OR channel = $3)
    ORDER BY bucket_start, channel
  `, [
    new Date(rangeStartMs).toISOString(),
    new Date(rangeEndMs).toISOString(),
    channelValue,
  ])

  return result.rows.map((row) => mapAggregateRow(row as Record<string, unknown>))
}

async function loadModelIntervals(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  channel: string
  windowStartMs: number
  windowEndMs: number
  timeZone: string
}): Promise<ModelInterval[]> {
  if (await tableExists('model_detection_events')) {
    return fetchModelIntervalsFromSql(params.channel, params.windowStartMs, params.windowEndMs)
  }

  if (!parseBoolean(process.env.MODEL_PERFORMANCE_ALLOW_DYNAMO_FALLBACK, true)) {
    throw new Error('model_detection_events table is missing and DynamoDB fallback is disabled.')
  }

  return fetchModelIntervalsFromDynamo(params)
}

function createWindowData(
  truthIntervals: TruthInterval[],
  modelIntervals: ModelInterval[],
  windowStartMs: number,
  windowEndMs: number,
): WindowData {
  const breakComparisons = buildBreakComparisons(truthIntervals, modelIntervals)
  const metrics = computePerformanceMetrics(
    truthIntervals,
    modelIntervals,
    breakComparisons,
    windowStartMs,
    windowEndMs,
  )

  return {
    truthIntervals,
    modelIntervals,
    breakComparisons,
    metrics,
  }
}

async function loadWindowData(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  channel: string
  windowStartMs: number
  windowEndMs: number
  timeZone: string
}): Promise<WindowData> {
  const cacheKey = `model-performance:window:${params.channel}:${params.windowStartMs}:${params.windowEndMs}:${params.timeZone}`
  const cached = getCached<WindowData>(cacheKey)
  if (cached) {
    return cached
  }

  const [truthIntervals, modelIntervals] = await Promise.all([
    fetchTruthIntervals(params.channel, params.windowStartMs, params.windowEndMs),
    loadModelIntervals(params),
  ])

  const windowData = createWindowData(
    truthIntervals,
    modelIntervals,
    params.windowStartMs,
    params.windowEndMs,
  )
  setCached(cacheKey, windowData)
  return windowData
}

function mapAggregateRowsToTrendPoints(
  rows: AggregateMetricRow[],
  bucketKey: TrendBucketKey,
  timeZone: string,
  combineAcrossChannels: boolean,
): TrendPoint[] {
  const grouped = new Map<number, AggregateMetricRow[]>()
  if (combineAcrossChannels) {
    for (const row of rows) {
      const list = grouped.get(row.bucketStartMs) ?? []
      list.push(row)
      grouped.set(row.bucketStartMs, list)
    }
  } else {
    for (const row of rows) {
      grouped.set(row.bucketStartMs, [row])
    }
  }

  return Array.from(grouped.values())
    .map((bucketRows) => {
      const metrics =
        bucketRows.length === 1 && !combineAcrossChannels
          ? bucketRows[0].metrics
          : aggregateRowsToMetrics(bucketRows, bucketRows[0].bucketStartMs, bucketRows[0].bucketEndMs)

      return {
        ...metrics,
        bucketKey,
        bucketStart: toIsoString(bucketRows[0].bucketStartMs),
        bucketEnd: toIsoString(bucketRows[0].bucketEndMs),
        label: bucketKey === '1d'
          ? new Intl.DateTimeFormat('en-AU', { timeZone, year: 'numeric', month: 'short', day: 'numeric' }).format(
              new Date(bucketRows[0].bucketStartMs),
            )
          : new Intl.DateTimeFormat('en-AU', { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
              new Date(bucketRows[0].bucketStartMs),
            ),
        warnings: [],
      }
    })
    .sort((left, right) => new Date(left.bucketStart).getTime() - new Date(right.bucketStart).getTime())
}

function getRangeBounds(
  rangeKey: TrendRangeKey,
  request: Request,
  timeZone: string,
): { rangeStartMs: number; rangeEndMs: number } {
  const now = Date.now()
  if (rangeKey === 'custom') {
    const startParam = typeof request.query.start === 'string' ? request.query.start : null
    const endParam = typeof request.query.end === 'string' ? request.query.end : null
    if (!startParam || !endParam) {
      throw new Error('Custom range requires both start and end query parameters.')
    }

    const start = parseTimestampInTimeZone(startParam, timeZone)
    const end = /^\d{4}-\d{2}-\d{2}$/.test(endParam)
      ? dayWindow(endParam, timeZone).end
      : parseTimestampInTimeZone(endParam, timeZone)
    if (!start || !end) {
      throw new Error('Invalid custom range.')
    }

    return {
      rangeStartMs: start.getTime(),
      rangeEndMs: end.getTime(),
    }
  }

  const range = {
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    custom: 0,
  }[rangeKey]

  return {
    rangeStartMs: now - range,
    rangeEndMs: now,
  }
}

function getExplicitRangeBounds(
  startParam: string,
  endParam: string,
  timeZone: string,
): { rangeStartMs: number; rangeEndMs: number } {
  const start = parseTimestampInTimeZone(startParam, timeZone)
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endParam)
    ? dayWindow(endParam, timeZone).end
    : parseTimestampInTimeZone(endParam, timeZone)

  if (!start || !end) {
    throw new Error('Invalid detail range.')
  }

  if (end.getTime() <= start.getTime()) {
    throw new Error('Detail range end must be after the start.')
  }

  return {
    rangeStartMs: start.getTime(),
    rangeEndMs: end.getTime(),
  }
}

async function fetchRecordingInspectionScope(
  lookupValue: string,
  windowSeconds: number,
): Promise<RecordingInspectionScope> {
  const normalizedRecordingName = normalizeRecordingLookupValue(lookupValue)
  if (!normalizedRecordingName) {
    throw new Error('Recording name or WAV path is required.')
  }

  const pool = await getPool()
  const recordingResult = await pool.query<Record<string, unknown>>(`
    SELECT
      recording_id,
      recording_name,
      channel,
      recording_started_at,
      audio_path
    FROM comskip_ground_truth_recordings
    WHERE recording_name = $1
    LIMIT 1
  `, [normalizedRecordingName])

  const recordingRow = recordingResult.rows[0]
  if (!recordingRow) {
    throw new Error(`No comskip ground truth recording found for ${normalizedRecordingName}.`)
  }

  const recordingStartedAt = new Date(String(recordingRow.recording_started_at))
  const windowStartMs = recordingStartedAt.getTime()
  const windowEndMs = windowStartMs + windowSeconds * 1000
  const recordingId = Number(recordingRow.recording_id)

  const breaksResult = await pool.query<Record<string, unknown>>(`
    SELECT
      r.recording_id,
      r.recording_name,
      r.channel,
      r.audio_path,
      r.recording_started_at,
      b.break_id,
      b.break_number,
      b.start_offset_sec,
      b.end_offset_sec,
      b.played_at_start,
      b.played_at_end
    FROM comskip_ground_truth_breaks b
    JOIN comskip_ground_truth_recordings r ON r.recording_id = b.recording_id
    WHERE r.recording_id = $1
      AND b.played_at_end > $2
      AND b.played_at_start < $3
    ORDER BY b.break_number
  `, [
    recordingId,
    new Date(windowStartMs).toISOString(),
    new Date(windowEndMs).toISOString(),
  ])

  const truthIntervals = breaksResult.rows
    .map((row) => buildTruthInterval(row as Record<string, unknown>))
    .map((interval) => clipInterval(interval, windowStartMs, windowEndMs))
    .filter((interval): interval is TruthInterval => interval !== null)

  return {
    channel: String(recordingRow.channel),
    normalizedRecordingName: String(recordingRow.recording_name),
    lookupValue,
    audioPath: typeof recordingRow.audio_path === 'string' ? recordingRow.audio_path : null,
    recordingStartedAt: new Date(String(recordingRow.recording_started_at)).toISOString(),
    windowStartMs,
    windowEndMs,
    truthIntervals,
  }
}

function filterMeaningfulBaselineSamples(points: TrendPoint[]): PerformanceMetrics[] {
  return points
    .filter((point) => point.totalGroundTruthBreaks > 0 || point.totalModelIntervals > 0)
    .map((point) => ({
      ...point,
      windowStartMs: new Date(point.bucketStart).getTime(),
      windowEndMs: new Date(point.bucketEnd).getTime(),
    }))
}

async function getBaselineSamples(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  channel: string
  windowKey: ShortTermWindowKey
  baselineRange: '7d' | '30d'
  timeZone: string
  currentWindowStartMs: number
}): Promise<PerformanceMetrics[]> {
  const windowDurationMs = SHORT_TERM_WINDOWS.find((window) => window.key === params.windowKey)?.durationMs ?? 0
  const rangeDurationMs = params.baselineRange === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
  const rangeStartMs = params.currentWindowStartMs - rangeDurationMs
  const rangeEndMs = params.currentWindowStartMs
  const bucketKey = WINDOW_TO_BUCKET[params.windowKey]
  const aggregateRows = await fetchAggregateMetricRows(bucketKey, rangeStartMs, rangeEndMs, params.channel)

  if (aggregateRows) {
    const points = mapAggregateRowsToTrendPoints(aggregateRows, bucketKey, params.timeZone, false)
    return filterMeaningfulBaselineSamples(points)
  }

  const rawWindow = await loadWindowData({
    docClient: params.docClient,
    dataLabelsTable: params.dataLabelsTable,
    channel: params.channel,
    windowStartMs: rangeStartMs,
    windowEndMs: rangeEndMs,
    timeZone: params.timeZone,
  })
  const points = buildTrendPoints({
    truthIntervals: rawWindow.truthIntervals,
    modelIntervals: rawWindow.modelIntervals,
    breakComparisons: rawWindow.breakComparisons,
    rangeStartMs,
    rangeEndMs,
    bucketKey,
    timeZone: params.timeZone,
  })

  return filterMeaningfulBaselineSamples(points).filter((sample) => sample.windowEndMs <= params.currentWindowStartMs - windowDurationMs + windowDurationMs)
}

async function getOverviewWindows(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  channel: string
  timeZone: string
}): Promise<{ windows: OverviewWindowSummary[]; activeAlerts: OverviewResponse['activeAlerts'] }> {
  const now = Date.now()
  const latestDetectionAtMs = await fetchLatestModelDetectionAt(params.channel)
  const latestDetectionAgeMs = latestDetectionAtMs === null ? null : Math.max(0, now - latestDetectionAtMs)
  const windows: OverviewWindowSummary[] = []

  for (const windowDefinition of SHORT_TERM_WINDOWS) {
    const currentWindowStartMs = now - windowDefinition.durationMs
    const currentWindow = await loadWindowData({
      docClient: params.docClient,
      dataLabelsTable: params.dataLabelsTable,
      channel: params.channel,
      windowStartMs: currentWindowStartMs,
      windowEndMs: now,
      timeZone: params.timeZone,
    })
    const [baseline7dSamples, baseline30dSamples] = await Promise.all([
      getBaselineSamples({
        docClient: params.docClient,
        dataLabelsTable: params.dataLabelsTable,
        channel: params.channel,
        windowKey: windowDefinition.key,
        baselineRange: '7d',
        timeZone: params.timeZone,
        currentWindowStartMs,
      }),
      getBaselineSamples({
        docClient: params.docClient,
        dataLabelsTable: params.dataLabelsTable,
        channel: params.channel,
        windowKey: windowDefinition.key,
        baselineRange: '30d',
        timeZone: params.timeZone,
        currentWindowStartMs,
      }),
    ])

    windows.push(
      summarizeWindowComparisons({
        current: currentWindow.metrics,
        baseline7dSamples,
        baseline30dSamples,
        windowKey: windowDefinition.key,
        latestDetectionAgeMs,
      }),
    )
  }

  const alertMap = new Map<string, OverviewResponse['activeAlerts'][number]>()
  for (const window of windows) {
    for (const warning of window.warnings) {
      alertMap.set(`${window.windowKey}:${warning.code}`, warning)
    }
  }

  return {
    windows,
    activeAlerts: Array.from(alertMap.values()).sort((left, right) => left.severity.localeCompare(right.severity)),
  }
}

async function getTrendPoints(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  channel: string
  rangeStartMs: number
  rangeEndMs: number
  bucketKey: TrendBucketKey
  timeZone: string
}): Promise<TrendPoint[]> {
  const cacheKey = `model-performance:trends:${params.channel}:${params.rangeStartMs}:${params.rangeEndMs}:${params.bucketKey}:${params.timeZone}`
  const cached = getCached<TrendPoint[]>(cacheKey)
  if (cached) {
    return cached
  }

  const aggregateRows = await fetchAggregateMetricRows(params.bucketKey, params.rangeStartMs, params.rangeEndMs, params.channel)
  const points = aggregateRows
    ? mapAggregateRowsToTrendPoints(aggregateRows, params.bucketKey, params.timeZone, params.channel === 'all')
    : buildTrendPoints({
        ...(await loadWindowData({
          docClient: params.docClient,
          dataLabelsTable: params.dataLabelsTable,
          channel: params.channel,
          windowStartMs: params.rangeStartMs,
          windowEndMs: params.rangeEndMs,
          timeZone: params.timeZone,
        })),
        rangeStartMs: params.rangeStartMs,
        rangeEndMs: params.rangeEndMs,
        bucketKey: params.bucketKey,
        timeZone: params.timeZone,
      })

  setCached(cacheKey, points)
  return points
}

async function getChannelBreakdown(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  shortTermWindowKey: ShortTermWindowKey
  timeZone: string
}): Promise<ChannelBreakdownResponse> {
  const channels = await fetchAvailableChannels()
  const now = Date.now()
  const shortWindowDurationMs = SHORT_TERM_WINDOWS.find((window) => window.key === params.shortTermWindowKey)?.durationMs ?? 60 * 60 * 1000
  const currentWindowStartMs = now - shortWindowDurationMs

  const currentWindow = await loadWindowData({
    docClient: params.docClient,
    dataLabelsTable: params.dataLabelsTable,
    channel: 'all',
    windowStartMs: currentWindowStartMs,
    windowEndMs: now,
    timeZone: params.timeZone,
  })

  const truthByChannel = new Map<string, TruthInterval[]>()
  const modelByChannel = new Map<string, ModelInterval[]>()
  for (const truthInterval of currentWindow.truthIntervals) {
    const list = truthByChannel.get(String(truthInterval.metadata.channel)) ?? []
    list.push(truthInterval)
    truthByChannel.set(String(truthInterval.metadata.channel), list)
  }
  for (const modelInterval of currentWindow.modelIntervals) {
    const list = modelByChannel.get(String(modelInterval.metadata.channel)) ?? []
    list.push(modelInterval)
    modelByChannel.set(String(modelInterval.metadata.channel), list)
  }

  const sparklineRows = await fetchAggregateMetricRows('1h', now - 24 * 60 * 60 * 1000, now, 'all')
  const sparklineByChannel = new Map<string, AggregateMetricRow[]>()
  if (sparklineRows) {
    for (const row of sparklineRows) {
      const list = sparklineByChannel.get(row.channel) ?? []
      list.push(row)
      sparklineByChannel.set(row.channel, list)
    }
  }

  const baseline7Rows = await fetchAggregateMetricRows(
    WINDOW_TO_BUCKET[params.shortTermWindowKey],
    currentWindowStartMs - 7 * 24 * 60 * 60 * 1000,
    currentWindowStartMs,
    'all',
  )
  const baseline30Rows = await fetchAggregateMetricRows(
    WINDOW_TO_BUCKET[params.shortTermWindowKey],
    currentWindowStartMs - 30 * 24 * 60 * 60 * 1000,
    currentWindowStartMs,
    'all',
  )

  const baseline7ByChannel = new Map<string, PerformanceMetrics[]>()
  const baseline30ByChannel = new Map<string, PerformanceMetrics[]>()

  for (const row of baseline7Rows ?? []) {
    const list = baseline7ByChannel.get(row.channel) ?? []
    list.push(row.metrics)
    baseline7ByChannel.set(row.channel, list)
  }
  for (const row of baseline30Rows ?? []) {
    const list = baseline30ByChannel.get(row.channel) ?? []
    list.push(row.metrics)
    baseline30ByChannel.set(row.channel, list)
  }

  const rows: ChannelBreakdownRow[] = channels.map((channel) => {
    const truthIntervals = truthByChannel.get(channel) ?? []
    const modelIntervals = modelByChannel.get(channel) ?? []
    const breakComparisons = buildBreakComparisons(truthIntervals, modelIntervals)
    const shortTerm = computePerformanceMetrics(
      truthIntervals,
      modelIntervals,
      breakComparisons,
      currentWindowStartMs,
      now,
    )
    const baseline7d = createBaselineSummary('7d', baseline7ByChannel.get(channel) ?? [])
    const baseline30d = createBaselineSummary('30d', baseline30ByChannel.get(channel) ?? [])
    const latestDetectionAgeMs =
      shortTerm.latestModelIntervalAtMs === null ? null : Math.max(0, now - shortTerm.latestModelIntervalAtMs)
    const warnings = summarizeWindowComparisons({
      current: shortTerm,
      baseline7dSamples: baseline7ByChannel.get(channel) ?? [],
      baseline30dSamples: baseline30ByChannel.get(channel) ?? [],
      windowKey: params.shortTermWindowKey,
      latestDetectionAgeMs,
    }).warnings

    return {
      channel,
      shortTermWindowKey: params.shortTermWindowKey,
      shortTerm,
      baseline7d,
      baseline30d,
      deltaVs30dRecall:
        baseline30d.metrics.recallBySeconds.average === null
          ? null
          : shortTerm.recallBySeconds - baseline30d.metrics.recallBySeconds.average,
      deltaVs30dPrecision:
        baseline30d.metrics.precisionBySeconds.average === null
          ? null
          : shortTerm.precisionBySeconds - baseline30d.metrics.precisionBySeconds.average,
      warnings,
      sparkline: (sparklineByChannel.get(channel) ?? [])
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
        .map((row) => ({
          bucketStart: toIsoString(row.bucketStartMs),
          recallBySeconds: row.metrics.recallBySeconds,
          precisionBySeconds: row.metrics.precisionBySeconds,
          breakHitRate: row.metrics.breakHitRate,
        })),
    }
  })

  rows.sort((left, right) => {
    const severityWeight = (row: ChannelBreakdownRow) =>
      row.warnings.some((warning) => warning.severity === 'critical')
        ? 3
        : row.warnings.some((warning) => warning.severity === 'warning')
          ? 2
          : row.warnings.length > 0
            ? 1
            : 0
    return severityWeight(right) - severityWeight(left) || left.channel.localeCompare(right.channel)
  })

  return {
    generatedAt: new Date().toISOString(),
    timezone: params.timeZone,
    shortTermWindowKey: params.shortTermWindowKey,
    channels: rows,
  }
}

async function getPerformanceDetail(params: {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  channel: string
  scopeType: DetailScopeType
  day?: string
  start?: string
  end?: string
  recording?: string
  windowSeconds?: number
  timeZone: string
}): Promise<ChannelDetailResponse> {
  let resolvedChannel = params.channel
  let windowStartMs = 0
  let windowEndMs = 0
  let windowData: WindowData
  let scope: ChannelDetailResponse['scope']

  if (params.scopeType === 'recording') {
    const windowSeconds = params.windowSeconds ?? 30 * 60
    const recordingScope = await fetchRecordingInspectionScope(params.recording ?? '', windowSeconds)
    resolvedChannel = recordingScope.channel
    windowStartMs = recordingScope.windowStartMs
    windowEndMs = recordingScope.windowEndMs
    const modelIntervals = await loadModelIntervals({
      docClient: params.docClient,
      dataLabelsTable: params.dataLabelsTable,
      channel: resolvedChannel,
      windowStartMs,
      windowEndMs,
      timeZone: params.timeZone,
    })
    windowData = createWindowData(recordingScope.truthIntervals, modelIntervals, windowStartMs, windowEndMs)
    scope = {
      type: 'recording',
      label: recordingScope.normalizedRecordingName,
      windowStart: toIsoString(windowStartMs),
      windowEnd: toIsoString(windowEndMs),
      recordingName: recordingScope.normalizedRecordingName,
      lookupValue: recordingScope.lookupValue,
      audioPath: recordingScope.audioPath,
      recordingStartedAt: recordingScope.recordingStartedAt,
      windowSeconds,
    }
  } else if (params.scopeType === 'range') {
    if (!params.start || !params.end) {
      throw new Error('Range detail requires both start and end.')
    }
    const bounds = getExplicitRangeBounds(params.start, params.end, params.timeZone)
    windowStartMs = bounds.rangeStartMs
    windowEndMs = bounds.rangeEndMs
    windowData = await loadWindowData({
      docClient: params.docClient,
      dataLabelsTable: params.dataLabelsTable,
      channel: resolvedChannel,
      windowStartMs,
      windowEndMs,
      timeZone: params.timeZone,
    })
    scope = {
      type: 'range',
      label: `${params.start} to ${params.end}`,
      windowStart: toIsoString(windowStartMs),
      windowEnd: toIsoString(windowEndMs),
      start: params.start,
      end: params.end,
    }
  } else {
    const day = params.day ?? new Date().toISOString().slice(0, 10)
    const { start, end } = dayWindow(day, params.timeZone)
    windowStartMs = start.getTime()
    windowEndMs = end.getTime()
    windowData = await loadWindowData({
      docClient: params.docClient,
      dataLabelsTable: params.dataLabelsTable,
      channel: resolvedChannel,
      windowStartMs,
      windowEndMs,
      timeZone: params.timeZone,
    })
    scope = {
      type: 'day',
      label: day,
      windowStart: toIsoString(windowStartMs),
      windowEnd: toIsoString(windowEndMs),
      day,
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: params.timeZone,
    channel: resolvedChannel,
    scope,
    summary: windowData.metrics,
    groundTruthIntervals: windowData.truthIntervals,
    modelIntervals: windowData.modelIntervals,
    breakComparisons: windowData.breakComparisons,
    hourOfDay: buildHourOfDayBreakdown(windowData.breakComparisons, params.timeZone),
    durationBuckets: buildDurationBreakdown(windowData.breakComparisons),
    recordings: buildRecordingBreakdown(windowData.truthIntervals, windowData.breakComparisons),
  }
}

function sendError(response: Response, error: unknown, fallbackMessage: string): void {
  const message = error instanceof Error ? error.message : fallbackMessage
  console.error(fallbackMessage, error)
  response.status(500).json({
    error: message,
  })
}

export function registerModelPerformanceRoutes(options: RegisterModelPerformanceRoutesOptions): void {
  const { app, docClient, dataLabelsTable } = options

  app.get('/api/model-performance/filters', async (request, response) => {
    try {
      const timezone = getTimeZone(request)
      response.json({
        timezone,
        channels: await fetchAvailableChannels(),
      })
    } catch (error) {
      sendError(response, error, 'Failed to fetch model performance filters.')
    }
  })

  app.get('/api/model-performance/overview', async (request, response) => {
    try {
      const channel = normalizeChannelValue(request.query.channel)
      const timezone = getTimeZone(request)
      const cacheKey = `model-performance:overview:${channel}:${timezone}`
      const cached = getCached<OverviewResponse>(cacheKey)
      if (cached && request.query.refresh !== 'true') {
        return response.json(cached)
      }

      const { windows, activeAlerts } = await getOverviewWindows({
        docClient,
        dataLabelsTable,
        channel,
        timeZone: timezone,
      })

      const payload: OverviewResponse = {
        generatedAt: new Date().toISOString(),
        timezone,
        selectedChannel: channel,
        activeAlerts,
        windows,
      }
      setCached(cacheKey, payload)
      response.json(payload)
    } catch (error) {
      sendError(response, error, 'Failed to load model performance overview.')
    }
  })

  app.get('/api/model-performance/trends', async (request, response) => {
    try {
      const channel = normalizeChannelValue(request.query.channel)
      const timezone = getTimeZone(request)
      const rangeKey = (typeof request.query.range === 'string' ? request.query.range : '30d') as TrendRangeKey
      const bucketKey = (typeof request.query.bucket === 'string' ? request.query.bucket : '1h') as TrendBucketKey
      const { rangeStartMs, rangeEndMs } = getRangeBounds(rangeKey, request, timezone)
      const points = await getTrendPoints({
        docClient,
        dataLabelsTable,
        channel,
        rangeStartMs,
        rangeEndMs,
        bucketKey,
        timeZone: timezone,
      })

      const payload: TrendsResponse = {
        generatedAt: new Date().toISOString(),
        timezone,
        selectedChannel: channel,
        rangeKey,
        bucketKey,
        rangeStart: toIsoString(rangeStartMs),
        rangeEnd: toIsoString(rangeEndMs),
        points,
      }
      response.json(payload)
    } catch (error) {
      sendError(response, error, 'Failed to load model performance trends.')
    }
  })

  app.get('/api/model-performance/channels', async (request, response) => {
    try {
      const timezone = getTimeZone(request)
      const shortTermWindowKey = (
        typeof request.query.shortWindow === 'string' ? request.query.shortWindow : '1h'
      ) as ShortTermWindowKey
      const cacheKey = `model-performance:channels:${shortTermWindowKey}:${timezone}`
      const cached = getCached<ChannelBreakdownResponse>(cacheKey)
      if (cached && request.query.refresh !== 'true') {
        return response.json(cached)
      }

      const payload = await getChannelBreakdown({
        docClient,
        dataLabelsTable,
        shortTermWindowKey,
        timeZone: timezone,
      })

      setCached(cacheKey, payload)
      response.json(payload)
    } catch (error) {
      sendError(response, error, 'Failed to load channel breakdown.')
    }
  })

  app.get('/api/model-performance/detail', async (request, response) => {
    try {
      const timezone = getTimeZone(request)
      const scopeType = (
        typeof request.query.scope === 'string' ? request.query.scope : 'day'
      ) as DetailScopeType
      const channel = normalizeChannelValue(request.query.channel)
      const day = typeof request.query.day === 'string' ? request.query.day : undefined
      const start = typeof request.query.start === 'string' ? request.query.start : undefined
      const end = typeof request.query.end === 'string' ? request.query.end : undefined
      const recording =
        typeof request.query.recording === 'string'
          ? request.query.recording
          : typeof request.query.recordingName === 'string'
            ? request.query.recordingName
            : typeof request.query.wavFile === 'string'
              ? request.query.wavFile
              : undefined
      const windowSeconds =
        typeof request.query.windowSeconds === 'string'
          ? Number.parseInt(request.query.windowSeconds, 10)
          : undefined
      const cacheKey = `model-performance:detail:${scopeType}:${channel}:${day ?? ''}:${start ?? ''}:${end ?? ''}:${recording ?? ''}:${windowSeconds ?? ''}:${timezone}`
      const cached = getCached<ChannelDetailResponse>(cacheKey)
      if (cached && request.query.refresh !== 'true') {
        return response.json(cached)
      }

      const payload = await getPerformanceDetail({
        docClient,
        dataLabelsTable,
        channel,
        scopeType,
        day,
        start,
        end,
        recording,
        windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : undefined,
        timeZone: timezone,
      })
      setCached(cacheKey, payload)
      response.json(payload)
    } catch (error) {
      sendError(response, error, 'Failed to load model performance detail.')
    }
  })

  app.get('/api/model-performance/channels/:channel/day', async (request, response) => {
    try {
      const channel = normalizeChannelValue(request.params.channel)
      const timezone = getTimeZone(request)
      const day = typeof request.query.day === 'string' ? request.query.day : new Date().toISOString().slice(0, 10)
      const cacheKey = `model-performance:channel-detail:${channel}:${day}:${timezone}`
      const cached = getCached<ChannelDetailResponse>(cacheKey)
      if (cached && request.query.refresh !== 'true') {
        return response.json(cached)
      }

      const payload = await getPerformanceDetail({
        docClient,
        dataLabelsTable,
        channel,
        scopeType: 'day',
        day,
        timeZone: timezone,
      })
      setCached(cacheKey, payload)
      response.json(payload)
    } catch (error) {
      sendError(response, error, 'Failed to load channel detail.')
    }
  })
}
