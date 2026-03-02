import {
  DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
  addBucketStart,
  formatInTimeZone,
  getTimeZoneDateParts,
  startOfBucket,
  toIsoString,
} from './timezone'

export const SHORT_TERM_WINDOWS = [
  { key: '15m', label: 'Last 15m', durationMs: 15 * 60 * 1000 },
  { key: '1h', label: 'Last 1h', durationMs: 60 * 60 * 1000 },
  { key: '24h', label: 'Last 24h', durationMs: 24 * 60 * 60 * 1000 },
] as const

export const TREND_RANGES = [
  { key: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
  { key: '90d', label: '90d', durationMs: 90 * 24 * 60 * 60 * 1000 },
  { key: 'custom', label: 'Custom', durationMs: 0 },
] as const

export const TREND_BUCKETS = [
  { key: '15m', label: '15m' },
  { key: '1h', label: 'Hourly' },
  { key: '1d', label: 'Daily' },
] as const

export const METRIC_KEYS = [
  'recallBySeconds',
  'precisionBySeconds',
  'breakHitRate',
  'overlapSeconds',
  'missedSeconds',
  'falsePositiveSeconds',
  'averageStartLatencySec',
  'p95StartLatencySec',
  'averageOverCaptureTailSec',
] as const

export const DURATION_BUCKETS = [
  { key: '0-30s', min: 0, max: 30 },
  { key: '30-60s', min: 30, max: 60 },
  { key: '60-120s', min: 60, max: 120 },
  { key: '120s+', min: 120, max: Number.POSITIVE_INFINITY },
] as const

const MIN_GROUND_TRUTH_SECONDS = 30
const MIN_GROUND_TRUTH_BREAKS = 2
const MIN_MODEL_SECONDS = 30

export type ShortTermWindowKey = (typeof SHORT_TERM_WINDOWS)[number]['key']
export type TrendRangeKey = (typeof TREND_RANGES)[number]['key']
export type TrendBucketKey = (typeof TREND_BUCKETS)[number]['key']
export type PerformanceMetricKey = (typeof METRIC_KEYS)[number]
export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface Interval {
  startMs: number
  endMs: number
  sourceId: string
  label: string
  metadata: Record<string, unknown>
}

export interface TruthInterval extends Interval {
  label: 'truth'
  metadata: {
    channel: string
    recordingId?: number
    recordingName: string
    breakId?: number
    breakNumber: number
    audioPath?: string
    recordingStartedAt?: string
    startOffsetSec?: number
    endOffsetSec?: number
  }
}

export interface ModelInterval extends Interval {
  label: 'model'
  metadata: {
    channel: string
    isTest?: boolean
    userName?: string | null
    rawId?: string
    source?: string
  }
}

export interface MergedRange {
  startMs: number
  endMs: number
}

export interface MatchedModelInterval {
  sourceId: string
  startMs: number
  endMs: number
  overlapSec: number
  userName?: string | null
  isTest?: boolean
}

export interface BreakComparison {
  breakId: string
  channel: string
  recordingName: string
  breakNumber: number
  truthStartMs: number
  truthEndMs: number
  truthDurationSec: number
  overlapSec: number
  capturedPercentage: number
  latencySec: number | null
  overCaptureTailSec: number | null
  missedEntirely: boolean
  matchedModelIntervals: MatchedModelInterval[]
}

export interface PerformanceMetrics {
  windowStartMs: number
  windowEndMs: number
  groundTruthSeconds: number
  modelSeconds: number
  overlapSeconds: number
  recallBySeconds: number
  precisionBySeconds: number
  breakHitRate: number
  missedSeconds: number
  falsePositiveSeconds: number
  averageStartLatencySec: number | null
  p95StartLatencySec: number | null
  averageOverCaptureTailSec: number | null
  totalGroundTruthBreaks: number
  matchedGroundTruthBreaks: number
  totalModelIntervals: number
  matchedModelIntervals: number
  totalGroundTruthRecordings: number
  latestTruthBreakAtMs: number | null
  latestModelIntervalAtMs: number | null
}

export interface PerformanceMetricStatistic {
  average: number | null
  stddev: number | null
  sampleCount: number
}

export type PerformanceMetricBaselines = Record<PerformanceMetricKey, PerformanceMetricStatistic>

export interface BaselineSummary {
  label: '7d' | '30d'
  metrics: PerformanceMetricBaselines
  sampleCount: number
}

export interface PerformanceAlert {
  code: string
  severity: AlertSeverity
  title: string
  description: string
  metricKey: PerformanceMetricKey | 'ingestion'
  currentValue: number | null
  baselineValue: number | null
  stddev: number | null
}

export interface OverviewWindowSummary {
  windowKey: ShortTermWindowKey
  label: string
  current: PerformanceMetrics
  baseline7d: BaselineSummary
  baseline30d: BaselineSummary
  warnings: PerformanceAlert[]
}

export interface OverviewResponse {
  generatedAt: string
  timezone: string
  selectedChannel: string
  activeAlerts: PerformanceAlert[]
  windows: OverviewWindowSummary[]
}

export interface TrendPoint extends PerformanceMetrics {
  bucketKey: TrendBucketKey
  bucketStart: string
  bucketEnd: string
  label: string
  warnings: PerformanceAlert[]
}

export interface TrendsResponse {
  generatedAt: string
  timezone: string
  selectedChannel: string
  rangeKey: TrendRangeKey
  bucketKey: TrendBucketKey
  rangeStart: string
  rangeEnd: string
  points: TrendPoint[]
}

export interface ChannelBreakdownRow {
  channel: string
  shortTermWindowKey: ShortTermWindowKey
  shortTerm: PerformanceMetrics
  baseline7d: BaselineSummary
  baseline30d: BaselineSummary
  deltaVs30dRecall: number | null
  deltaVs30dPrecision: number | null
  warnings: PerformanceAlert[]
  sparkline: Array<{
    bucketStart: string
    recallBySeconds: number
    precisionBySeconds: number
    breakHitRate: number
  }>
}

export interface ChannelBreakdownResponse {
  generatedAt: string
  timezone: string
  shortTermWindowKey: ShortTermWindowKey
  channels: ChannelBreakdownRow[]
}

export interface BreakdownGroup {
  label: string
  truthSeconds: number
  overlapSeconds: number
  recallBySeconds: number
  totalGroundTruthBreaks: number
  matchedGroundTruthBreaks: number
  breakHitRate: number
  averageCapturedPercentage: number
}

export interface ChannelDetailResponse {
  generatedAt: string
  timezone: string
  channel: string
  day: string
  summary: PerformanceMetrics
  groundTruthIntervals: TruthInterval[]
  modelIntervals: ModelInterval[]
  breakComparisons: BreakComparison[]
  hourOfDay: BreakdownGroup[]
  durationBuckets: BreakdownGroup[]
}

export function clipInterval<T extends Interval>(interval: T, windowStartMs: number, windowEndMs: number): T | null {
  const startMs = Math.max(interval.startMs, windowStartMs)
  const endMs = Math.min(interval.endMs, windowEndMs)

  if (endMs <= startMs) {
    return null
  }

  return {
    ...interval,
    startMs,
    endMs,
  }
}

export function mergeRanges(intervals: ReadonlyArray<Interval>): MergedRange[] {
  if (intervals.length === 0) {
    return []
  }

  const ordered = [...intervals]
    .map((interval) => ({ startMs: interval.startMs, endMs: interval.endMs }))
    .sort((left, right) => left.startMs - right.startMs)

  const merged: MergedRange[] = [ordered[0]]
  for (const range of ordered.slice(1)) {
    const last = merged[merged.length - 1]
    if (range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs)
    } else {
      merged.push({ ...range })
    }
  }

  return merged
}

