import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBreakComparisons,
  buildRecordingBreakdown,
  clipInterval,
  computePerformanceMetrics,
  createBaselineSummary,
  evaluateAlerts,
  intersectionSeconds,
  mergeRanges,
  normalizeRecordingLookupValue,
  overlapSeconds,
  type ModelInterval,
  type PerformanceMetrics,
  type TruthInterval,
} from '../shared/modelPerformance'
import { dayWindow, parseTimestampInTimeZone } from '../shared/timezone'

function makeTruthInterval(
  sourceId: string,
  channel: string,
  startMs: number,
  endMs: number,
  breakNumber: number,
): TruthInterval {
  return {
    sourceId,
    label: 'truth',
    startMs,
    endMs,
    metadata: {
      channel,
      recordingName: `recording-${channel}`,
      breakNumber,
    },
  }
}

function makeModelInterval(sourceId: string, channel: string, startMs: number, endMs: number): ModelInterval {
  return {
    sourceId,
    label: 'model',
    startMs,
    endMs,
    metadata: {
      channel,
      source: 'sql',
    },
  }
}

function makeMetrics(overrides: Partial<PerformanceMetrics>): PerformanceMetrics {
  return {
    windowStartMs: 0,
    windowEndMs: 60_000,
    groundTruthSeconds: 120,
    modelSeconds: 100,
    overlapSeconds: 80,
    recallBySeconds: 0.8,
    precisionBySeconds: 0.8,
    breakHitRate: 0.8,
    missedSeconds: 40,
    falsePositiveSeconds: 20,
    averageStartLatencySec: 1,
    p95StartLatencySec: 2,
    averageOverCaptureTailSec: 0.5,
    totalGroundTruthBreaks: 5,
    matchedGroundTruthBreaks: 4,
    totalModelIntervals: 5,
    matchedModelIntervals: 4,
    totalGroundTruthRecordings: 1,
    latestTruthBreakAtMs: 60_000,
    latestModelIntervalAtMs: 55_000,
    ...overrides,
  }
}

