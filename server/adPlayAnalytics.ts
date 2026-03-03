import { getPostgresPool } from './postgres'

interface CacheEntry<T> {
  data: T
  timestamp: number
}

const TABLE_CACHE_TTL_MS = 5 * 60 * 1000
const tableExistsCache = new Map<string, CacheEntry<boolean>>()

type LeaderboardSortBy = 'plays' | 'duration' | 'frequency'

function shouldUseHourlyRollups(): boolean {
  const value = process.env.AD_PLAY_PREFER_HOURLY_ROLLUPS
  return value === 'true' || value === '1'
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }

  return Number(value ?? 0)
}

function toNullableIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

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

async function requireTable(tableName: string, setupCommand: string): Promise<void> {
  if (!(await tableExists(tableName))) {
    throw new Error(`${tableName} is missing. Start the backend with SQL mirroring enabled or run \`${setupCommand}\` once.`)
  }
}

function calculateFrequency(totalPlays: number, firstPlayedAt: unknown, lastPlayedAt: unknown): number {
  const firstPlayed = firstPlayedAt ? new Date(String(firstPlayedAt)).getTime() : Number.NaN
  const lastPlayed = lastPlayedAt ? new Date(String(lastPlayedAt)).getTime() : Number.NaN

  if (!Number.isFinite(firstPlayed) || !Number.isFinite(lastPlayed)) {
    return totalPlays
  }

  const elapsedDays = Math.max(1, (lastPlayed - firstPlayed) / (1000 * 60 * 60 * 24))
  return Math.round((totalPlays / elapsedDays) * 100) / 100
}

export async function getAggregateSummary(params: { knownDevices: string[] }): Promise<{
  totalPlays: number
  totalPlays24hr: number
  totalPlays7d: number
  totalPlays30d: number
  uniqueAds: number
  totalDuration: number
  activeDevices: number
  avgPlaysPerDevice: number
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const canUseHourlyRollups = shouldUseHourlyRollups() && await tableExists('ad_play_hourly')
  const now = Date.now()
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const result = canUseHourlyRollups
    ? await pool.query<Record<string, unknown>>(`
        SELECT
          COALESCE(SUM(play_count), 0)::bigint AS total_plays,
          COALESCE(SUM(play_count) FILTER (WHERE bucket_end > $1), 0)::bigint AS total_plays_24hr,
          COALESCE(SUM(play_count) FILTER (WHERE bucket_end > $2), 0)::bigint AS total_plays_7d,
          COALESCE(SUM(play_count) FILTER (WHERE bucket_end > $3), 0)::bigint AS total_plays_30d,
          COUNT(DISTINCT ad_filename)::bigint AS unique_ads,
          COALESCE(SUM(total_duration), 0)::double precision AS total_duration
        FROM ad_play_hourly
      `, [oneDayAgo, sevenDaysAgo, thirtyDaysAgo])
    : await pool.query<Record<string, unknown>>(`
        SELECT
          COUNT(*)::bigint AS total_plays,
          COUNT(*) FILTER (WHERE played_at >= $1)::bigint AS total_plays_24hr,
          COUNT(*) FILTER (WHERE played_at >= $2)::bigint AS total_plays_7d,
          COUNT(*) FILTER (WHERE played_at >= $3)::bigint AS total_plays_30d,
          COUNT(DISTINCT ad_filename)::bigint AS unique_ads,
          COALESCE(SUM(play_duration), 0)::double precision AS total_duration
        FROM ad_play_events
      `, [oneDayAgo, sevenDaysAgo, thirtyDaysAgo])

  const row = result.rows[0] ?? {}
  const totalPlays = coerceNumber(row.total_plays)
  const activeDevices = params.knownDevices.length

  return {
    totalPlays,
    totalPlays24hr: coerceNumber(row.total_plays_24hr),
    totalPlays7d: coerceNumber(row.total_plays_7d),
    totalPlays30d: coerceNumber(row.total_plays_30d),
    uniqueAds: coerceNumber(row.unique_ads),
    totalDuration: coerceNumber(row.total_duration),
    activeDevices,
    avgPlaysPerDevice: activeDevices > 0 ? Math.round((totalPlays / activeDevices) * 100) / 100 : 0,
  }
}