export function overlapSeconds(
  leftStartMs: number,
  leftEndMs: number,
  rightStartMs: number,
  rightEndMs: number,
): number {
  return Math.max(0, Math.min(leftEndMs, rightEndMs) - Math.max(leftStartMs, rightStartMs)) / 1000
}

export function overlapSecondsWithRanges(interval: Interval, ranges: ReadonlyArray<MergedRange>): number {
  return ranges.reduce((total, range) => total + overlapSeconds(interval.startMs, interval.endMs, range.startMs, range.endMs), 0)
}

export function intersectionSeconds(left: ReadonlyArray<MergedRange>, right: ReadonlyArray<MergedRange>): number {
  let total = 0
  let leftIndex = 0
  let rightIndex = 0

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftRange = left[leftIndex]
    const rightRange = right[rightIndex]
    total += overlapSeconds(leftRange.startMs, leftRange.endMs, rightRange.startMs, rightRange.endMs)

    if (leftRange.endMs <= rightRange.endMs) {
      leftIndex += 1
    } else {
      rightIndex += 1
    }
  }

  return total
}

export function totalRangeSeconds(ranges: ReadonlyArray<MergedRange>): number {
  return ranges.reduce((total, range) => total + Math.max(0, range.endMs - range.startMs) / 1000, 0)
}

