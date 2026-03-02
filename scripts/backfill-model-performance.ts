import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { fromIni } from '@aws-sdk/credential-providers'
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector'
import { GoogleAuth } from 'google-auth-library'
import { Pool } from 'pg'
import {
  buildBreakComparisons,
  buildTrendPoints,
  computePerformanceMetrics,
  type BreakComparison,
  type ModelInterval,
  type TrendBucketKey,
  type TruthInterval,
} from '../shared/modelPerformance'
import {
  DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
  dayWindow,
  parseTimestampInTimeZone,
} from '../shared/timezone'
import { loadLocalEnv } from '../server/loadEnv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

loadLocalEnv(path.resolve(__dirname, '..'))

interface CliOptions {
  mode: 'sync' | 'aggregate' | 'all'
  start: string
  end: string
  channels: string[] | null
  timezone: string
  includeTest: boolean
}

interface NormalizedDetectionRow {
  id: string
  channel: number
  startedAt: string
  endedAt: string
  durationSec: number
  isTest: boolean
  userName: string | null
  source: string
  rawPayload: string
}

interface AggregateUpsertRow {
  bucketStart: string
  bucketEnd: string
  metrics: ReturnType<typeof computePerformanceMetrics>
  latencySampleCount: number
  startLatencySumSec: number
  overCaptureTailSampleCount: number
  overCaptureTailSumSec: number
}

const DATA_LABELS_TABLE = process.env.DATA_LABELS_TABLE || process.env.DYNAMODB_DATA_LABELS_TABLE || 'data_labels'

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args.set(key, 'true')
    } else {
      args.set(key, next)
      index += 1
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const mode = (args.get('mode') || 'all') as CliOptions['mode']

  return {
    mode,
    start: args.get('start') || today,
    end: args.get('end') || args.get('start') || today,
    channels: args.get('channels') ? args.get('channels')!.split(',').map((value) => value.trim()).filter(Boolean) : null,
    timezone: args.get('timezone') || DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
    includeTest: args.get('include-test') === 'true',
  }
}

function parseBoolean(value: unknown, defaultValue: boolean = false): boolean {
  if (typeof value !== 'string') {
    return defaultValue
  }
  return value === 'true' || value === '1'
}

