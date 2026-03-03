import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { fromIni } from '@aws-sdk/credential-providers'
import type { Pool } from 'pg'
import { loadLocalEnv } from '../server/loadEnv'
import { closePostgresPool, getPostgresPool } from '../server/postgres'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

loadLocalEnv(path.resolve(__dirname, '..'))

type CliMode = 'sync' | 'aggregate' | 'all'

interface CliOptions {
  mode: CliMode
  startDay: string | null
  endDay: string | null
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

const AD_PLAYS_TABLE = process.env.AD_PLAYS_TABLE || 'attentv-ad-plays-prod'

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

  return {
    mode: (args.get('mode') || 'all') as CliMode,
    startDay: args.get('start') || null,
    endDay: args.get('end') || args.get('start') || null,
  }
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

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function parseNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }

  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
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
    metadata:
      item.metadata && typeof item.metadata === 'object'
        ? JSON.stringify(item.metadata)
        : null,
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

async function ensureSchema(pool: Pool): Promise<void> {
  const schemaPath = path.resolve(__dirname, '../sql_cloud/ad_play_analytics_schema.sql')
  await pool.query(fs.readFileSync(schemaPath, 'utf8'))
}

async function syncAdPlayEvents(pool: Pool, docClient: DynamoDBDocumentClient): Promise<void> {
  const items: Record<string, unknown>[] = []
  let lastEvaluatedKey: Record<string, unknown> | undefined

  do {
    const command = new ScanCommand({
      TableName: AD_PLAYS_TABLE,
      ExclusiveStartKey: lastEvaluatedKey,
      ProjectionExpression: [
        'play_id',
        'device_id',
        'ad_filename',
        '#timestamp',
        'play_duration',
        'play_start_time',
        'play_end_time',
        'environment',
        'play_status',
        'bug_detected',
        'switch_type',
        'metadata',
      ].join(', '),
      ExpressionAttributeNames: {
        '#timestamp': 'timestamp',
      },
    })

    const response = await docClient.send(command)
    if (response.Items) {
      items.push(...(response.Items as Record<string, unknown>[]))
    }
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  const normalized = items
    .map((item) => normalizeAdPlay(item))
    .filter((row): row is NormalizedAdPlayRow => row !== null)

  for (const rows of chunk(normalized, 200)) {
    const values: unknown[] = []
    const placeholders = rows.map((row, index) => {
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

    await pool.query(`
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
    `, values)
  }

  await pool.query(`
    INSERT INTO ad_play_analytics_refresh_state (job_name, last_synced_at, metadata)
    VALUES ('sync-ad-play-events', CURRENT_TIMESTAMP, $1::jsonb)
    ON CONFLICT (job_name) DO UPDATE SET
      last_synced_at = EXCLUDED.last_synced_at,
      metadata = EXCLUDED.metadata,
      updated_at = CURRENT_TIMESTAMP
  `, [JSON.stringify({ insertedRows: normalized.length })])

  console.log(`Synced ${normalized.length} ad play events into ad_play_events`)
}

function parseDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

async function resolveAggregateBounds(pool: Pool, startDay: string | null, endDay: string | null): Promise<{
  rangeStart: Date
  rangeEnd: Date
}> {
  if (startDay && endDay) {
    return {
      rangeStart: parseDayStart(startDay),
      rangeEnd: addUtcDays(parseDayStart(endDay), 1),
    }
  }

  const result = await pool.query<{ first_played_at: string | null; last_played_at: string | null }>(`
    SELECT
      MIN(played_at) AS first_played_at,
      MAX(played_at) AS last_played_at
    FROM ad_play_events
  `)

  const firstPlayedAt = result.rows[0]?.first_played_at
  const lastPlayedAt = result.rows[0]?.last_played_at
  if (!firstPlayedAt || !lastPlayedAt) {
    throw new Error('ad_play_events is empty. Run the sync step before aggregating.')
  }

  const firstDate = new Date(firstPlayedAt)
  const lastDate = new Date(lastPlayedAt)
  const rangeStart = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), firstDate.getUTCDate()))
  const rangeEnd = addUtcDays(new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate())), 1)

  return { rangeStart, rangeEnd }
}

async function aggregateHourly(pool: Pool, startDay: string | null, endDay: string | null): Promise<void> {
  const { rangeStart, rangeEnd } = await resolveAggregateBounds(pool, startDay, endDay)

  await pool.query('DELETE FROM ad_play_hourly WHERE bucket_start >= $1 AND bucket_start < $2', [
    rangeStart.toISOString(),
    rangeEnd.toISOString(),
  ])

  await pool.query(`
    INSERT INTO ad_play_hourly (
      bucket_start,
      bucket_end,
      device_id,
      ad_filename,
      play_count,
      total_duration,
      first_play_at,
      last_play_at
    )
    SELECT
      bucket_start,
      bucket_start + INTERVAL '1 hour' AS bucket_end,
      device_id,
      ad_filename,
      COUNT(*)::int AS play_count,
      COALESCE(SUM(play_duration), 0)::double precision AS total_duration,
      MIN(played_at) AS first_play_at,
      MAX(played_at) AS last_play_at
    FROM (
      SELECT
        (date_trunc('hour', played_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket_start,
        device_id,
        ad_filename,
        play_duration,
        played_at
      FROM ad_play_events
      WHERE played_at >= $1
        AND played_at < $2
    ) aggregated
    GROUP BY bucket_start, device_id, ad_filename
  `, [rangeStart.toISOString(), rangeEnd.toISOString()])

  await pool.query(`
    INSERT INTO ad_play_analytics_refresh_state (job_name, last_synced_at, metadata)
    VALUES ('aggregate-ad-play-hourly', CURRENT_TIMESTAMP, $1::jsonb)
    ON CONFLICT (job_name) DO UPDATE SET
      last_synced_at = EXCLUDED.last_synced_at,
      metadata = EXCLUDED.metadata,
      updated_at = CURRENT_TIMESTAMP
  `, [JSON.stringify({
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
  })])

  console.log(`Aggregated ad_play_hourly for ${rangeStart.toISOString()} -> ${rangeEnd.toISOString()}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const pool = await getPostgresPool()
  const docClient = createDynamoDocumentClient()

  try {
    await ensureSchema(pool)

    if (options.mode === 'sync' || options.mode === 'all') {
      await syncAdPlayEvents(pool, docClient)
    }

    if (options.mode === 'aggregate' || options.mode === 'all') {
      await aggregateHourly(pool, options.startDay, options.endDay)
    }
  } finally {
    await closePostgresPool()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