export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0
  }

  return numerator / denominator
}

function roundNumber(value: number | null, digits: number = 4): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }

  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function average(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) {
    return null
  }

  return values.reduce((total, value) => total + value, 0) / values.length
}

function percentile(values: ReadonlyArray<number>, percentileValue: number): number | null {
  if (values.length === 0) {
    return null
  }

  const ordered = [...values].sort((left, right) => left - right)
  const index = Math.ceil((percentileValue / 100) * ordered.length) - 1
  return ordered[Math.max(0, Math.min(index, ordered.length - 1))]
}

function standardDeviation(values: ReadonlyArray<number>): number | null {
  if (values.length < 2) {
    return null
  }

  const mean = average(values)
  if (mean === null) {
    return null
  }

  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export function buildBreakComparisons(
  truthIntervals: ReadonlyArray<TruthInterval>,
  modelIntervals: ReadonlyArray<ModelInterval>,
): BreakComparison[] {
  const mergedModelRanges = mergeRanges(modelIntervals)

  return [...truthIntervals]
    .sort((left, right) => left.startMs - right.startMs)
    .map((truthInterval) => {
      const matchingIntervals = modelIntervals
        .filter((modelInterval) => overlapSeconds(truthInterval.startMs, truthInterval.endMs, modelInterval.startMs, modelInterval.endMs) > 0)
        .sort((left, right) => left.startMs - right.startMs)

      const overlapSec = overlapSecondsWithRanges(truthInterval, mergedModelRanges)
      const latencySec =
        matchingIntervals.length > 0 ? (matchingIntervals[0].startMs - truthInterval.startMs) / 1000 : null
      const overCaptureTailSec =
        matchingIntervals.length > 0
          ? Math.max(
              0,
              matchingIntervals.reduce((latest, interval) => Math.max(latest, interval.endMs), matchingIntervals[0].endMs) -
                truthInterval.endMs,
            ) / 1000
          : null

      return {
        breakId: truthInterval.sourceId,
        channel: String(truthInterval.metadata.channel),
        recordingName: String(truthInterval.metadata.recordingName),
        breakNumber: Number(truthInterval.metadata.breakNumber),
        truthStartMs: truthInterval.startMs,
        truthEndMs: truthInterval.endMs,
        truthDurationSec: (truthInterval.endMs - truthInterval.startMs) / 1000,
        overlapSec: roundNumber(overlapSec, 4) ?? 0,
        capturedPercentage: roundNumber(percent(overlapSec, (truthInterval.endMs - truthInterval.startMs) / 1000), 4) ?? 0,
        latencySec: roundNumber(latencySec, 4),
        overCaptureTailSec: roundNumber(overCaptureTailSec, 4),
        missedEntirely: overlapSec <= 0,
        matchedModelIntervals: matchingIntervals.map((interval) => ({
          sourceId: interval.sourceId,
          startMs: interval.startMs,
          endMs: interval.endMs,
          overlapSec: roundNumber(
            overlapSeconds(truthInterval.startMs, truthInterval.endMs, interval.startMs, interval.endMs),
            4,
          ) ?? 0,
          userName: typeof interval.metadata.userName === 'string' ? interval.metadata.userName : null,
          isTest: Boolean(interval.metadata.isTest),
        })),
      }
    })
}

export function computePerformanceMetrics(
  truthIntervals: ReadonlyArray<TruthInterval>,
  modelIntervals: ReadonlyArray<ModelInterval>,
  breakComparisons: ReadonlyArray<BreakComparison> = buildBreakComparisons(truthIntervals, modelIntervals),
  windowStartMs: number = truthIntervals[0]?.startMs ?? modelIntervals[0]?.startMs ?? Date.now(),
  windowEndMs: number = truthIntervals[truthIntervals.length - 1]?.endMs ?? modelIntervals[modelIntervals.length - 1]?.endMs ?? Date.now(),
): PerformanceMetrics {
  const mergedTruthRanges = mergeRanges(truthIntervals)
  const mergedModelRanges = mergeRanges(modelIntervals)
  const truthSeconds = totalRangeSeconds(mergedTruthRanges)
  const modelSeconds = totalRangeSeconds(mergedModelRanges)
  const overlapTotalSeconds = intersectionSeconds(mergedTruthRanges, mergedModelRanges)
  const matchedTruthBreaks = breakComparisons.filter((comparison) => comparison.overlapSec > 0).length
  const matchedModelIntervals = modelIntervals.filter((interval) => overlapSecondsWithRanges(interval, mergedTruthRanges) > 0).length
  const latencyValues = breakComparisons
    .map((comparison) => comparison.latencySec)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const overCaptureTailValues = breakComparisons
    .map((comparison) => comparison.overCaptureTailSec)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const uniqueRecordings = new Set(truthIntervals.map((interval) => String(interval.metadata.recordingName)))
  const latestTruthBreakAtMs =
    truthIntervals.length > 0 ? Math.max(...truthIntervals.map((interval) => interval.endMs)) : null
  const latestModelIntervalAtMs =
    modelIntervals.length > 0 ? Math.max(...modelIntervals.map((interval) => interval.endMs)) : null

  return {
    windowStartMs,
    windowEndMs,
    groundTruthSeconds: roundNumber(truthSeconds, 4) ?? 0,
    modelSeconds: roundNumber(modelSeconds, 4) ?? 0,
    overlapSeconds: roundNumber(overlapTotalSeconds, 4) ?? 0,
    recallBySeconds: roundNumber(percent(overlapTotalSeconds, truthSeconds), 6) ?? 0,
    precisionBySeconds: roundNumber(percent(overlapTotalSeconds, modelSeconds), 6) ?? 0,
    breakHitRate: roundNumber(percent(matchedTruthBreaks, breakComparisons.length), 6) ?? 0,
    missedSeconds: roundNumber(Math.max(0, truthSeconds - overlapTotalSeconds), 4) ?? 0,
    falsePositiveSeconds: roundNumber(Math.max(0, modelSeconds - overlapTotalSeconds), 4) ?? 0,
    averageStartLatencySec: roundNumber(average(latencyValues), 4),
    p95StartLatencySec: roundNumber(percentile(latencyValues, 95), 4),
    averageOverCaptureTailSec: roundNumber(average(overCaptureTailValues), 4),
    totalGroundTruthBreaks: breakComparisons.length,
    matchedGroundTruthBreaks: matchedTruthBreaks,
    totalModelIntervals: modelIntervals.length,
    matchedModelIntervals,
    totalGroundTruthRecordings: uniqueRecordings.size,
    latestTruthBreakAtMs,
    latestModelIntervalAtMs,
  }
}

export function emptyPerformanceMetrics(windowStartMs: number, windowEndMs: number): PerformanceMetrics {
  return {
    windowStartMs,
    windowEndMs,
    groundTruthSeconds: 0,
    modelSeconds: 0,
    overlapSeconds: 0,
    recallBySeconds: 0,
    precisionBySeconds: 0,
    breakHitRate: 0,
    missedSeconds: 0,
    falsePositiveSeconds: 0,
    averageStartLatencySec: null,
    p95StartLatencySec: null,
    averageOverCaptureTailSec: null,
    totalGroundTruthBreaks: 0,
    matchedGroundTruthBreaks: 0,
    totalModelIntervals: 0,
    matchedModelIntervals: 0,
    totalGroundTruthRecordings: 0,
    latestTruthBreakAtMs: null,
    latestModelIntervalAtMs: null,
  }
}

function buildMetricStatistic(values: ReadonlyArray<number>): PerformanceMetricStatistic {
  return {
    average: roundNumber(average(values), 6),
    stddev: roundNumber(standardDeviation(values), 6),
    sampleCount: values.length,
  }
}

export function buildMetricBaselines(samples: ReadonlyArray<PerformanceMetrics>): PerformanceMetricBaselines {
  const valueMap = new Map<PerformanceMetricKey, number[]>()
  for (const metricKey of METRIC_KEYS) {
    valueMap.set(metricKey, [])
  }

  for (const sample of samples) {
    for (const metricKey of METRIC_KEYS) {
      const value = sample[metricKey]
      if (typeof value === 'number' && Number.isFinite(value)) {
        valueMap.get(metricKey)?.push(value)
      }
    }
  }

  return Object.fromEntries(
    METRIC_KEYS.map((metricKey) => [metricKey, buildMetricStatistic(valueMap.get(metricKey) ?? [])]),
  ) as PerformanceMetricBaselines
}

export function createBaselineSummary(label: '7d' | '30d', samples: ReadonlyArray<PerformanceMetrics>): BaselineSummary {
  return {
    label,
    metrics: buildMetricBaselines(samples),
    sampleCount: samples.length,
  }
}

function compareAgainstBaseline(
  metricKey: PerformanceMetricKey,
  currentValue: number,
  baseline: BaselineSummary,
): { average: number | null; stddev: number | null; zScore: number | null } {
  const metric = baseline.metrics[metricKey]
  if (metric.average === null) {
    return { average: null, stddev: null, zScore: null }
  }

  if (metric.stddev === null || metric.stddev === 0) {
    return { average: metric.average, stddev: metric.stddev, zScore: null }
  }

  return {
    average: metric.average,
    stddev: metric.stddev,
    zScore: (currentValue - metric.average) / metric.stddev,
  }
}

function pushAlert(
  alerts: PerformanceAlert[],
  alert: PerformanceAlert | null,
): void {
  if (alert) {
    alerts.push(alert)
  }
}

function buildDeviationAlert(
  metricKey: PerformanceMetricKey,
  title: string,
  description: string,
  currentValue: number,
  baseline: BaselineSummary,
  absoluteWarningDrop: number,
  absoluteCriticalDrop: number,
): PerformanceAlert | null {
  const comparison = compareAgainstBaseline(metricKey, currentValue, baseline)
  if (comparison.average === null) {
    return null
  }

  const drop = comparison.average - currentValue
  const zScore = comparison.zScore ?? 0

  if (drop >= absoluteCriticalDrop || zScore <= -3) {
    return {
      code: `${metricKey}-critical`,
      severity: 'critical',
      title,
      description,
      metricKey,
      currentValue,
      baselineValue: comparison.average,
      stddev: comparison.stddev,
    }
  }

  if (drop >= absoluteWarningDrop || zScore <= -2) {
    return {
      code: `${metricKey}-warning`,
      severity: 'warning',
      title,
      description,
      metricKey,
      currentValue,
      baselineValue: comparison.average,
      stddev: comparison.stddev,
    }
  }

  return null
}

export function evaluateAlerts(params: {
  current: PerformanceMetrics
  baseline7d: BaselineSummary
  baseline30d: BaselineSummary
  latestDetectionAgeMs?: number | null
  staleThresholdMs?: number
}): PerformanceAlert[] {
  const { current, baseline7d, baseline30d, latestDetectionAgeMs = null, staleThresholdMs = 30 * 60 * 1000 } = params
  const alerts: PerformanceAlert[] = []
  const baseline = baseline30d.sampleCount > 0 ? baseline30d : baseline7d

  if (current.groundTruthSeconds >= MIN_GROUND_TRUTH_SECONDS || current.totalGroundTruthBreaks >= MIN_GROUND_TRUTH_BREAKS) {
    pushAlert(
      alerts,
      buildDeviationAlert(
        'recallBySeconds',
        'Recall below baseline',
        'Recent recall by seconds is materially below the trailing baseline.',
        current.recallBySeconds,
        baseline,
        0.15,
        0.25,
      ),
    )

    pushAlert(
      alerts,
      buildDeviationAlert(
        'breakHitRate',
        'Break hit rate below baseline',
        'Recent break hit rate is materially below the trailing baseline.',
        current.breakHitRate,
        baseline,
        0.15,
        0.25,
      ),
    )
  }

  if (current.modelSeconds >= MIN_MODEL_SECONDS || current.totalModelIntervals > 0) {
    pushAlert(
      alerts,
      buildDeviationAlert(
        'precisionBySeconds',
        'Precision below baseline',
        'Recent precision by seconds is materially below the trailing baseline.',
        current.precisionBySeconds,
        baseline,
        0.15,
        0.25,
      ),
    )
  }

  const modelOnlyAverage = baseline.metrics.falsePositiveSeconds.average
  if (
    modelOnlyAverage !== null &&
    modelOnlyAverage > 0 &&
    (current.falsePositiveSeconds >= MIN_MODEL_SECONDS || current.totalModelIntervals > 0)
  ) {
    const ratio = current.falsePositiveSeconds / modelOnlyAverage
    if (ratio >= 3) {
      alerts.push({
        code: 'false-positive-seconds-critical',
        severity: 'critical',
        title: 'Model-only seconds spiking',
        description: 'Recent model-only seconds are more than 3x the trailing average.',
        metricKey: 'falsePositiveSeconds',
        currentValue: current.falsePositiveSeconds,
        baselineValue: modelOnlyAverage,
        stddev: baseline.metrics.falsePositiveSeconds.stddev,
      })
    } else if (ratio >= 2) {
      alerts.push({
        code: 'false-positive-seconds-warning',
        severity: 'warning',
        title: 'Model-only seconds elevated',
        description: 'Recent model-only seconds are more than 2x the trailing average.',
        metricKey: 'falsePositiveSeconds',
        currentValue: current.falsePositiveSeconds,
        baselineValue: modelOnlyAverage,
        stddev: baseline.metrics.falsePositiveSeconds.stddev,
      })
    }
  }

  if (current.totalGroundTruthBreaks >= MIN_GROUND_TRUTH_BREAKS && current.totalModelIntervals === 0) {
    alerts.push({
      code: 'no-recent-model-detections',
      severity: 'critical',
      title: 'No recent model detections',
      description: 'Ground truth breaks are present but the model produced no recent detections.',
      metricKey: 'ingestion',
      currentValue: 0,
      baselineValue: null,
      stddev: null,
    })
  } else if (latestDetectionAgeMs !== null && latestDetectionAgeMs > staleThresholdMs * 2) {
    alerts.push({
      code: 'stale-model-ingestion',
      severity: latestDetectionAgeMs > staleThresholdMs * 4 ? 'critical' : 'warning',
      title: 'Model ingestion appears stale',
      description: 'The latest model interval is older than the expected freshness threshold.',
      metricKey: 'ingestion',
      currentValue: latestDetectionAgeMs / 1000,
      baselineValue: staleThresholdMs / 1000,
      stddev: null,
    })
  }

  return alerts
}

function formatBucketLabel(bucketStartMs: number, bucketKey: TrendBucketKey, timeZone: string): string {
  if (bucketKey === '1d') {
    return formatInTimeZone(bucketStartMs, timeZone, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  if (bucketKey === '1h') {
    return formatInTimeZone(bucketStartMs, timeZone, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return formatInTimeZone(bucketStartMs, timeZone, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function buildTrendPoints(params: {
  truthIntervals: ReadonlyArray<TruthInterval>
  modelIntervals: ReadonlyArray<ModelInterval>
  breakComparisons?: ReadonlyArray<BreakComparison>
  rangeStartMs: number
  rangeEndMs: number
  bucketKey: TrendBucketKey
  timeZone?: string
}): TrendPoint[] {
  const {
    truthIntervals,
    modelIntervals,
    breakComparisons = buildBreakComparisons(truthIntervals, modelIntervals),
    rangeStartMs,
    rangeEndMs,
    bucketKey,
    timeZone = DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
  } = params

  const points: TrendPoint[] = []
  let bucketStartMs = startOfBucket(rangeStartMs, bucketKey, timeZone)

  while (bucketStartMs < rangeEndMs) {
    const bucketEndMs = Math.min(addBucketStart(bucketStartMs, bucketKey, timeZone), rangeEndMs)
    const clippedTruth = truthIntervals
      .map((interval) => clipInterval(interval, bucketStartMs, bucketEndMs))
      .filter((interval): interval is TruthInterval => interval !== null)
    const clippedModel = modelIntervals
      .map((interval) => clipInterval(interval, bucketStartMs, bucketEndMs))
      .filter((interval): interval is ModelInterval => interval !== null)
    const bucketBreakComparisons = breakComparisons.filter(
      (comparison) => comparison.truthStartMs >= bucketStartMs && comparison.truthStartMs < bucketEndMs,
    )
    const metrics =
      clippedTruth.length > 0 || clippedModel.length > 0 || bucketBreakComparisons.length > 0
        ? computePerformanceMetrics(clippedTruth, clippedModel, bucketBreakComparisons, bucketStartMs, bucketEndMs)
        : emptyPerformanceMetrics(bucketStartMs, bucketEndMs)

    points.push({
      ...metrics,
      bucketKey,
      bucketStart: toIsoString(bucketStartMs),
      bucketEnd: toIsoString(bucketEndMs),
      label: formatBucketLabel(bucketStartMs, bucketKey, timeZone),
      warnings: [],
    })
    bucketStartMs = bucketEndMs
  }

  return points
}

export function buildHourOfDayBreakdown(
  breakComparisons: ReadonlyArray<BreakComparison>,
  timeZone: string = DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
): BreakdownGroup[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const comparisons = breakComparisons.filter(
      (comparison) => getTimeZoneDateParts(new Date(comparison.truthStartMs), timeZone).hour === hour,
    )
    const truthSeconds = comparisons.reduce((total, comparison) => total + comparison.truthDurationSec, 0)
    const overlapSeconds = comparisons.reduce((total, comparison) => total + comparison.overlapSec, 0)
    const matchedGroundTruthBreaks = comparisons.filter((comparison) => comparison.overlapSec > 0).length
    const averageCapturedPercentage = average(comparisons.map((comparison) => comparison.capturedPercentage)) ?? 0

    return {
      label: `${hour.toString().padStart(2, '0')}:00`,
      truthSeconds: roundNumber(truthSeconds, 4) ?? 0,
      overlapSeconds: roundNumber(overlapSeconds, 4) ?? 0,
      recallBySeconds: roundNumber(percent(overlapSeconds, truthSeconds), 6) ?? 0,
      totalGroundTruthBreaks: comparisons.length,
      matchedGroundTruthBreaks,
      breakHitRate: roundNumber(percent(matchedGroundTruthBreaks, comparisons.length), 6) ?? 0,
      averageCapturedPercentage: roundNumber(averageCapturedPercentage, 6) ?? 0,
    }
  })
}

export function durationBucketFor(seconds: number): string {
  return (
    DURATION_BUCKETS.find((bucket) => seconds >= bucket.min && seconds < bucket.max)?.key ??
    DURATION_BUCKETS[DURATION_BUCKETS.length - 1].key
  )
}

export function buildDurationBreakdown(breakComparisons: ReadonlyArray<BreakComparison>): BreakdownGroup[] {
  return DURATION_BUCKETS.map((bucket) => {
    const comparisons = breakComparisons.filter((comparison) => durationBucketFor(comparison.truthDurationSec) === bucket.key)
    const truthSeconds = comparisons.reduce((total, comparison) => total + comparison.truthDurationSec, 0)
    const overlapSeconds = comparisons.reduce((total, comparison) => total + comparison.overlapSec, 0)
    const matchedGroundTruthBreaks = comparisons.filter((comparison) => comparison.overlapSec > 0).length

    return {
      label: bucket.key,
      truthSeconds: roundNumber(truthSeconds, 4) ?? 0,
      overlapSeconds: roundNumber(overlapSeconds, 4) ?? 0,
      recallBySeconds: roundNumber(percent(overlapSeconds, truthSeconds), 6) ?? 0,
      totalGroundTruthBreaks: comparisons.length,
      matchedGroundTruthBreaks,
      breakHitRate: roundNumber(percent(matchedGroundTruthBreaks, comparisons.length), 6) ?? 0,
      averageCapturedPercentage: roundNumber(
        average(comparisons.map((comparison) => comparison.capturedPercentage)) ?? 0,
        6,
      ) ?? 0,
    }
  })
}

export function summarizeWindowComparisons(params: {
  current: PerformanceMetrics
  baseline7dSamples: ReadonlyArray<PerformanceMetrics>
  baseline30dSamples: ReadonlyArray<PerformanceMetrics>
  windowKey: ShortTermWindowKey
  latestDetectionAgeMs?: number | null
}): OverviewWindowSummary {
  const baseline7d = createBaselineSummary('7d', params.baseline7dSamples)
  const baseline30d = createBaselineSummary('30d', params.baseline30dSamples)
  const warnings = evaluateAlerts({
    current: params.current,
    baseline7d,
    baseline30d,
    latestDetectionAgeMs: params.latestDetectionAgeMs,
    staleThresholdMs: SHORT_TERM_WINDOWS.find((window) => window.key === params.windowKey)?.durationMs ?? 30 * 60 * 1000,
  })

  return {
    windowKey: params.windowKey,
    label: SHORT_TERM_WINDOWS.find((window) => window.key === params.windowKey)?.label ?? params.windowKey,
    current: params.current,
    baseline7d,
    baseline30d,
    warnings,
  }
}