function assertAlmostEqual(actual: number | null, expected: number, epsilon: number = 0.000001): void {
  assert.notEqual(actual, null)
  assert.ok(Math.abs((actual ?? 0) - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`)
}

test('mergeRanges merges overlapping intervals and preserves gaps', () => {
  const intervals = [
    makeTruthInterval('a', '7', 0, 10_000, 1),
    makeTruthInterval('b', '7', 8_000, 15_000, 2),
    makeTruthInterval('c', '7', 30_000, 40_000, 3),
  ]

  const merged = mergeRanges(intervals)

  assert.deepEqual(merged, [
    { startMs: 0, endMs: 15_000 },
    { startMs: 30_000, endMs: 40_000 },
  ])
})

test('clipInterval and overlap helpers match the Python baseline behavior', () => {
  const interval = makeTruthInterval('truth', '7', 0, 10_000, 1)
  const clipped = clipInterval(interval, 2_000, 7_000)

  assert.ok(clipped)
  assert.equal(clipped?.startMs, 2_000)
  assert.equal(clipped?.endMs, 7_000)
  assert.equal(overlapSeconds(0, 10_000, 5_000, 15_000), 5)
  assert.equal(
    intersectionSeconds(
      [{ startMs: 0, endMs: 10_000 }],
      [{ startMs: 5_000, endMs: 15_000 }],
    ),
    5,
  )
})

test('timezone parsing treats naive DynamoDB timestamps as Australia/Sydney local time', () => {
  const parsed = parseTimestampInTimeZone('2025-10-23T17:51:49.183814', 'Australia/Sydney')

  assert.ok(parsed)
  assert.equal(parsed?.toISOString(), '2025-10-23T06:51:49.183Z')
})

test('dayWindow respects DST changes for Australia/Sydney broadcast days', () => {
  const springForward = dayWindow('2025-10-05', 'Australia/Sydney')
  const fallBack = dayWindow('2025-04-06', 'Australia/Sydney')

  assert.equal((springForward.end.getTime() - springForward.start.getTime()) / 3_600_000, 23)
  assert.equal((fallBack.end.getTime() - fallBack.start.getTime()) / 3_600_000, 25)
})

test('evaluateAlerts triggers recall and model-only warnings only when sample sizes are meaningful', () => {
  const baseline30d = createBaselineSummary('30d', [
    makeMetrics({ recallBySeconds: 0.82, precisionBySeconds: 0.84, breakHitRate: 0.81, falsePositiveSeconds: 18 }),
    makeMetrics({ recallBySeconds: 0.8, precisionBySeconds: 0.83, breakHitRate: 0.8, falsePositiveSeconds: 20 }),
    makeMetrics({ recallBySeconds: 0.78, precisionBySeconds: 0.82, breakHitRate: 0.79, falsePositiveSeconds: 19 }),
  ])
  const baseline7d = createBaselineSummary('7d', [
    makeMetrics({ recallBySeconds: 0.81, precisionBySeconds: 0.83, breakHitRate: 0.8, falsePositiveSeconds: 19 }),
  ])
  const current = makeMetrics({
    recallBySeconds: 0.5,
    precisionBySeconds: 0.54,
    breakHitRate: 0.48,
    falsePositiveSeconds: 55,
    groundTruthSeconds: 180,
    totalGroundTruthBreaks: 6,
    totalModelIntervals: 6,
  })

  const alerts = evaluateAlerts({
    current,
    baseline7d,
    baseline30d,
    latestDetectionAgeMs: 5 * 60 * 1000,
  })

  assert.ok(alerts.some((alert) => alert.metricKey === 'recallBySeconds'))
  assert.ok(alerts.some((alert) => alert.metricKey === 'precisionBySeconds'))
  assert.ok(alerts.some((alert) => alert.metricKey === 'falsePositiveSeconds'))
})

test('integration path computes metrics from truth breaks and normalized model intervals', () => {
  const truthIntervals = [
    makeTruthInterval('truth-1', '9', 0, 30_000, 1),
    makeTruthInterval('truth-2', '9', 60_000, 90_000, 2),
  ]
  const modelIntervals = [
    makeModelInterval('model-1', '9', 2_000, 20_000),
    makeModelInterval('model-2', '9', 65_000, 95_000),
  ]

  const breakComparisons = buildBreakComparisons(truthIntervals, modelIntervals)
  const metrics = computePerformanceMetrics(truthIntervals, modelIntervals, breakComparisons, 0, 120_000)

  assert.equal(breakComparisons.length, 2)
  assert.equal(breakComparisons[0].latencySec, 2)
  assert.equal(breakComparisons[1].overlapSec, 25)
  assert.equal(metrics.groundTruthSeconds, 60)
  assert.equal(metrics.modelSeconds, 48)
  assert.equal(metrics.overlapSeconds, 43)
  assert.equal(metrics.breakHitRate, 1)
  assertAlmostEqual(metrics.recallBySeconds, 43 / 60)
  assertAlmostEqual(metrics.precisionBySeconds, 43 / 48)
  assert.equal(metrics.falsePositiveSeconds, 5)
})

test('normalizeRecordingLookupValue converts wav paths to recording names', () => {
  assert.equal(
    normalizeRecordingLookupValue('/tmp/audio/ch95_20260302_141553.wav'),
    'ch95_20260302_141553.ts',
  )
  assert.equal(
    normalizeRecordingLookupValue('C:\\recordings\\ch7_20251023_010203.WAV'),
    'ch7_20251023_010203.ts',
  )
  assert.equal(
    normalizeRecordingLookupValue('ch9_20251023_010203.ts'),
    'ch9_20251023_010203.ts',
  )
})

test('buildRecordingBreakdown groups multi-recording detail windows by source file', () => {
  const truthIntervals: TruthInterval[] = [
    {
      ...makeTruthInterval('truth-1', '9', 0, 30_000, 1),
      metadata: {
        channel: '9',
        recordingName: 'ch9_20251023_010203.ts',
        breakNumber: 1,
        audioPath: '/recordings/ch9_20251023_010203.wav',
        recordingStartedAt: '2025-10-23T01:02:03.000Z',
      },
    },
    {
      ...makeTruthInterval('truth-2', '9', 60_000, 90_000, 2),
      metadata: {
        channel: '9',
        recordingName: 'ch9_20251023_010203.ts',
        breakNumber: 2,
        audioPath: '/recordings/ch9_20251023_010203.wav',
        recordingStartedAt: '2025-10-23T01:02:03.000Z',
      },
    },
    {
      ...makeTruthInterval('truth-3', '9', 120_000, 180_000, 1),
      metadata: {
        channel: '9',
        recordingName: 'ch9_20251024_020304.ts',
        breakNumber: 1,
        audioPath: '/recordings/ch9_20251024_020304.wav',
        recordingStartedAt: '2025-10-24T02:03:04.000Z',
      },
    },
  ]
  const modelIntervals = [
    makeModelInterval('model-1', '9', 5_000, 20_000),
    makeModelInterval('model-2', '9', 130_000, 150_000),
  ]

  const breakComparisons = buildBreakComparisons(truthIntervals, modelIntervals)
  const recordings = buildRecordingBreakdown(truthIntervals, breakComparisons)

  assert.equal(recordings.length, 2)
  assert.equal(recordings[0].recordingName, 'ch9_20251023_010203.ts')
  assert.equal(recordings[0].totalBreaks, 2)
  assert.equal(recordings[0].matchedBreaks, 1)
  assert.equal(recordings[1].recordingName, 'ch9_20251024_020304.ts')
  assert.equal(recordings[1].matchedBreaks, 1)
})
