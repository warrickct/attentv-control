import { getPostgresPool } from './postgres'

interface CacheEntry<T> {
  data: T
  timestamp: number
}

interface DataLabelQueryParams {
  channel?: string
  limit?: number
}

interface DataLabelRow {
  channel: string
  startTime: string
  duration: number
  id: string
  is_test: boolean
  stopTime: string
  userName: string | null
}

const TABLE_CACHE_TTL_MS = 5 * 60 * 1000
const tableExistsCache = new Map<string, CacheEntry<boolean>>()

async function tableExists(tableName: string): Promise<boolean> {
  const cached = tableExistsCache.get(tableName)
  if (cached && Date.now() - cached.timestamp <= TABLE_CACHE_TTL_MS) {
    return cached.data
  }

  const pool = await getPostgresPool()
  const result = await pool.query<{ present: string | null }>('SELECT to_regclass($1) AS present', [tableName])
  const exists = Boolean(result.rows[0]?.present)
  tableExistsCache.set(tableName, { data: exists, timestamp: Date.now() })
  return exists
}

async function requireTable(tableName: string): Promise<void> {
  if (!(await tableExists(tableName))) {
    throw new Error(`${tableName} is missing. Start the backend with SQL mirroring enabled or run the one-off mirror sync first.`)
  }
}

export async function getDataLabelChannels(): Promise<string[]> {
  await requireTable('model_detection_events')

  const pool = await getPostgresPool()
  const result = await pool.query<{ channel: string }>(`
    SELECT channel::text AS channel
    FROM model_detection_events
    GROUP BY channel
    ORDER BY channel
  `)

  return result.rows.map((row) => row.channel)
}

export async function getDataLabels(params: DataLabelQueryParams = {}): Promise<DataLabelRow[]> {
  await requireTable('model_detection_events')

  const limit = Math.max(1, Math.min(50000, params.limit ?? 50000))
  const channelValue =
    typeof params.channel === 'string' && params.channel !== '' && params.channel !== 'all'
      ? Number.parseInt(params.channel, 10)
      : null

  const pool = await getPostgresPool()
  const result = await pool.query<Record<string, unknown>>(
    `
      SELECT
        channel::text AS channel,
        started_at,
        ended_at,
        duration_sec,
        id,
        is_test,
        user_name
      FROM model_detection_events
      WHERE ($1::int IS NULL OR channel = $1)
      ORDER BY started_at DESC
      LIMIT $2
    `,
    [channelValue, limit],
  )

  return result.rows.map((row) => ({
    channel: String(row.channel),
    startTime: new Date(String(row.started_at)).toISOString(),
    duration: Number(row.duration_sec ?? 0),
    id: String(row.id),
    is_test: Boolean(row.is_test),
    stopTime: new Date(String(row.ended_at)).toISOString(),
    userName: typeof row.user_name === 'string' ? row.user_name : null,
  }))
}
