import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { Pool, PoolClient } from 'pg'
import { getPostgresPool } from './postgres'
import {
  DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
  getTimeZoneDateParts,
  parseTimestampInTimeZone,
} from '../shared/timezone'
import type { SqlMirrorHealth, SqlMirrorSourceStatus, SqlMirrorStatusResponse } from '../shared/sqlMirror'

interface SqlMirrorSyncOptions {
  docClient: DynamoDBDocumentClient
  dataLabelsTable: string
  adPlaysTable: string
  listKnownDevices: () => Promise<string[]>
}

interface ModelRefreshState {
  [key: string]: unknown
  lastExclusiveStartKey?: {
    channel: string
    startTime: string
  }
  lastBootstrapLowerBound?: string | null
  lastCycleAt?: string
}

interface AdPlayRefreshState {
  [key: string]: unknown
  lastExclusiveStartKey?: {
    device_id: string
    play_id: string
    timestamp: string
  }
  lastBootstrapLowerBound?: string | null
  lastCycleAt?: string
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

interface NormalizedAdPlayRow {
  playId: string
  deviceId: string
  adFilename: string
  playedAt: string
  playDuration: number
  playStartTime: string | null
  playEndTime: string | null
  environment: string | null
  playStatus: string | null
  bugDetected: boolean | null
  switchType: string | null
  metadata: string | null
  rawPayload: string
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SQL_REPLICATION_LOCK_KEY = 3032026

let schemasEnsured = false
let replicationStarted = false
let replicationRunning = false
let replicationTimer: NodeJS.Timeout | null = null
let lockClient: PoolClient | null = null

function sqlReplicationEnabled(): boolean {
  return process.env.SQL_REPLICATION_ENABLED !== 'false'
}

function sqlReplicationPollMs(): number {
  return Number.parseInt(process.env.SQL_REPLICATION_POLL_MS || '30000', 10)
}

function modelRecentReplayDays(): number {
  return Number.parseInt(process.env.MODEL_SQL_RECENT_REPLAY_DAYS || '2', 10)
}

function adPlayRecentReplayHours(): number {
  return Number.parseInt(process.env.AD_PLAY_SQL_RECENT_REPLAY_HOURS || '48', 10)
}

function sqlReplicationPollSeconds(): number {
  return Math.max(1, Math.round(sqlReplicationPollMs() / 1000))
}

function toDateKey(date: Date, timeZone: string): string {
  const parts = getTimeZoneDateParts(date, timeZone)
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day
    .toString()
    .padStart(2, '0')}`
}

function subtractUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() - days)
  return next
}

function subtractUtcHours(date: Date, hours: number): Date {
  return new Date(date.getTime() - hours * 60 * 60 * 1000)
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

function parseNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }

  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

async function ensureSchemas(pool: Pool): Promise<void> {
  if (schemasEnsured) {
    return
  }

  const schemaFiles = [
    path.resolve(__dirname, '../sql_cloud/model_performance_schema.sql'),
    path.resolve(__dirname, '../sql_cloud/ad_play_analytics_schema.sql'),
  ]

  for (const schemaFile of schemaFiles) {
    await pool.query(fs.readFileSync(schemaFile, 'utf8'))
  }

  schemasEnsured = true
}

async function sqlTableExists(pool: Pool, tableName: string): Promise<boolean> {
  const result = await pool.query<{ present: string | null }>('SELECT to_regclass($1) AS present', [tableName])
  return Boolean(result.rows[0]?.present)
}

function resolveStateTable(tableName: 'model' | 'adPlay'): string {
  return tableName === 'model' ? 'model_performance_refresh_state' : 'ad_play_analytics_refresh_state'
}

async function loadRefreshState<T extends Record<string, unknown>>(
  pool: Pool,
  tableName: 'model' | 'adPlay',
  jobName: string,
): Promise<T | null> {
  const stateTable = resolveStateTable(tableName)
  const result = await pool.query<{ metadata: T | null }>(
    `SELECT metadata FROM ${stateTable} WHERE job_name = $1 LIMIT 1`,
    [jobName],
  )

  return result.rows[0]?.metadata ?? null
}

async function saveRefreshState(
  pool: Pool,
  tableName: 'model' | 'adPlay',
  jobName: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const stateTable = resolveStateTable(tableName)
  await pool.query(
    `
      INSERT INTO ${stateTable} (job_name, last_synced_at, metadata)
      VALUES ($1, CURRENT_TIMESTAMP, $2::jsonb)
      ON CONFLICT (job_name) DO UPDATE SET
        last_synced_at = EXCLUDED.last_synced_at,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP
    `,
    [jobName, JSON.stringify(metadata)],
  )
}

function normalizeDetection(
  item: Record<string, unknown>,
  timezone: string,
): NormalizedDetectionRow | null {
  const start = parseTimestampInTimeZone(typeof item.startTime === 'string' ? item.startTime : null, timezone)
  const stop = parseTimestampInTimeZone(typeof item.stopTime === 'string' ? item.stopTime : null, timezone)
  const durationSec = parseNumber(item.duration)

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
    isTest: Boolean(item.is_test),
    userName: typeof item.userName === 'string' ? item.userName : null,
    source: 'dynamodb',
    rawPayload: JSON.stringify(item),
  }
}

function normalizeAdPlay(item: Record<string, unknown>): NormalizedAdPlayRow | null {
  const playId = typeof item.play_id === 'string' ? item.play_id : null
  const deviceId = typeof item.device_id === 'string' ? item.device_id : null
  const adFilename = typeof item.ad_filename === 'string' ? item.ad_filename : null
  const playedAt = parseTimestamp(item.timestamp)

  if (!playId || !deviceId || !adFilename || !playedAt) {
    return null
  }

  return {
    playId,
    deviceId,
    adFilename,
    playedAt,
    playDuration: parseNumber(item.play_duration),
    playStartTime: parseTimestamp(item.play_start_time),
    playEndTime: parseTimestamp(item.play_end_time),
    environment: typeof item.environment === 'string' ? item.environment : null,
    playStatus: typeof item.play_status === 'string' ? item.play_status : null,
    bugDetected: typeof item.bug_detected === 'boolean' ? item.bug_detected : null,
    switchType: typeof item.switch_type === 'string' ? item.switch_type : null,
    metadata: item.metadata && typeof item.metadata === 'object' ? JSON.stringify(item.metadata) : null,
    rawPayload: JSON.stringify(item),
  }
}

async function upsertModelDetections(pool: Pool, rows: NormalizedDetectionRow[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  for (const batch of chunk(rows, 200)) {
    const values: unknown[] = []
    const placeholders = batch.map((row, index) => {
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

    await pool.query(
      `
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
      `,
      values,
    )
  }
}

async function upsertAdPlayEvents(pool: Pool, rows: NormalizedAdPlayRow[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  for (const batch of chunk(rows, 200)) {
    const values: unknown[] = []
    const placeholders = batch.map((row, index) => {
      const offset = index * 13
      values.push(
        row.playId,
        row.deviceId,
        row.adFilename,
        row.playedAt,
        row.playDuration,
        row.playStartTime,
        row.playEndTime,
        row.environment,
        row.playStatus,
        row.bugDetected,
        row.switchType,
        row.metadata,
        row.rawPayload,
      )

      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13})`
    })

    await pool.query(
      `
        INSERT INTO ad_play_events (
          play_id,
          device_id,
          ad_filename,
          played_at,
          play_duration,
          play_start_time,
          play_end_time,
          environment,
          play_status,
          bug_detected,
          switch_type,
          metadata,
          raw_payload
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (play_id) DO UPDATE SET
          device_id = EXCLUDED.device_id,
          ad_filename = EXCLUDED.ad_filename,
          played_at = EXCLUDED.played_at,
          play_duration = EXCLUDED.play_duration,
          play_start_time = EXCLUDED.play_start_time,
          play_end_time = EXCLUDED.play_end_time,
          environment = EXCLUDED.environment,
          play_status = EXCLUDED.play_status,
          bug_detected = EXCLUDED.bug_detected,
          switch_type = EXCLUDED.switch_type,
          metadata = EXCLUDED.metadata,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = CURRENT_TIMESTAMP
      `,
      values,
    )
  }
}