export async function getHourlyPatterns(includeDayOfWeek: boolean): Promise<{
  patterns: Array<{
    hour: number
    dayOfWeek?: number
    plays: number
    duration: number
  }>
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const canUseHourlyRollups = shouldUseHourlyRollups() && await tableExists('ad_play_hourly')
  const sourceTable = canUseHourlyRollups ? 'ad_play_hourly' : 'ad_play_events'
  const playedAtColumn = canUseHourlyRollups ? 'bucket_start' : 'played_at'
  const playsExpression = canUseHourlyRollups ? 'SUM(play_count)::bigint' : 'COUNT(*)::bigint'
  const durationExpression = canUseHourlyRollups ? 'COALESCE(SUM(total_duration), 0)::double precision' : 'COALESCE(SUM(play_duration), 0)::double precision'

  const result = await pool.query<Record<string, unknown>>(`
    SELECT
      EXTRACT(HOUR FROM ${playedAtColumn} AT TIME ZONE 'UTC')::int AS hour,
      ${includeDayOfWeek ? `EXTRACT(DOW FROM ${playedAtColumn} AT TIME ZONE 'UTC')::int AS day_of_week,` : ''}
      ${playsExpression} AS plays,
      ${durationExpression} AS duration
    FROM ${sourceTable}
    GROUP BY hour${includeDayOfWeek ? ', day_of_week' : ''}
    ORDER BY ${includeDayOfWeek ? 'day_of_week, ' : ''}hour
  `)

  return {
    patterns: result.rows.map((row) => ({
      hour: coerceNumber(row.hour),
      ...(includeDayOfWeek ? { dayOfWeek: coerceNumber(row.day_of_week) } : {}),
      plays: coerceNumber(row.plays),
      duration: coerceNumber(row.duration),
    })),
  }
}

export async function getDayOfWeekPatterns(): Promise<{
  patterns: Array<{
    dayOfWeek: number
    dayName: string
    plays: number
    duration: number
  }>
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const canUseHourlyRollups = shouldUseHourlyRollups() && await tableExists('ad_play_hourly')
  const sourceTable = canUseHourlyRollups ? 'ad_play_hourly' : 'ad_play_events'
  const playedAtColumn = canUseHourlyRollups ? 'bucket_start' : 'played_at'
  const playsExpression = canUseHourlyRollups ? 'SUM(play_count)::bigint' : 'COUNT(*)::bigint'
  const durationExpression = canUseHourlyRollups ? 'COALESCE(SUM(total_duration), 0)::double precision' : 'COALESCE(SUM(play_duration), 0)::double precision'
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  const result = await pool.query<Record<string, unknown>>(`
    SELECT
      EXTRACT(DOW FROM ${playedAtColumn} AT TIME ZONE 'UTC')::int AS day_of_week,
      ${playsExpression} AS plays,
      ${durationExpression} AS duration
    FROM ${sourceTable}
    GROUP BY day_of_week
    ORDER BY day_of_week
  `)

  return {
    patterns: result.rows.map((row) => {
      const dayOfWeek = coerceNumber(row.day_of_week)
      return {
        dayOfWeek,
        dayName: dayNames[dayOfWeek] ?? String(dayOfWeek),
        plays: coerceNumber(row.plays),
        duration: coerceNumber(row.duration),
      }
    }),
  }
}