function getCloudSqlAuth(): GoogleAuth | undefined {
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

async function createPool(): Promise<{ pool: Pool; connector: Connector | null }> {
  const connectionString = process.env.MODEL_PERFORMANCE_DATABASE_URL || process.env.DATABASE_URL
  const sslEnabled = parseBoolean(process.env.MODEL_PERFORMANCE_DB_SSL || process.env.PGSSLMODE)
  const instanceConnectionName =
    process.env.MODEL_PERFORMANCE_INSTANCE_CONNECTION_NAME || process.env.INSTANCE_CONNECTION_NAME

  if (instanceConnectionName) {
    const auth = getCloudSqlAuth()
    const connector = new Connector(auth ? { auth } : undefined)
    const clientOptions = await connector.getOptions({
      instanceConnectionName,
      ipType: (process.env.MODEL_PERFORMANCE_CLOUD_SQL_IP_TYPE || process.env.CLOUD_SQL_IP_TYPE || 'PUBLIC') as IpAddressTypes,
    })
    const pool = new Pool({
      ...clientOptions,
      user: process.env.MODEL_PERFORMANCE_DB_USER || process.env.DB_USER || process.env.PGUSER || 'postgres',
      password:
        process.env.MODEL_PERFORMANCE_DB_PASSWORD ||
        process.env.GOOGLE_SQL_PASS ||
        process.env.PGPASSWORD,
      database: process.env.MODEL_PERFORMANCE_DB_NAME || process.env.DB_NAME || process.env.PGDATABASE || 'fingerprints',
      max: Number.parseInt(process.env.MODEL_PERFORMANCE_DB_POOL_MAX || '5', 10),
    })
    return { pool, connector }
  }

  const pool = connectionString
    ? new Pool({
        connectionString,
        ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
      })
    : new Pool({
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

  return { pool, connector: null }
}

function createDynamoDocumentClient(): DynamoDBDocumentClient {
  const profileName = process.env.AWS_PROFILE || 'iotdevice'
  const region = process.env.MY_AWS_REGION || process.env.AWS_REGION || 'ap-southeast-2'
  const explicitAwsCredentials =
    process.env.MY_AWS_ACCESS_KEY_ID && process.env.MY_AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY,
          ...(process.env.MY_AWS_SESSION_TOKEN
            ? { sessionToken: process.env.MY_AWS_SESSION_TOKEN }
            : {}),
        }
      : undefined
  const shouldUseProfileCredentials =
    !explicitAwsCredentials &&
    !process.env.AWS_ACCESS_KEY_ID &&
    !process.env.AWS_SECRET_ACCESS_KEY

  const client = new DynamoDBClient({
    region,
    ...(shouldUseProfileCredentials
      ? { credentials: fromIni({ profile: profileName }) }
      : explicitAwsCredentials
        ? { credentials: explicitAwsCredentials }
        : {}),
  })

  return DynamoDBDocumentClient.from(client)
}

async function ensureSchema(pool: Pool): Promise<void> {
  const schemaPath = path.resolve(__dirname, '../sql_cloud/model_performance_schema.sql')
  await pool.query(fs.readFileSync(schemaPath, 'utf8'))
}

function buildTruthInterval(row: Record<string, unknown>): TruthInterval {
  return {
    startMs: new Date(String(row.played_at_start)).getTime(),
    endMs: new Date(String(row.played_at_end)).getTime(),
    sourceId: `${row.recording_name}#${row.break_number}`,
    label: 'truth',
    metadata: {
      channel: String(row.channel),
      recordingName: String(row.recording_name),
      breakNumber: Number(row.break_number),
      breakId: Number(row.break_id),
      recordingId: Number(row.recording_id),
      audioPath: typeof row.audio_path === 'string' ? row.audio_path : undefined,
      recordingStartedAt: typeof row.recording_started_at === 'string' ? row.recording_started_at : undefined,
      startOffsetSec: Number(row.start_offset_sec),
      endOffsetSec: Number(row.end_offset_sec),
    },
  }
}

function buildModelInterval(row: Record<string, unknown>): ModelInterval {
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

async function fetchTruthIntervals(pool: Pool, channel: string, startMs: number, endMs: number): Promise<TruthInterval[]> {
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
    WHERE r.channel = $1
      AND b.played_at_end > $2
      AND b.played_at_start < $3
    ORDER BY b.played_at_start, b.break_number
  `, [Number.parseInt(channel, 10), new Date(startMs).toISOString(), new Date(endMs).toISOString()])

  return result.rows.map((row) => buildTruthInterval(row))
}

async function fetchModelIntervals(pool: Pool, channel: string, startMs: number, endMs: number): Promise<ModelInterval[]> {
  const result = await pool.query<Record<string, unknown>>(`
    SELECT id, channel, started_at, ended_at, is_test, user_name, source
    FROM model_detection_events
    WHERE channel = $1
      AND ended_at > $2
      AND started_at < $3
      AND COALESCE(is_test, false) = false
    ORDER BY started_at
  `, [Number.parseInt(channel, 10), new Date(startMs).toISOString(), new Date(endMs).toISOString()])

  return result.rows.map((row) => buildModelInterval(row))
}

function normalizeDetection(item: Record<string, unknown>, timezone: string, includeTest: boolean): NormalizedDetectionRow | null {
  const start = parseTimestampInTimeZone(typeof item.startTime === 'string' ? item.startTime : null, timezone)
  const stop = parseTimestampInTimeZone(typeof item.stopTime === 'string' ? item.stopTime : null, timezone)
  const rawDuration = item.duration
  const durationSec =
    typeof rawDuration === 'number' ? rawDuration : Number.parseFloat(String(rawDuration ?? ''))
  const isTest = Boolean(item.is_test)

  if (isTest && !includeTest) {
    return null
  }

  let startedAtMs = start?.getTime() ?? null
  let endedAtMs = stop?.getTime() ?? null
  if (startedAtMs === null && endedAtMs !== null && Number.isFinite(durationSec)) {
    startedAtMs = endedAtMs - durationSec * 1000
  }
  if (endedAtMs === null && startedAtMs !== null && Number.isFinite(durationSec)) {
    endedAtMs = startedAtMs + durationSec * 1000
  }
  if (startedAtMs === null || endedAtMs === null || endedAtMs <= startedAtMs) {
    return null
  }

  const channel = Number.parseInt(String(item.channel ?? ''), 10)
  if (!Number.isFinite(channel)) {
    return null
  }

  return {
    id: String(item.id ?? `${channel}-${startedAtMs}-${endedAtMs}`),
    channel,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationSec: Number(((endedAtMs - startedAtMs) / 1000).toFixed(4)),
    isTest,
    userName: typeof item.userName === 'string' ? item.userName : null,
    source: 'dynamodb',
    rawPayload: JSON.stringify(item),
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function syncDetections(params: {
  pool: Pool
  docClient: DynamoDBDocumentClient
  timezone: string
  startMs: number
  endMs: number
  channels: string[] | null
  includeTest: boolean
}): Promise<void> {
  const { pool, docClient, timezone, startMs, endMs, channels, includeTest } = params
  const items: Record<string, unknown>[] = []
  let lastEvaluatedKey: Record<string, unknown> | undefined

  do {
    const command = new ScanCommand({
      TableName: DATA_LABELS_TABLE,
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 1000,
      ProjectionExpression: '#id, channel, startTime, stopTime, #duration, is_test, userName',
      ExpressionAttributeNames: {
        '#id': 'id',
        '#duration': 'duration',
      },
    })
    const response = await docClient.send(command)
    if (response.Items) {
      items.push(...(response.Items as Record<string, unknown>[]))
    }
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  const normalized = items
    .map((item) => normalizeDetection(item, timezone, includeTest))
    .filter((row): row is NormalizedDetectionRow => row !== null)
    .filter((row) => row.startedAt < new Date(endMs).toISOString() && row.endedAt > new Date(startMs).toISOString())
    .filter((row) => (channels ? channels.includes(String(row.channel)) : true))

  for (const rows of chunk(normalized, 200)) {
    const values: unknown[] = []
    const placeholders = rows.map((row, index) => {
      const offset = index * 9
      values.push(
        row.id,
        row.channel,
        row.startedAt,
        row.endedAt,
        row.durationSec,
        row.isTest,
        row.userName,
        row.source,
        row.rawPayload,
      )
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
    })

    await pool.query(`
      INSERT INTO model_detection_events (
        id,
        channel,
        started_at,
        ended_at,
        duration_sec,
        is_test,
        user_name,
        source,
        raw_payload
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        channel = EXCLUDED.channel,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        duration_sec = EXCLUDED.duration_sec,
        is_test = EXCLUDED.is_test,
        user_name = EXCLUDED.user_name,
        source = EXCLUDED.source,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = CURRENT_TIMESTAMP
    `, values)
  }

  await pool.query(`
    INSERT INTO model_performance_refresh_state (job_name, last_synced_at, metadata)
    VALUES ('sync-detections', CURRENT_TIMESTAMP, $1::jsonb)
    ON CONFLICT (job_name) DO UPDATE SET
      last_synced_at = EXCLUDED.last_synced_at,
      metadata = EXCLUDED.metadata,
      updated_at = CURRENT_TIMESTAMP
  `, [JSON.stringify({ insertedRows: normalized.length })])

  console.log(`Synced ${normalized.length} normalized detections into model_detection_events`)
}

function listDays(startDay: string, endDay: string): string[] {
  const [startYear, startMonth, startDate] = startDay.split('-').map(Number)
  const [endYear, endMonth, endDate] = endDay.split('-').map(Number)
  const current = new Date(Date.UTC(startYear, startMonth - 1, startDate))
  const end = new Date(Date.UTC(endYear, endMonth - 1, endDate))
  const days: string[] = []

  while (current <= end) {
    const year = current.getUTCFullYear().toString().padStart(4, '0')
    const month = (current.getUTCMonth() + 1).toString().padStart(2, '0')
    const day = current.getUTCDate().toString().padStart(2, '0')
    days.push(`${year}-${month}-${day}`)
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return days
}

function buildAggregateRows(
  truthIntervals: TruthInterval[],
  modelIntervals: ModelInterval[],
  breakComparisons: BreakComparison[],
  bucketKey: TrendBucketKey,
  startMs: number,
  endMs: number,
  timezone: string,
): AggregateUpsertRow[] {
  return buildTrendPoints({
    truthIntervals,
    modelIntervals,
    breakComparisons,
    rangeStartMs: startMs,
    rangeEndMs: endMs,
    bucketKey,
    timeZone: timezone,
  }).map((point) => {
    const bucketStartMs = new Date(point.bucketStart).getTime()
    const bucketEndMs = new Date(point.bucketEnd).getTime()
    const bucketComparisons = breakComparisons.filter(
      (comparison) => comparison.truthStartMs >= bucketStartMs && comparison.truthStartMs < bucketEndMs,
    )
    const latencyValues = bucketComparisons
      .map((comparison) => comparison.latencySec)
      .filter((value): value is number => value !== null)
    const overCaptureTailValues = bucketComparisons
      .map((comparison) => comparison.overCaptureTailSec)
      .filter((value): value is number => value !== null)

    return {
      bucketStart: point.bucketStart,
      bucketEnd: point.bucketEnd,
      metrics: point,
      latencySampleCount: latencyValues.length,
      startLatencySumSec: Number(latencyValues.reduce((total, value) => total + value, 0).toFixed(4)),
      overCaptureTailSampleCount: overCaptureTailValues.length,
      overCaptureTailSumSec: Number(overCaptureTailValues.reduce((total, value) => total + value, 0).toFixed(4)),
    }
  })
}

async function upsertAggregateRows(
  pool: Pool,
  tableName: 'model_performance_15min' | 'model_performance_hourly' | 'model_performance_daily',
  channel: string,
  rows: AggregateUpsertRow[],
): Promise<void> {
  for (const row of rows) {
    await pool.query(`
      INSERT INTO ${tableName} (
        channel,
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
        over_capture_tail_sum_sec,
        refreshed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, CURRENT_TIMESTAMP
      )
      ON CONFLICT (channel, bucket_start) DO UPDATE SET
        bucket_end = EXCLUDED.bucket_end,
        ground_truth_seconds = EXCLUDED.ground_truth_seconds,
        model_seconds = EXCLUDED.model_seconds,
        overlap_seconds = EXCLUDED.overlap_seconds,
        recall_by_seconds = EXCLUDED.recall_by_seconds,
        precision_by_seconds = EXCLUDED.precision_by_seconds,
        break_hit_rate = EXCLUDED.break_hit_rate,
        missed_seconds = EXCLUDED.missed_seconds,
        false_positive_seconds = EXCLUDED.false_positive_seconds,
        average_start_latency_sec = EXCLUDED.average_start_latency_sec,
        p95_start_latency_sec = EXCLUDED.p95_start_latency_sec,
        average_over_capture_tail_sec = EXCLUDED.average_over_capture_tail_sec,
        total_ground_truth_breaks = EXCLUDED.total_ground_truth_breaks,
        matched_ground_truth_breaks = EXCLUDED.matched_ground_truth_breaks,
        total_model_intervals = EXCLUDED.total_model_intervals,
        matched_model_intervals = EXCLUDED.matched_model_intervals,
        total_ground_truth_recordings = EXCLUDED.total_ground_truth_recordings,
        latest_truth_break_at = EXCLUDED.latest_truth_break_at,
        latest_model_interval_at = EXCLUDED.latest_model_interval_at,
        latency_sample_count = EXCLUDED.latency_sample_count,
        start_latency_sum_sec = EXCLUDED.start_latency_sum_sec,
        over_capture_tail_sample_count = EXCLUDED.over_capture_tail_sample_count,
        over_capture_tail_sum_sec = EXCLUDED.over_capture_tail_sum_sec,
        refreshed_at = CURRENT_TIMESTAMP
    `, [
      Number.parseInt(channel, 10),
      row.bucketStart,
      row.bucketEnd,
      row.metrics.groundTruthSeconds,
      row.metrics.modelSeconds,
      row.metrics.overlapSeconds,
      row.metrics.recallBySeconds,
      row.metrics.precisionBySeconds,
      row.metrics.breakHitRate,
      row.metrics.missedSeconds,
      row.metrics.falsePositiveSeconds,
      row.metrics.averageStartLatencySec,
      row.metrics.p95StartLatencySec,
      row.metrics.averageOverCaptureTailSec,
      row.metrics.totalGroundTruthBreaks,
      row.metrics.matchedGroundTruthBreaks,
      row.metrics.totalModelIntervals,
      row.metrics.matchedModelIntervals,
      row.metrics.totalGroundTruthRecordings,
      row.metrics.latestTruthBreakAtMs ? new Date(row.metrics.latestTruthBreakAtMs).toISOString() : null,
      row.metrics.latestModelIntervalAtMs ? new Date(row.metrics.latestModelIntervalAtMs).toISOString() : null,
      row.latencySampleCount,
      row.startLatencySumSec,
      row.overCaptureTailSampleCount,
      row.overCaptureTailSumSec,
    ])
  }
}

async function aggregateRange(params: {
  pool: Pool
  startDay: string
  endDay: string
  timezone: string
  channels: string[] | null
}): Promise<void> {
  const { pool, startDay, endDay, timezone, channels } = params
  const dayList = listDays(startDay, endDay)
  const channelList = channels ?? (
    await pool.query<{ channel: string }>('SELECT DISTINCT channel::text AS channel FROM comskip_ground_truth_recordings ORDER BY channel::int')
  ).rows.map((row) => row.channel)

  for (const day of dayList) {
    const { start, end } = dayWindow(day, timezone)
    for (const channel of channelList) {
      const truthIntervals = await fetchTruthIntervals(pool, channel, start.getTime(), end.getTime())
      const modelIntervals = await fetchModelIntervals(pool, channel, start.getTime(), end.getTime())
      const breakComparisons = buildBreakComparisons(truthIntervals, modelIntervals)
      const dailyMetrics = computePerformanceMetrics(
        truthIntervals,
        modelIntervals,
        breakComparisons,
        start.getTime(),
        end.getTime(),
      )

      await upsertAggregateRows(pool, 'model_performance_daily', channel, [
        {
          bucketStart: start.toISOString(),
          bucketEnd: end.toISOString(),
          metrics: dailyMetrics,
          latencySampleCount: breakComparisons.filter((comparison) => comparison.latencySec !== null).length,
          startLatencySumSec: Number(
            breakComparisons.reduce((total, comparison) => total + (comparison.latencySec ?? 0), 0).toFixed(4),
          ),
          overCaptureTailSampleCount: breakComparisons.filter((comparison) => comparison.overCaptureTailSec !== null).length,
          overCaptureTailSumSec: Number(
            breakComparisons.reduce((total, comparison) => total + (comparison.overCaptureTailSec ?? 0), 0).toFixed(4),
          ),
        },
      ])

      await upsertAggregateRows(
        pool,
        'model_performance_hourly',
        channel,
        buildAggregateRows(truthIntervals, modelIntervals, breakComparisons, '1h', start.getTime(), end.getTime(), timezone),
      )
      await upsertAggregateRows(
        pool,
        'model_performance_15min',
        channel,
        buildAggregateRows(truthIntervals, modelIntervals, breakComparisons, '15m', start.getTime(), end.getTime(), timezone),
      )

      console.log(`Aggregated channel ${channel} for ${day}`)
    }
  }

  await pool.query(`
    INSERT INTO model_performance_refresh_state (job_name, last_synced_at, metadata)
    VALUES ('aggregate-model-performance', CURRENT_TIMESTAMP, $1::jsonb)
    ON CONFLICT (job_name) DO UPDATE SET
      last_synced_at = EXCLUDED.last_synced_at,
      metadata = EXCLUDED.metadata,
      updated_at = CURRENT_TIMESTAMP
  `, [JSON.stringify({ startDay, endDay, channels: channelList })])
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const startWindow = dayWindow(options.start, options.timezone)
  const endWindow = dayWindow(options.end, options.timezone)
  const { pool, connector } = await createPool()
  const docClient = createDynamoDocumentClient()

  try {
    await ensureSchema(pool)

    if (options.mode === 'sync' || options.mode === 'all') {
      await syncDetections({
        pool,
        docClient,
        timezone: options.timezone,
        startMs: startWindow.start.getTime(),
        endMs: endWindow.end.getTime(),
        channels: options.channels,
        includeTest: options.includeTest,
      })
    }

    if (options.mode === 'aggregate' || options.mode === 'all') {
      await aggregateRange({
        pool,
        startDay: options.start,
        endDay: options.end,
        timezone: options.timezone,
        channels: options.channels,
      })
    }
  } finally {
    await pool.end()
    connector?.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