async function listModelChannels(pool: Pool): Promise<string[]> {
  const configuredChannels = (process.env.MODEL_REPLICATION_CHANNELS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const truthResult = await pool.query<{ channel: string }>(`
    SELECT channel::text AS channel
    FROM comskip_ground_truth_recordings
    GROUP BY channel
    ORDER BY channel
  `)
  const mirroredResult = await pool.query<{ channel: string }>(`
    SELECT channel::text AS channel
    FROM model_detection_events
    GROUP BY channel
    ORDER BY channel
  `)

  return Array.from(
    new Set<string>([
      ...configuredChannels,
      ...truthResult.rows.map((row) => row.channel),
      ...mirroredResult.rows.map((row) => row.channel),
    ]),
  ).sort((left, right) => Number(left) - Number(right))
}

async function listAdPlayDevices(pool: Pool, listKnownDevices: () => Promise<string[]>): Promise<string[]> {
  const configuredDevices = (process.env.AD_PLAY_REPLICATION_DEVICES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const knownDevices = await listKnownDevices().catch(() => [])
  const mirroredResult = await pool.query<{ device_id: string }>(`
    SELECT device_id
    FROM ad_play_events
    GROUP BY device_id
    ORDER BY device_id
  `)

  return Array.from(
    new Set<string>([
      ...configuredDevices,
      ...knownDevices,
      ...mirroredResult.rows.map((row) => row.device_id),
    ]),
  ).sort()
}

async function resolveModelBootstrapLowerBound(
  pool: Pool,
  channel: string,
  timeZone: string,
): Promise<string | null> {
  const result = await pool.query<{ latest_started_at: string | null }>(
    `
      SELECT MAX(started_at) AS latest_started_at
      FROM model_detection_events
      WHERE channel = $1
    `,
    [Number.parseInt(channel, 10)],
  )
  const latestStartedAt = result.rows[0]?.latest_started_at
  if (!latestStartedAt) {
    return null
  }

  return toDateKey(subtractUtcDays(new Date(latestStartedAt), 1), timeZone)
}

async function resolveAdPlayBootstrapLowerBound(pool: Pool, deviceId: string): Promise<string | null> {
  const result = await pool.query<{ latest_played_at: string | null }>(
    `
      SELECT MAX(played_at) AS latest_played_at
      FROM ad_play_events
      WHERE device_id = $1
    `,
    [deviceId],
  )
  const latestPlayedAt = result.rows[0]?.latest_played_at
  if (!latestPlayedAt) {
    return null
  }

  return subtractUtcHours(new Date(latestPlayedAt), 24).toISOString()
}

async function syncModelChannelRange(params: {
  pool: Pool
  docClient: DynamoDBDocumentClient
  tableName: string
  channel: string
  timeZone: string
  lowerBound?: string
  exclusiveStartKey?: { channel: string; startTime: string }
}): Promise<{ insertedRows: number; lastExclusiveStartKey: { channel: string; startTime: string } | null }> {
  const expressionAttributeNames: Record<string, string> = {
    '#channel': 'channel',
    '#startTime': 'startTime',
    '#id': 'id',
    '#duration': 'duration',
  }
  const expressionAttributeValues: Record<string, unknown> = {
    ':channel': params.channel,
  }
  const keyConditions = ['#channel = :channel']

  if (params.lowerBound) {
    keyConditions.push('#startTime >= :startTime')
    expressionAttributeValues[':startTime'] = params.lowerBound
  }

  let insertedRows = 0
  let lastExclusiveStartKey = params.exclusiveStartKey ?? null
  let nextExclusiveStartKey = params.exclusiveStartKey as Record<string, unknown> | undefined

  do {
    const response = await params.docClient.send(
      new QueryCommand({
        TableName: params.tableName,
        KeyConditionExpression: keyConditions.join(' AND '),
        ProjectionExpression: '#id, #channel, #startTime, stopTime, #duration, is_test, userName',
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ExclusiveStartKey: nextExclusiveStartKey,
        Limit: 1000,
        ScanIndexForward: true,
      }),
    )

    const items = (response.Items as Record<string, unknown>[] | undefined) ?? []
    const normalizedRows = items
      .map((item) => normalizeDetection(item, params.timeZone))
      .filter((row): row is NormalizedDetectionRow => row !== null)

    await upsertModelDetections(params.pool, normalizedRows)
    insertedRows += normalizedRows.length

    const lastItem = items[items.length - 1]
    if (lastItem && typeof lastItem.channel === 'string' && typeof lastItem.startTime === 'string') {
      lastExclusiveStartKey = {
        channel: lastItem.channel,
        startTime: lastItem.startTime,
      }
    }

    nextExclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (nextExclusiveStartKey)

  return {
    insertedRows,
    lastExclusiveStartKey,
  }
}

async function syncModelDetections(params: {
  pool: Pool
  docClient: DynamoDBDocumentClient
  tableName: string
}): Promise<void> {
  const timeZone = process.env.MODEL_PERFORMANCE_TIMEZONE || DEFAULT_MODEL_PERFORMANCE_TIMEZONE
  const channels = await listModelChannels(params.pool)
  if (channels.length === 0) {
    return
  }

  for (const channel of channels) {
    const jobName = `replicate-data-labels:${channel}`
    const state = (await loadRefreshState<ModelRefreshState>(params.pool, 'model', jobName)) ?? {}

    let insertedRows = 0
    let lastExclusiveStartKey = state.lastExclusiveStartKey ?? null
    let lastBootstrapLowerBound = state.lastBootstrapLowerBound ?? null

    if (state.lastExclusiveStartKey) {
      const incremental = await syncModelChannelRange({
        pool: params.pool,
        docClient: params.docClient,
        tableName: params.tableName,
        channel,
        timeZone,
        exclusiveStartKey: state.lastExclusiveStartKey,
      })

      insertedRows += incremental.insertedRows
      lastExclusiveStartKey = incremental.lastExclusiveStartKey ?? lastExclusiveStartKey

      const replayLowerBound = toDateKey(subtractUtcDays(new Date(), modelRecentReplayDays()), timeZone)
      const replay = await syncModelChannelRange({
        pool: params.pool,
        docClient: params.docClient,
        tableName: params.tableName,
        channel,
        timeZone,
        lowerBound: replayLowerBound,
      })
      insertedRows += replay.insertedRows
    } else {
      lastBootstrapLowerBound = await resolveModelBootstrapLowerBound(params.pool, channel, timeZone)
      const bootstrap = await syncModelChannelRange({
        pool: params.pool,
        docClient: params.docClient,
        tableName: params.tableName,
        channel,
        timeZone,
        ...(lastBootstrapLowerBound ? { lowerBound: lastBootstrapLowerBound } : {}),
      })

      insertedRows += bootstrap.insertedRows
      lastExclusiveStartKey = bootstrap.lastExclusiveStartKey ?? lastExclusiveStartKey
    }

    await saveRefreshState(params.pool, 'model', jobName, {
      lastExclusiveStartKey,
      lastBootstrapLowerBound,
      lastCycleAt: new Date().toISOString(),
      insertedRows,
    })
  }
}

async function syncAdPlayRange(params: {
  pool: Pool
  docClient: DynamoDBDocumentClient
  tableName: string
  deviceId: string
  lowerBound?: string
  exclusiveStartKey?: {
    device_id: string
    play_id: string
    timestamp: string
  }
}): Promise<{ insertedRows: number; lastExclusiveStartKey: { device_id: string; play_id: string; timestamp: string } | null }> {
  const expressionAttributeNames: Record<string, string> = {
    '#device': 'device_id',
  }
  const expressionAttributeValues: Record<string, unknown> = {
    ':device': params.deviceId,
  }
  const keyConditions = ['#device = :device']

  if (params.lowerBound) {
    expressionAttributeNames['#timestamp'] = 'timestamp'
    keyConditions.push('#timestamp >= :start')
    expressionAttributeValues[':start'] = params.lowerBound
  }

  let insertedRows = 0
  let lastExclusiveStartKey = params.exclusiveStartKey ?? null
  let nextExclusiveStartKey = params.exclusiveStartKey as Record<string, unknown> | undefined

  do {
    const response = await params.docClient.send(
      new QueryCommand({
        TableName: params.tableName,
        IndexName: 'device-index',
        KeyConditionExpression: keyConditions.join(' AND '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ExclusiveStartKey: nextExclusiveStartKey,
        Limit: 1000,
        ScanIndexForward: true,
      }),
    )

    const items = (response.Items as Record<string, unknown>[] | undefined) ?? []
    const normalizedRows = items
      .map((item) => normalizeAdPlay(item))
      .filter((row): row is NormalizedAdPlayRow => row !== null)

    await upsertAdPlayEvents(params.pool, normalizedRows)
    insertedRows += normalizedRows.length

    const lastItem = items[items.length - 1]
    if (
      lastItem &&
      typeof lastItem.device_id === 'string' &&
      typeof lastItem.play_id === 'string' &&
      typeof lastItem.timestamp === 'string'
    ) {
      lastExclusiveStartKey = {
        device_id: lastItem.device_id,
        play_id: lastItem.play_id,
        timestamp: lastItem.timestamp,
      }
    }

    nextExclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (nextExclusiveStartKey)

  return {
    insertedRows,
    lastExclusiveStartKey,
  }
}

async function syncAdPlays(params: {
  pool: Pool
  docClient: DynamoDBDocumentClient
  tableName: string
  listKnownDevices: () => Promise<string[]>
}): Promise<void> {
  const deviceIds = await listAdPlayDevices(params.pool, params.listKnownDevices)
  if (deviceIds.length === 0) {
    return
  }

  for (const deviceId of deviceIds) {
    const jobName = `replicate-ad-play-events:${deviceId}`
    const state = (await loadRefreshState<AdPlayRefreshState>(params.pool, 'adPlay', jobName)) ?? {}

    let insertedRows = 0
    let lastExclusiveStartKey = state.lastExclusiveStartKey ?? null
    let lastBootstrapLowerBound = state.lastBootstrapLowerBound ?? null

    if (state.lastExclusiveStartKey) {
      const incremental = await syncAdPlayRange({
        pool: params.pool,
        docClient: params.docClient,
        tableName: params.tableName,
        deviceId,
        exclusiveStartKey: state.lastExclusiveStartKey,
      })
      insertedRows += incremental.insertedRows
      lastExclusiveStartKey = incremental.lastExclusiveStartKey ?? lastExclusiveStartKey

      const replayLowerBound = subtractUtcHours(new Date(), adPlayRecentReplayHours()).toISOString()
      const replay = await syncAdPlayRange({
        pool: params.pool,
        docClient: params.docClient,
        tableName: params.tableName,
        deviceId,
        lowerBound: replayLowerBound,
      })
      insertedRows += replay.insertedRows
    } else {
      lastBootstrapLowerBound = await resolveAdPlayBootstrapLowerBound(params.pool, deviceId)
      const bootstrap = await syncAdPlayRange({
        pool: params.pool,
        docClient: params.docClient,
        tableName: params.tableName,
        deviceId,
        ...(lastBootstrapLowerBound ? { lowerBound: lastBootstrapLowerBound } : {}),
      })
      insertedRows += bootstrap.insertedRows
      lastExclusiveStartKey = bootstrap.lastExclusiveStartKey ?? lastExclusiveStartKey
    }

    await saveRefreshState(params.pool, 'adPlay', jobName, {
      lastExclusiveStartKey,
      lastBootstrapLowerBound,
      lastCycleAt: new Date().toISOString(),
      insertedRows,
    })
  }
}

function deriveMirrorHealth(workerLagSeconds: number | null, workerEnabled: boolean): SqlMirrorHealth {
  if (!workerEnabled) {
    return 'warning'
  }

  if (workerLagSeconds === null) {
    return 'unknown'
  }

  const pollSeconds = sqlReplicationPollSeconds()
  if (workerLagSeconds <= Math.max(pollSeconds * 2, 90)) {
    return 'healthy'
  }
  if (workerLagSeconds <= Math.max(pollSeconds * 8, 300)) {
    return 'warning'
  }
  return 'critical'
}

async function fetchSourceStatus(pool: Pool, params: {
  key: SqlMirrorSourceStatus['key']
  label: string
  mirrorTable: string
  latestTimestampColumn: string
  orderByColumn: string
  refreshStateTable: 'model' | 'adPlay'
  jobNamePattern: string
  partitionLabel: string
  note: string
}): Promise<SqlMirrorSourceStatus> {
  const workerEnabled = sqlReplicationEnabled()
  const stateTable = resolveStateTable(params.refreshStateTable)
  const now = Date.now()

  const [mirrorTablePresent, stateTablePresent] = await Promise.all([
    sqlTableExists(pool, params.mirrorTable),
    sqlTableExists(pool, stateTable),
  ])

  let workerLastSyncAt: string | null = null
  let partitionCount = 0

  if (stateTablePresent) {
    const refreshResult = await pool.query<{ worker_last_sync_at: string | null; partition_count: string }>(`
      SELECT
        MAX(last_synced_at) AS worker_last_sync_at,
        COUNT(*)::bigint AS partition_count
      FROM ${stateTable}
      WHERE job_name LIKE $1
    `, [params.jobNamePattern])

    workerLastSyncAt = refreshResult.rows[0]?.worker_last_sync_at ?? null
    partitionCount = Number.parseInt(refreshResult.rows[0]?.partition_count ?? '0', 10)
  }

  let latestMirroredAt: string | null = null
  if (mirrorTablePresent) {
    const latestResult = await pool.query<{ latest_mirrored_at: string | null }>(`
      SELECT ${params.latestTimestampColumn} AS latest_mirrored_at
      FROM ${params.mirrorTable}
      ORDER BY ${params.orderByColumn} DESC
      LIMIT 1
    `)

    latestMirroredAt = latestResult.rows[0]?.latest_mirrored_at ?? null
  }

  const workerLagSeconds =
    workerLastSyncAt ? Math.max(0, Math.round((now - new Date(workerLastSyncAt).getTime()) / 1000)) : null
  const dataLagSeconds =
    latestMirroredAt ? Math.max(0, Math.round((now - new Date(latestMirroredAt).getTime()) / 1000)) : null

  return {
    key: params.key,
    label: params.label,
    mirrorTable: params.mirrorTable,
    partitionLabel: params.partitionLabel,
    partitionCount,
    workerLastSyncAt,
    workerLagSeconds,
    latestMirroredAt,
    dataLagSeconds,
    status: deriveMirrorHealth(workerLagSeconds, workerEnabled),
    note: params.note,
  }
}

export async function getSqlMirrorStatus(): Promise<SqlMirrorStatusResponse> {
  const pool = await getPostgresPool()
  await ensureSchemas(pool)

  const sources = await Promise.all([
    fetchSourceStatus(pool, {
      key: 'model-detections',
      label: 'Model Detections',
      mirrorTable: 'model_detection_events',
      latestTimestampColumn: 'ended_at',
      orderByColumn: 'started_at',
      refreshStateTable: 'model',
      jobNamePattern: 'replicate-data-labels:%',
      partitionLabel: 'channels',
      note: 'Worker freshness is based on mirror cycles. Data age can grow during quiet inference periods.',
    }),
    fetchSourceStatus(pool, {
      key: 'ad-plays',
      label: 'Ad Plays',
      mirrorTable: 'ad_play_events',
      latestTimestampColumn: 'played_at',
      orderByColumn: 'played_at',
      refreshStateTable: 'adPlay',
      jobNamePattern: 'replicate-ad-play-events:%',
      partitionLabel: 'devices',
      note: 'This covers the query-heavy ad-play history used by the dashboard.',
    }),
  ])

  return {
    generatedAt: new Date().toISOString(),
    workerEnabled: sqlReplicationEnabled(),
    pollIntervalSeconds: sqlReplicationPollSeconds(),
    sources,
  }
}

export async function runSqlMirrorSyncCycle(options: SqlMirrorSyncOptions): Promise<void> {
  const pool = await getPostgresPool()
  await ensureSchemas(pool)

  await syncModelDetections({
    pool,
    docClient: options.docClient,
    tableName: options.dataLabelsTable,
  })

  await syncAdPlays({
    pool,
    docClient: options.docClient,
    tableName: options.adPlaysTable,
    listKnownDevices: options.listKnownDevices,
  })
}

async function acquireReplicationLock(pool: Pool): Promise<boolean> {
  const client = await pool.connect()
  const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
    SQL_REPLICATION_LOCK_KEY,
  ])
  const locked = Boolean(result.rows[0]?.locked)

  if (!locked) {
    client.release()
    return false
  }

  lockClient = client
  return true
}

async function releaseReplicationLock(): Promise<void> {
  if (!lockClient) {
    return
  }

  try {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [SQL_REPLICATION_LOCK_KEY])
  } catch (error) {
    console.error('Failed to release SQL replication advisory lock.', error)
  } finally {
    lockClient.release()
    lockClient = null
  }
}

export async function startSqlMirrorSyncService(options: SqlMirrorSyncOptions): Promise<void> {
  if (!sqlReplicationEnabled() || replicationStarted) {
    return
  }

  replicationStarted = true
  const pool = await getPostgresPool()
  await ensureSchemas(pool)

  const locked = await acquireReplicationLock(pool)
  if (!locked) {
    console.log('SQL mirror sync worker is already active in another process. Skipping local worker startup.')
    return
  }

  const runLoop = async () => {
    if (replicationRunning) {
      replicationTimer = setTimeout(runLoop, sqlReplicationPollMs())
      return
    }

    replicationRunning = true
    try {
      await runSqlMirrorSyncCycle(options)
    } catch (error) {
      console.error('SQL mirror sync cycle failed.', error)
    } finally {
      replicationRunning = false
      replicationTimer = setTimeout(runLoop, sqlReplicationPollMs())
    }
  }

  process.once('SIGINT', () => {
    if (replicationTimer) {
      clearTimeout(replicationTimer)
      replicationTimer = null
    }
    void releaseReplicationLock()
  })
  process.once('SIGTERM', () => {
    if (replicationTimer) {
      clearTimeout(replicationTimer)
      replicationTimer = null
    }
    void releaseReplicationLock()
  })

  void runLoop()
}