export async function getWeekComparison(): Promise<{
  currentWeek: {
    plays: number
    duration: number
    uniqueAds: number
  }
  previousWeek: {
    plays: number
    duration: number
    uniqueAds: number
  }
  change: {
    plays: number
    duration: number
    uniqueAds: number
  }
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const canUseHourlyRollups = shouldUseHourlyRollups() && await tableExists('ad_play_hourly')
  const now = Date.now()
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()
  const result = canUseHourlyRollups
    ? await pool.query<Record<string, unknown>>(`
        SELECT
          COALESCE(SUM(play_count) FILTER (WHERE bucket_end > $1), 0)::bigint AS current_week_plays,
          COALESCE(SUM(total_duration) FILTER (WHERE bucket_end > $1), 0)::double precision AS current_week_duration,
          COUNT(DISTINCT ad_filename) FILTER (WHERE bucket_end > $1)::bigint AS current_week_unique_ads,
          COALESCE(SUM(play_count) FILTER (WHERE bucket_end > $2 AND bucket_end <= $1), 0)::bigint AS previous_week_plays,
          COALESCE(SUM(total_duration) FILTER (WHERE bucket_end > $2 AND bucket_end <= $1), 0)::double precision AS previous_week_duration,
          COUNT(DISTINCT ad_filename) FILTER (WHERE bucket_end > $2 AND bucket_end <= $1)::bigint AS previous_week_unique_ads
        FROM ad_play_hourly
      `, [oneWeekAgo, twoWeeksAgo])
    : await pool.query<Record<string, unknown>>(`
        SELECT
          COUNT(*) FILTER (WHERE played_at >= $1)::bigint AS current_week_plays,
          COALESCE(SUM(play_duration) FILTER (WHERE played_at >= $1), 0)::double precision AS current_week_duration,
          COUNT(DISTINCT ad_filename) FILTER (WHERE played_at >= $1)::bigint AS current_week_unique_ads,
          COUNT(*) FILTER (WHERE played_at >= $2 AND played_at < $1)::bigint AS previous_week_plays,
          COALESCE(SUM(play_duration) FILTER (WHERE played_at >= $2 AND played_at < $1), 0)::double precision AS previous_week_duration,
          COUNT(DISTINCT ad_filename) FILTER (WHERE played_at >= $2 AND played_at < $1)::bigint AS previous_week_unique_ads
        FROM ad_play_events
      `, [oneWeekAgo, twoWeeksAgo])

  const row = result.rows[0] ?? {}
  const currentWeek = {
    plays: coerceNumber(row.current_week_plays),
    duration: coerceNumber(row.current_week_duration),
    uniqueAds: coerceNumber(row.current_week_unique_ads),
  }
  const previousWeek = {
    plays: coerceNumber(row.previous_week_plays),
    duration: coerceNumber(row.previous_week_duration),
    uniqueAds: coerceNumber(row.previous_week_unique_ads),
  }

  return {
    currentWeek,
    previousWeek,
    change: {
      plays: currentWeek.plays - previousWeek.plays,
      duration: currentWeek.duration - previousWeek.duration,
      uniqueAds: currentWeek.uniqueAds - previousWeek.uniqueAds,
    },
  }
}

export async function getAdsLeaderboard(params: { limit: number; sortBy: LeaderboardSortBy }): Promise<{
  ads: Array<{
    adFilename: string
    totalPlays: number
    totalDuration: number
    averageDuration: number
    frequency: number
    deviceCount: number
    lastPlayed: string | null
  }>
  total: number
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const orderByClause = params.sortBy === 'duration'
    ? 'total_duration DESC, ad_filename ASC'
    : params.sortBy === 'frequency'
      ? 'frequency DESC, ad_filename ASC'
      : 'total_plays DESC, ad_filename ASC'

  const pool = await getPostgresPool()
  const canUseHourlyRollups = shouldUseHourlyRollups() && await tableExists('ad_play_hourly')
  const sourceTable = canUseHourlyRollups ? 'ad_play_hourly' : 'ad_play_events'
  const totalPlaysExpression = canUseHourlyRollups ? 'COALESCE(SUM(play_count), 0)::bigint' : 'COUNT(*)::bigint'
  const totalDurationExpression = canUseHourlyRollups ? 'COALESCE(SUM(total_duration), 0)::double precision' : 'COALESCE(SUM(play_duration), 0)::double precision'
  const firstPlayedExpression = canUseHourlyRollups ? 'MIN(first_play_at)' : 'MIN(played_at)'
  const lastPlayedExpression = canUseHourlyRollups ? 'MAX(last_play_at)' : 'MAX(played_at)'

  const result = await pool.query<Record<string, unknown>>(`
    WITH ad_stats AS (
      SELECT
        ad_filename,
        ${totalPlaysExpression} AS total_plays,
        ${totalDurationExpression} AS total_duration,
        COUNT(DISTINCT device_id)::bigint AS device_count,
        ${firstPlayedExpression} AS first_played,
        ${lastPlayedExpression} AS last_played
      FROM ${sourceTable}
      GROUP BY ad_filename
    )
    SELECT
      ad_filename,
      total_plays,
      total_duration,
      total_duration / GREATEST(total_plays, 1) AS average_duration,
      ROUND((
        total_plays::double precision / GREATEST(
          1::double precision,
          EXTRACT(EPOCH FROM (last_played - first_played)) / 86400.0
        )
      )::numeric, 2)::double precision AS frequency,
      device_count,
      last_played
    FROM ad_stats
    ORDER BY ${orderByClause}
    LIMIT $1
  `, [params.limit])

  const totalResult = canUseHourlyRollups
    ? await pool.query<{ total: string }>('SELECT COUNT(DISTINCT ad_filename)::bigint AS total FROM ad_play_hourly')
    : await pool.query<{ total: string }>('SELECT COUNT(DISTINCT ad_filename)::bigint AS total FROM ad_play_events')

  return {
    ads: result.rows.map((row) => ({
      adFilename: String(row.ad_filename),
      totalPlays: coerceNumber(row.total_plays),
      totalDuration: coerceNumber(row.total_duration),
      averageDuration: coerceNumber(row.average_duration),
      frequency: coerceNumber(row.frequency),
      deviceCount: coerceNumber(row.device_count),
      lastPlayed: toNullableIsoString(row.last_played),
    })),
    total: coerceNumber(totalResult.rows[0]?.total),
  }
}

