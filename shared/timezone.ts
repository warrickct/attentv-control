export const DEFAULT_MODEL_PERFORMANCE_TIMEZONE = 'Australia/Sydney'

interface TimeZoneDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

interface LocalDateTimeParts extends TimeZoneDateParts {
  millisecond: number
}

const ISO_WITH_ZONE_PATTERN = /(?:[zZ]|[+\-]\d{2}:\d{2})$/
const ISO_LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.(\d{1,6}))?)?$/
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) {
    return cached
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  })

  formatterCache.set(timeZone, formatter)
  return formatter
}

function parseDateParts(parts: Intl.DateTimeFormatPart[]): TimeZoneDateParts {
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  }
}

export function getTimeZoneDateParts(date: Date, timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE): TimeZoneDateParts {
  return parseDateParts(getFormatter(timeZone).formatToParts(date))
}

export function getTimeZoneOffsetMs(date: Date, timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE): number {
  const parts = getTimeZoneDateParts(date, timeZone)
  const projected = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    date.getUTCMilliseconds(),
  )

  return projected - date.getTime()
}

function zonedTimeToUtc(parts: LocalDateTimeParts, timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE): Date {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  )

  let offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone)
  let adjusted = utcGuess - offset
  const correctedOffset = getTimeZoneOffsetMs(new Date(adjusted), timeZone)

  if (correctedOffset !== offset) {
    offset = correctedOffset
    adjusted = utcGuess - offset
  }

  return new Date(adjusted)
}

export function parseTimestampInTimeZone(
  value: string | null | undefined,
  timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
): Date | null {
  if (!value) {
    return null
  }

  if (ISO_WITH_ZONE_PATTERN.test(value)) {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }

  const isoMatch = value.match(ISO_LOCAL_PATTERN)
  if (isoMatch) {
    const fraction = isoMatch[8] ? isoMatch[8].slice(0, 3).padEnd(3, '0') : '000'
    return zonedTimeToUtc(
      {
        year: Number(isoMatch[1]),
        month: Number(isoMatch[2]),
        day: Number(isoMatch[3]),
        hour: Number(isoMatch[4]),
        minute: Number(isoMatch[5]),
        second: Number(isoMatch[6] ?? '0'),
        millisecond: Number(fraction),
      },
      timeZone,
    )
  }

  const dateOnlyMatch = value.match(DATE_ONLY_PATTERN)
  if (dateOnlyMatch) {
    return zonedTimeToUtc(
      {
        year: Number(dateOnlyMatch[1]),
        month: Number(dateOnlyMatch[2]),
        day: Number(dateOnlyMatch[3]),
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      },
      timeZone,
    )
  }

  const fallback = new Date(value)
  return Number.isFinite(fallback.getTime()) ? fallback : null
}

export function dayWindow(
  day: string,
  timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
): { start: Date; end: Date } {
  const match = day.match(DATE_ONLY_PATTERN)
  if (!match) {
    throw new Error(`Invalid day format: ${day}`)
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const dayOfMonth = Number(match[3])
  const nextDay = new Date(Date.UTC(year, month - 1, dayOfMonth + 1))

  return {
    start: zonedTimeToUtc(
      { year, month, day: dayOfMonth, hour: 0, minute: 0, second: 0, millisecond: 0 },
      timeZone,
    ),
    end: zonedTimeToUtc(
      {
        year: nextDay.getUTCFullYear(),
        month: nextDay.getUTCMonth() + 1,
        day: nextDay.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
      },
      timeZone,
    ),
  }
}

export function startOfBucket(
  timestampMs: number,
  bucket: '15m' | '1h' | '1d',
  timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
): number {
  const parts = getTimeZoneDateParts(new Date(timestampMs), timeZone)

  let hour = parts.hour
  let minute = parts.minute
  if (bucket === '15m') {
    minute = Math.floor(minute / 15) * 15
  } else if (bucket === '1h') {
    minute = 0
  } else {
    hour = 0
    minute = 0
  }

  return zonedTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    timeZone,
  ).getTime()
}

export function addBucketStart(
  bucketStartMs: number,
  bucket: '15m' | '1h' | '1d',
  timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
): number {
  const parts = getTimeZoneDateParts(new Date(bucketStartMs), timeZone)
  const temp = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    ),
  )

  if (bucket === '15m') {
    temp.setUTCMinutes(temp.getUTCMinutes() + 15)
  } else if (bucket === '1h') {
    temp.setUTCHours(temp.getUTCHours() + 1)
  } else {
    temp.setUTCDate(temp.getUTCDate() + 1)
  }

  return zonedTimeToUtc(
    {
      year: temp.getUTCFullYear(),
      month: temp.getUTCMonth() + 1,
      day: temp.getUTCDate(),
      hour: temp.getUTCHours(),
      minute: temp.getUTCMinutes(),
      second: temp.getUTCSeconds(),
      millisecond: temp.getUTCMilliseconds(),
    },
    timeZone,
  ).getTime()
}

export function formatInTimeZone(
  value: string | number | Date,
  timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(options ?? {}),
  }).format(date)
}

export function toIsoString(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}