export async function getDevicesComparison(params: { knownDevices: string[] }): Promise<{
  devices: Array<{
    deviceId: string
    totalPlays: number
    avgPlaysPerDay: number
    totalDuration: number
  }>
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const canUseHourlyRollups = shouldUseHourlyRollups() && await tableExists('ad_play_hourly')
  const result = canUseHourlyRollups
    ? await pool.query<Record<string, unknown>>(`
        SELECT
          device_id,
          COALESCE(SUM(play_count), 0)::bigint AS total_plays,
          COALESCE(SUM(total_duration), 0)::double precision AS total_duration,
          MIN(first_play_at) AS first_played,
          MAX(last_play_at) AS last_played
        FROM ad_play_hourly
        GROUP BY device_id
      `)
    : await pool.query<Record<string, unknown>>(`
        SELECT
          device_id,
          COUNT(*)::bigint AS total_plays,
          COALESCE(SUM(play_duration), 0)::double precision AS total_duration,
          MIN(played_at) AS first_played,
          MAX(played_at) AS last_played
        FROM ad_play_events
        GROUP BY device_id
      `)

  const statsByDevice = new Map(result.rows.map((row) => [String(row.device_id), row]))
  const deviceIds = Array.from(new Set<string>([...params.knownDevices, ...statsByDevice.keys()])).sort()

  return {
    devices: deviceIds.map((deviceId) => {
      const row = statsByDevice.get(deviceId)
      const totalPlays = coerceNumber(row?.total_plays)
      return {
        deviceId,
        totalPlays,
        avgPlaysPerDay: calculateFrequency(totalPlays, row?.first_played, row?.last_played),
        totalDuration: coerceNumber(row?.total_duration),
      }
    }),
  }
}

export async function getDeviceAds(params: { deviceId: string }): Promise<{
  deviceId: string
  ads: Array<{
    adFilename: string
    totalPlays: number
    totalDuration: number
    averageDuration: number
    lastPlayed: string | null
  }>
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const canUseHourlyRollups = shouldUseHourlyRollups() && await tableExists('ad_play_hourly')
  const result = canUseHourlyRollups
    ? await pool.query<Record<string, unknown>>(`
        SELECT
          ad_filename,
          COALESCE(SUM(play_count), 0)::bigint AS total_plays,
          COALESCE(SUM(total_duration), 0)::double precision AS total_duration,
          COALESCE(SUM(total_duration), 0)::double precision / GREATEST(COALESCE(SUM(play_count), 0), 1) AS average_duration,
          MAX(last_play_at) AS last_played
        FROM ad_play_hourly
        WHERE device_id = $1
        GROUP BY ad_filename
        ORDER BY total_plays DESC, ad_filename ASC
      `, [params.deviceId])
    : await pool.query<Record<string, unknown>>(`
        SELECT
          ad_filename,
          COUNT(*)::bigint AS total_plays,
          COALESCE(SUM(play_duration), 0)::double precision AS total_duration,
          COALESCE(SUM(play_duration), 0)::double precision / GREATEST(COUNT(*), 1) AS average_duration,
          MAX(played_at) AS last_played
        FROM ad_play_events
        WHERE device_id = $1
        GROUP BY ad_filename
        ORDER BY total_plays DESC, ad_filename ASC
      `, [params.deviceId])

  return {
    deviceId: params.deviceId,
    ads: result.rows.map((row) => ({
      adFilename: String(row.ad_filename),
      totalPlays: coerceNumber(row.total_plays),
      totalDuration: coerceNumber(row.total_duration),
      averageDuration: coerceNumber(row.average_duration),
      lastPlayed: toNullableIsoString(row.last_played),
    })),
  }
}

export async function getDeviceSummary(params: { deviceId: string }): Promise<{
  deviceId: string
  plays24hr: number
  plays1hr: number
  lastPlayTime: string | null
  lastPlayData: Record<string, unknown> | null
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const countsResult = await pool.query<Record<string, unknown>>(`
    SELECT
      COUNT(*) FILTER (WHERE played_at >= NOW() - INTERVAL '24 hours')::bigint AS plays_24hr,
      COUNT(*) FILTER (WHERE played_at >= NOW() - INTERVAL '1 hour')::bigint AS plays_1hr,
      MAX(played_at) AS last_played_at
    FROM ad_play_events
    WHERE device_id = $1
  `, [params.deviceId])
  const latestResult = await pool.query<Record<string, unknown>>(`
    SELECT
      play_id,
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
    FROM ad_play_events
    WHERE device_id = $1
    ORDER BY played_at DESC
    LIMIT 1
  `, [params.deviceId])

  const countsRow = countsResult.rows[0] ?? {}
  const latestRow = latestResult.rows[0]

  return {
    deviceId: params.deviceId,
    plays24hr: coerceNumber(countsRow.plays_24hr),
    plays1hr: coerceNumber(countsRow.plays_1hr),
    lastPlayTime: toNullableIsoString(countsRow.last_played_at),
    lastPlayData: latestRow
      ? {
          play_id: latestRow.play_id,
          ad_filename: latestRow.ad_filename,
          timestamp: toNullableIsoString(latestRow.played_at),
          play_duration: coerceNumber(latestRow.play_duration),
          play_start_time: toNullableIsoString(latestRow.play_start_time),
          play_end_time: toNullableIsoString(latestRow.play_end_time),
          environment: latestRow.environment,
          play_status: latestRow.play_status,
          bug_detected: latestRow.bug_detected,
          switch_type: latestRow.switch_type,
          metadata: latestRow.metadata,
          raw_payload: latestRow.raw_payload,
        }
      : null,
  }
}

export async function getDeviceTimeSeries(params: { deviceId: string }): Promise<{
  deviceId: string
  items: Array<{
    timestamp: string
    ad_filename: string
    play_duration: number
    play_id: string
  }>
  count: number
}> {
  await requireTable('ad_play_events', 'npm run ad-play-analytics:backfill -- --mode all')

  const pool = await getPostgresPool()
  const result = await pool.query<Record<string, unknown>>(`
    SELECT
      played_at,
      ad_filename,
      play_duration,
      play_id
    FROM ad_play_events
    WHERE device_id = $1
    ORDER BY played_at DESC
    LIMIT 50000
  `, [params.deviceId])

  const items = result.rows.map((row) => ({
    timestamp: toNullableIsoString(row.played_at) ?? new Date(0).toISOString(),
    ad_filename: String(row.ad_filename ?? ''),
    play_duration: coerceNumber(row.play_duration),
    play_id: String(row.play_id ?? ''),
  }))

  return {
    deviceId: params.deviceId,
    items,
    count: items.length,
  }
}
