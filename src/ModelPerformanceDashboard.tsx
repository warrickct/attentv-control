import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  ChannelBreakdownResponse,
  ChannelDetailResponse,
  DetailScopeType,
  OverviewResponse,
  PerformanceAlert,
  ShortTermWindowKey,
  TrendBucketKey,
  TrendRangeKey,
  TrendsResponse,
} from '../shared/modelPerformance'
import {
  DETAIL_SCOPES,
  SHORT_TERM_WINDOWS,
  TREND_BUCKETS,
  TREND_RANGES,
} from '../shared/modelPerformance'
import {
  DEFAULT_MODEL_PERFORMANCE_TIMEZONE,
  getTimeZoneDateParts,
} from '../shared/timezone'
import { API_URL, apiFetch } from './api'

const TREND_CHARTS: Array<{
  key: string
  title: string
  dataKey: string
  color: string
  type: 'percent' | 'seconds'
}> = [
  { key: 'recall', title: 'Recall by Seconds', dataKey: 'recallBySecondsPct', color: '#1976d2', type: 'percent' },
  { key: 'precision', title: 'Precision by Seconds', dataKey: 'precisionBySecondsPct', color: '#2e7d32', type: 'percent' },
  { key: 'breakHitRate', title: 'Break Hit Rate', dataKey: 'breakHitRatePct', color: '#f9a825', type: 'percent' },
  { key: 'missedSeconds', title: 'Missed Ground-Truth Seconds', dataKey: 'missedSeconds', color: '#d32f2f', type: 'seconds' },
  { key: 'modelOnly', title: 'Model-Only Seconds', dataKey: 'falsePositiveSeconds', color: '#6a1b9a', type: 'seconds' },
  { key: 'latency', title: 'Average Start Latency', dataKey: 'averageStartLatencySec', color: '#455a64', type: 'seconds' },
]

function getTodayInTimeZone(timeZone: string): string {
  const parts = getTimeZoneDateParts(new Date(), timeZone)
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day
    .toString()
    .padStart(2, '0')}`
}

function formatPercent(value: number | null | undefined, digits: number = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'N/A'
  }

  return `${(value * 100).toFixed(digits)}%`
}

function formatDeltaPercentPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'N/A'
  }

  const delta = value * 100
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toFixed(1)}pp`
}

function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'N/A'
  }

  const absolute = Math.abs(value)
  if (absolute >= 3600) {
    return `${(value / 3600).toFixed(1)}h`
  }
  if (absolute >= 60) {
    return `${(value / 60).toFixed(1)}m`
  }
  return `${value.toFixed(1)}s`
}

function formatDateTime(value: string | number | null | undefined, timeZone: string): string {
  if (!value) {
    return 'N/A'
  }

  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatTimeOnly(value: string | number | null | undefined, timeZone: string): string {
  if (!value) {
    return 'N/A'
  }

  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function severityClass(severity: PerformanceAlert['severity']): string {
  return `alert-chip ${severity}`
}

function metricDeltaClass(current: number | null | undefined, baseline: number | null | undefined): string {
  if (
    current === null ||
    current === undefined ||
    baseline === null ||
    baseline === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(baseline)
  ) {
    return ''
  }

  return current >= baseline ? 'positive' : 'negative'
}

function TimelineLane({
  label,
  intervals,
  rangeStartMs,
  rangeEndMs,
  colorClass,
  timeZone,
}: {
  label: string
  intervals: Array<{ sourceId: string; startMs: number; endMs: number }>
  rangeStartMs: number
  rangeEndMs: number
  colorClass: string
  timeZone: string
}) {
  const durationMs = Math.max(1, rangeEndMs - rangeStartMs)

  return (
    <div className="timeline-lane">
      <div className="timeline-lane-label">{label}</div>
      <div className="timeline-lane-track">
        {intervals.map((interval) => {
          const left = ((interval.startMs - rangeStartMs) / durationMs) * 100
          const width = Math.max(0.5, ((interval.endMs - interval.startMs) / durationMs) * 100)
          return (
            <div
              key={interval.sourceId}
              className={`timeline-bar ${colorClass}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${interval.sourceId}: ${formatTimeOnly(interval.startMs, timeZone)} - ${formatTimeOnly(
                interval.endMs,
                timeZone,
              )}`}
            />
          )
        })}
      </div>
    </div>
  )
}

function TimelineAxis({
  rangeStartMs,
  rangeEndMs,
  timeZone,
}: {
  rangeStartMs: number
  rangeEndMs: number
  timeZone: string
}) {
  const markers = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4
    return {
      label: formatTimeOnly(rangeStartMs + (rangeEndMs - rangeStartMs) * ratio, timeZone),
      left: ratio * 100,
    }
  })

  return (
    <div className="timeline-axis">
      {markers.map((marker) => (
        <div key={marker.label} className="timeline-axis-marker" style={{ left: `${marker.left}%` }}>
          <span>{marker.label}</span>
        </div>
      ))}
    </div>
  )
}

function MetricChartCard({
  title,
  data,
  dataKey,
  color,
  type,
}: {
  title: string
  data: Array<Record<string, unknown>>
  dataKey: string
  color: string
  type: 'percent' | 'seconds'
}) {
  return (
    <div className="chart-item">
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" minTickGap={24} />
          <YAxis tickFormatter={(value) => (type === 'percent' ? `${value.toFixed(0)}%` : formatSeconds(value))} />
          <Tooltip
            formatter={(value: number) =>
              type === 'percent' ? [`${value.toFixed(2)}%`, title] : [formatSeconds(value), title]
            }
            labelFormatter={(value) => `Bucket: ${value}`}
          />
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function ChannelSparkline({
  data,
}: {
  data: Array<{ bucketStart: string; recallBySeconds: number }>
}) {
  const sparklineData = data.map((point) => ({
    label: point.bucketStart,
    recallBySecondsPct: point.recallBySeconds * 100,
  }))

  return (
    <div className="sparkline-cell">
      <ResponsiveContainer width="100%" height={42}>
        <LineChart data={sparklineData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <Line type="monotone" dataKey="recallBySecondsPct" stroke="#1976d2" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function OverviewWindowCard({
  window,
}: {
  window: OverviewResponse['windows'][number]
}) {
  const current = window.current
  const baseline7d = window.baseline7d.metrics
  const baseline30d = window.baseline30d.metrics

  return (
    <div className="model-window-card">
      <div className="model-window-header">
        <div>
          <h3>{window.label}</h3>
          <p>Current performance vs 7d and 30d baselines</p>
        </div>
        <div className="alert-chip-list">
          {window.warnings.length === 0 ? (
            <span className="alert-chip info">Healthy</span>
          ) : (
            window.warnings.map((warning) => (
              <span key={`${window.windowKey}-${warning.code}`} className={severityClass(warning.severity)}>
                {warning.title}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="model-kpi-grid">
        <div className="model-kpi-card">
          <div className="summary-label">Recall by Seconds</div>
          <div className="summary-value small">{formatPercent(current.recallBySeconds)}</div>
          <div className="model-kpi-baselines">
            <span className={metricDeltaClass(current.recallBySeconds, baseline7d.recallBySeconds.average)}>
              7d {formatPercent(baseline7d.recallBySeconds.average)}
            </span>
            <span className={metricDeltaClass(current.recallBySeconds, baseline30d.recallBySeconds.average)}>
              30d {formatPercent(baseline30d.recallBySeconds.average)}
            </span>
          </div>
        </div>
        <div className="model-kpi-card">
          <div className="summary-label">Precision by Seconds</div>
          <div className="summary-value small">{formatPercent(current.precisionBySeconds)}</div>
          <div className="model-kpi-baselines">
            <span className={metricDeltaClass(current.precisionBySeconds, baseline7d.precisionBySeconds.average)}>
              7d {formatPercent(baseline7d.precisionBySeconds.average)}
            </span>
            <span className={metricDeltaClass(current.precisionBySeconds, baseline30d.precisionBySeconds.average)}>
              30d {formatPercent(baseline30d.precisionBySeconds.average)}
            </span>
          </div>
        </div>
        <div className="model-kpi-card">
          <div className="summary-label">Break Hit Rate</div>
          <div className="summary-value small">{formatPercent(current.breakHitRate)}</div>
          <div className="model-kpi-baselines">
            <span className={metricDeltaClass(current.breakHitRate, baseline7d.breakHitRate.average)}>
              7d {formatPercent(baseline7d.breakHitRate.average)}
            </span>
            <span className={metricDeltaClass(current.breakHitRate, baseline30d.breakHitRate.average)}>
              30d {formatPercent(baseline30d.breakHitRate.average)}
            </span>
          </div>
        </div>
        <div className="model-kpi-card">
          <div className="summary-label">Overlap Seconds</div>
          <div className="summary-value small">{formatSeconds(current.overlapSeconds)}</div>
        </div>
        <div className="model-kpi-card">
          <div className="summary-label">Missed Truth Seconds</div>
          <div className="summary-value small">{formatSeconds(current.missedSeconds)}</div>
        </div>
        <div className="model-kpi-card">
          <div className="summary-label">Model-Only Seconds</div>
          <div className="summary-value small">{formatSeconds(current.falsePositiveSeconds)}</div>
        </div>
        <div className="model-kpi-card">
          <div className="summary-label">Avg Start Latency</div>
          <div className="summary-value small">{formatSeconds(current.averageStartLatencySec)}</div>
        </div>
      </div>
    </div>
  )
}

export default function ModelPerformanceDashboard() {
  const [channels, setChannels] = useState<string[]>([])
  const [timezone, setTimezone] = useState<string>(DEFAULT_MODEL_PERFORMANCE_TIMEZONE)
  const [selectedChannel, setSelectedChannel] = useState<string>('all')
  const [trendRange, setTrendRange] = useState<TrendRangeKey>('30d')
  const [trendBucket, setTrendBucket] = useState<TrendBucketKey>('1h')
  const [customStartDate, setCustomStartDate] = useState<string>('')
  const [customEndDate, setCustomEndDate] = useState<string>('')
  const [shortWindow, setShortWindow] = useState<ShortTermWindowKey>('1h')
  const [detailScope, setDetailScope] = useState<DetailScopeType>('day')
  const [detailChannel, setDetailChannel] = useState<string | null>(null)
  const [detailDay, setDetailDay] = useState<string>(getTodayInTimeZone(DEFAULT_MODEL_PERFORMANCE_TIMEZONE))
  const [detailStartDate, setDetailStartDate] = useState<string>(getTodayInTimeZone(DEFAULT_MODEL_PERFORMANCE_TIMEZONE))
  const [detailEndDate, setDetailEndDate] = useState<string>(getTodayInTimeZone(DEFAULT_MODEL_PERFORMANCE_TIMEZONE))
  const [detailRecordingInput, setDetailRecordingInput] = useState<string>('')
  const [detailWindowSeconds, setDetailWindowSeconds] = useState<number>(1800)
  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [trends, setTrends] = useState<TrendsResponse | null>(null)
  const [channelBreakdown, setChannelBreakdown] = useState<ChannelBreakdownResponse | null>(null)
  const [channelDetail, setChannelDetail] = useState<ChannelDetailResponse | null>(null)
  const [loadingFilters, setLoadingFilters] = useState<boolean>(true)
  const [loadingOverview, setLoadingOverview] = useState<boolean>(true)
  const [loadingTrends, setLoadingTrends] = useState<boolean>(true)
  const [loadingBreakdown, setLoadingBreakdown] = useState<boolean>(true)
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshIndex, setRefreshIndex] = useState<number>(0)

  useEffect(() => {
    const fetchFilters = async () => {
      try {
        setLoadingFilters(true)
        const response = await apiFetch(`${API_URL}/api/model-performance/filters`)
        if (!response.ok) {
          throw new Error('Failed to fetch model performance filters')
        }
        const data = await response.json()
        const resolvedTimeZone = data.timezone || DEFAULT_MODEL_PERFORMANCE_TIMEZONE
        setChannels(data.channels || [])
        setTimezone(resolvedTimeZone)
        setDetailDay((currentValue) => currentValue || getTodayInTimeZone(resolvedTimeZone))
        setDetailStartDate((currentValue) => currentValue || getTodayInTimeZone(resolvedTimeZone))
        setDetailEndDate((currentValue) => currentValue || getTodayInTimeZone(resolvedTimeZone))
      } catch (err: any) {
        setError(err.message || 'Failed to fetch model performance filters')
      } finally {
        setLoadingFilters(false)
      }
    }

    fetchFilters()
  }, [])

  useEffect(() => {
    if (selectedChannel !== 'all') {
      setDetailChannel(selectedChannel)
    }
  }, [selectedChannel])

  useEffect(() => {
    if (!detailDay) {
      setDetailDay(getTodayInTimeZone(timezone))
    }
    if (!detailStartDate) {
      setDetailStartDate(getTodayInTimeZone(timezone))
    }
    if (!detailEndDate) {
      setDetailEndDate(getTodayInTimeZone(timezone))
    }
  }, [detailDay, detailEndDate, detailStartDate, timezone])

  useEffect(() => {
    const fetchOverview = async () => {
      try {
        setLoadingOverview(true)
        setError(null)
        const params = new URLSearchParams({
          channel: selectedChannel,
          timezone,
          refresh: refreshIndex > 0 ? 'true' : 'false',
        })
        const response = await apiFetch(`${API_URL}/api/model-performance/overview?${params.toString()}`)
        if (!response.ok) {
          throw new Error('Failed to fetch model performance overview')
        }
        const data = await response.json()
        setOverview(data)
      } catch (err: any) {
        setError(err.message || 'Failed to fetch model performance overview')
      } finally {
        setLoadingOverview(false)
      }
    }

    fetchOverview()
  }, [selectedChannel, timezone, refreshIndex])

  useEffect(() => {
    const fetchTrends = async () => {
      try {
        setLoadingTrends(true)
        setError(null)
        const params = new URLSearchParams({
          channel: selectedChannel,
          timezone,
          range: trendRange,
          bucket: trendBucket,
        })
        if (trendRange === 'custom' && customStartDate && customEndDate) {
          params.set('start', customStartDate)
          params.set('end', customEndDate)
        }
        const response = await apiFetch(`${API_URL}/api/model-performance/trends?${params.toString()}`)
        if (!response.ok) {
          throw new Error('Failed to fetch model performance trends')
        }
        const data = await response.json()
        setTrends(data)
      } catch (err: any) {
        setError(err.message || 'Failed to fetch model performance trends')
      } finally {
        setLoadingTrends(false)
      }
    }

    if (trendRange !== 'custom' || (customStartDate && customEndDate)) {
      fetchTrends()
    }
  }, [selectedChannel, timezone, trendRange, trendBucket, customStartDate, customEndDate, refreshIndex])

  useEffect(() => {
    const fetchBreakdown = async () => {
      try {
        setLoadingBreakdown(true)
        setError(null)
        const params = new URLSearchParams({
          timezone,
          shortWindow,
          refresh: refreshIndex > 0 ? 'true' : 'false',
        })
        const response = await apiFetch(`${API_URL}/api/model-performance/channels?${params.toString()}`)
        if (!response.ok) {
          throw new Error('Failed to fetch channel breakdown')
        }
        const data = await response.json()
        setChannelBreakdown(data)
      } catch (err: any) {
        setError(err.message || 'Failed to fetch channel breakdown')
      } finally {
        setLoadingBreakdown(false)
      }
    }

    fetchBreakdown()
  }, [timezone, shortWindow, refreshIndex])

  useEffect(() => {
    if (detailScope !== 'recording' && !detailChannel) {
      return
    }

    if (detailScope === 'range' && (!detailStartDate || !detailEndDate)) {
      return
    }

    if (detailScope === 'recording' && !detailRecordingInput.trim()) {
      setChannelDetail(null)
      return
    }

    const fetchDetail = async () => {
      try {
        setLoadingDetail(true)
        setError(null)
        const params = new URLSearchParams({
          timezone,
          scope: detailScope,
          refresh: refreshIndex > 0 ? 'true' : 'false',
        })
        if (detailScope === 'day') {
          params.set('channel', detailChannel ?? 'all')
          params.set('day', detailDay)
        } else if (detailScope === 'range') {
          params.set('channel', detailChannel ?? 'all')
          params.set('start', detailStartDate)
          params.set('end', detailEndDate)
        } else {
          params.set('recording', detailRecordingInput.trim())
          params.set('windowSeconds', String(detailWindowSeconds))
        }
        const response = await apiFetch(
          `${API_URL}/api/model-performance/detail?${params.toString()}`,
        )
        if (!response.ok) {
          const payload = await response.json().catch(() => null)
          throw new Error(payload?.error || 'Failed to fetch channel detail')
        }
        const data = await response.json()
        setChannelDetail(data)
      } catch (err: any) {
        setError(err.message || 'Failed to fetch channel detail')
      } finally {
        setLoadingDetail(false)
      }
    }

    fetchDetail()
  }, [
    detailChannel,
    detailDay,
    detailEndDate,
    detailRecordingInput,
    detailScope,
    detailStartDate,
    detailWindowSeconds,
    timezone,
    refreshIndex,
  ])

  useEffect(() => {
    if (!detailChannel && channelBreakdown && channelBreakdown.channels.length > 0) {
      setDetailChannel(channelBreakdown.channels[0].channel)
    }
  }, [detailChannel, channelBreakdown])

  const trendChartData = useMemo(
    () =>
      (trends?.points || []).map((point) => ({
        label: point.label,
        recallBySecondsPct: point.recallBySeconds * 100,
        precisionBySecondsPct: point.precisionBySeconds * 100,
        breakHitRatePct: point.breakHitRate * 100,
        missedSeconds: point.missedSeconds,
        falsePositiveSeconds: point.falsePositiveSeconds,
        averageStartLatencySec: point.averageStartLatencySec ?? 0,
      })),
    [trends],
  )

  const selectedBreakdownRow = useMemo(
    () => channelBreakdown?.channels.find((row) => row.channel === (channelDetail?.channel ?? detailChannel)) ?? null,
    [channelBreakdown, channelDetail?.channel, detailChannel],
  )

  const detailWindow = useMemo(() => {
    if (!channelDetail) {
      return null
    }

    return {
      startMs: new Date(channelDetail.scope.windowStart).getTime(),
      endMs: new Date(channelDetail.scope.windowEnd).getTime(),
    }
  }, [channelDetail])

  if (loadingFilters) {
    return <div className="loading">Loading model performance filters...</div>
  }

  return (
    <div className="model-performance-dashboard">
      <div className="aggregate-dashboard">
        <div className="leaderboard-header">
          <div>
            <h2>Model Performance</h2>
            <p className="model-performance-subtitle">
              Compares model detections against comskip ground truth using server-side SQL and normalized interval data.
            </p>
          </div>
          <div className="refresh-controls">
            <button className="refresh-button" onClick={() => setRefreshIndex((value) => value + 1)}>
              Refresh
            </button>
          </div>
        </div>

        <div className="graph-controls">
          <div className="control-group">
            <label htmlFor="model-channel-select">Channel</label>
            <select
              id="model-channel-select"
              className="control-select"
              value={selectedChannel}
              onChange={(event) => setSelectedChannel(event.target.value)}
            >
              <option value="all">All channels</option>
              {channels.map((channel) => (
                <option key={channel} value={channel}>
                  Channel {channel}
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="model-range-select">Trend range</label>
            <select
              id="model-range-select"
              className="control-select"
              value={trendRange}
              onChange={(event) => setTrendRange(event.target.value as TrendRangeKey)}
            >
              {TREND_RANGES.map((range) => (
                <option key={range.key} value={range.key}>
                  {range.label}
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="model-bucket-select">Bucket</label>
            <select
              id="model-bucket-select"
              className="control-select"
              value={trendBucket}
              onChange={(event) => setTrendBucket(event.target.value as TrendBucketKey)}
            >
              {TREND_BUCKETS.map((bucket) => (
                <option key={bucket.key} value={bucket.key}>
                  {bucket.label}
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="model-short-window-select">Breakdown window</label>
            <select
              id="model-short-window-select"
              className="control-select"
              value={shortWindow}
              onChange={(event) => setShortWindow(event.target.value as ShortTermWindowKey)}
            >
              {SHORT_TERM_WINDOWS.map((window) => (
                <option key={window.key} value={window.key}>
                  {window.label}
                </option>
              ))}
            </select>
          </div>

          {trendRange === 'custom' && (
            <>
              <div className="control-group">
                <label htmlFor="model-start-date">Start</label>
                <input
                  id="model-start-date"
                  className="control-select"
                  type="date"
                  value={customStartDate}
                  onChange={(event) => setCustomStartDate(event.target.value)}
                />
              </div>
              <div className="control-group">
                <label htmlFor="model-end-date">End</label>
                <input
                  id="model-end-date"
                  className="control-select"
                  type="date"
                  value={customEndDate}
                  onChange={(event) => setCustomEndDate(event.target.value)}
                />
              </div>
            </>
          )}

          <div className="control-info">
            <span>Timezone: {timezone}</span>
            <span>Server-only access</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="error">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="insights-section">
        <h2>Overview</h2>
        {loadingOverview ? (
          <div className="loading model-loading">Loading overview...</div>
        ) : !overview ? (
          <div className="empty-state">No overview data available.</div>
        ) : (
          <>
            <div className="model-alerts-strip">
              {overview.activeAlerts.length === 0 ? (
                <div className="insights-callout">No active alerts for the selected scope.</div>
              ) : (
                overview.activeAlerts.map((alert) => (
                  <div key={`${alert.code}-${alert.severity}`} className={`model-alert-card ${alert.severity}`}>
                    <div className="model-alert-header">
                      <span className={severityClass(alert.severity)}>{alert.severity}</span>
                      <strong>{alert.title}</strong>
                    </div>
                    <p>{alert.description}</p>
                    <div className="model-alert-metrics">
                      <span>Current: {alert.metricKey === 'ingestion' ? formatSeconds(alert.currentValue) : formatPercent(alert.currentValue)}</span>
                      <span>Baseline: {alert.metricKey === 'ingestion' ? formatSeconds(alert.baselineValue) : formatPercent(alert.baselineValue)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="model-window-grid">
              {overview.windows.map((window) => (
                <OverviewWindowCard key={window.windowKey} window={window} />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="insights-section">
        <h2>Trends</h2>
        {loadingTrends ? (
          <div className="loading model-loading">Loading trend charts...</div>
        ) : !trends ? (
          <div className="empty-state">No trend data available.</div>
        ) : (
          <div className="charts-grid">
            {TREND_CHARTS.map((chart) => (
              <MetricChartCard
                key={chart.key}
                title={chart.title}
                data={trendChartData}
                dataKey={chart.dataKey}
                color={chart.color}
                type={chart.type}
              />
            ))}
          </div>
        )}
      </div>

      <div className="insights-section">
        <h2>Channel Breakdown</h2>
        {loadingBreakdown ? (
          <div className="loading model-loading">Loading channels...</div>
        ) : !channelBreakdown || channelBreakdown.channels.length === 0 ? (
          <div className="empty-state">No channel breakdown data available.</div>
        ) : (
          <div className="ads-table-container">
            <table className="ads-table model-breakdown-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Current Recall</th>
                  <th>Current Precision</th>
                  <th>7d Recall Avg</th>
                  <th>30d Recall Avg</th>
                  <th>Delta vs Baseline</th>
                  <th>Warnings</th>
                  <th>Sparkline</th>
                </tr>
              </thead>
              <tbody>
                {channelBreakdown.channels.map((row) => (
                  <tr
                    key={row.channel}
                    className={(channelDetail?.channel ?? detailChannel) === row.channel ? 'selected-channel-row' : ''}
                    onClick={() => {
                      setDetailScope('day')
                      setDetailChannel(row.channel)
                      setSelectedChannel(row.channel)
                    }}
                  >
                    <td>
                      <button className="table-link-button" type="button">
                        Channel {row.channel}
                      </button>
                    </td>
                    <td>{formatPercent(row.shortTerm.recallBySeconds)}</td>
                    <td>{formatPercent(row.shortTerm.precisionBySeconds)}</td>
                    <td>{formatPercent(row.baseline7d.metrics.recallBySeconds.average)}</td>
                    <td>{formatPercent(row.baseline30d.metrics.recallBySeconds.average)}</td>
                    <td>
                      <div className="channel-delta-cell">
                        <span className={metricDeltaClass(row.deltaVs30dRecall, 0)}>
                          R {formatDeltaPercentPoints(row.deltaVs30dRecall)}
                        </span>
                        <span className={metricDeltaClass(row.deltaVs30dPrecision, 0)}>
                          P {formatDeltaPercentPoints(row.deltaVs30dPrecision)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="alert-chip-list compact">
                        {row.warnings.length === 0 ? (
                          <span className="alert-chip info">None</span>
                        ) : (
                          row.warnings.map((warning) => (
                            <span key={`${row.channel}-${warning.code}`} className={severityClass(warning.severity)}>
                              {warning.severity}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      <ChannelSparkline data={row.sparkline} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="insights-section">
        <div className="leaderboard-header">
          <div>
            <h2>Detail Inspector</h2>
            <p className="model-performance-subtitle">
              Inspect day-level, multi-day, or recording-specific overlap using the same comparison logic as the backend job.
            </p>
          </div>
          <div className="leaderboard-controls">
            <label>
              Scope
              <select
                className="control-select"
                value={detailScope}
                onChange={(event) => setDetailScope(event.target.value as DetailScopeType)}
              >
                {DETAIL_SCOPES.map((scope) => (
                  <option key={scope.key} value={scope.key}>
                    {scope.label}
                  </option>
                ))}
              </select>
            </label>
            {detailScope !== 'recording' && (
              <label>
                Channel
                <select
                  className="control-select"
                  value={detailChannel ?? ''}
                  onChange={(event) => setDetailChannel(event.target.value)}
                >
                  {channels.map((channel) => (
                    <option key={channel} value={channel}>
                      Channel {channel}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {detailScope === 'day' && (
              <label>
                Day
                <input
                  className="control-select"
                  type="date"
                  value={detailDay}
                  onChange={(event) => setDetailDay(event.target.value)}
                />
              </label>
            )}
            {detailScope === 'range' && (
              <>
                <label>
                  Start
                  <input
                    className="control-select"
                    type="date"
                    value={detailStartDate}
                    onChange={(event) => setDetailStartDate(event.target.value)}
                  />
                </label>
                <label>
                  End
                  <input
                    className="control-select"
                    type="date"
                    value={detailEndDate}
                    onChange={(event) => setDetailEndDate(event.target.value)}
                  />
                </label>
              </>
            )}
            {detailScope === 'recording' && (
              <>
                <label className="detail-search-field">
                  Recording or WAV path
                  <input
                    className="control-select"
                    type="text"
                    placeholder="ch95_20260302_141553.ts or /path/to/file.wav"
                    value={detailRecordingInput}
                    onChange={(event) => setDetailRecordingInput(event.target.value)}
                  />
                </label>
                <label>
                  Window seconds
                  <input
                    className="control-select"
                    type="number"
                    min={60}
                    step={60}
                    value={detailWindowSeconds}
                    onChange={(event) => {
                      const nextValue = Number.parseInt(event.target.value || '1800', 10)
                      setDetailWindowSeconds(Number.isFinite(nextValue) ? nextValue : 1800)
                    }}
                  />
                </label>
              </>
            )}
          </div>
        </div>

        {loadingDetail ? (
          <div className="loading model-loading">Loading channel detail...</div>
        ) : !channelDetail || !detailWindow ? (
          <div className="empty-state">
            {detailScope === 'recording'
              ? 'Enter a recording name or WAV path to inspect detail.'
              : 'Select a channel and scope to inspect detail.'}
          </div>
        ) : (
          <>
            <div className="model-detail-scope-card">
              <div>
                <h3>{channelDetail.scope.label}</h3>
                <p>
                  Channel {channelDetail.channel} • {formatDateTime(channelDetail.scope.windowStart, timezone)} to{' '}
                  {formatDateTime(channelDetail.scope.windowEnd, timezone)}
                </p>
              </div>
              <div className="model-detail-scope-meta">
                <span>{channelDetail.scope.type}</span>
                {channelDetail.scope.audioPath && <span>{channelDetail.scope.audioPath}</span>}
                {channelDetail.scope.windowSeconds ? <span>{channelDetail.scope.windowSeconds}s window</span> : null}
              </div>
            </div>

            <div className="summary-cards">
              <div className="summary-card">
                <div className="summary-label">Recall</div>
                <div className="summary-value small">{formatPercent(channelDetail.summary.recallBySeconds)}</div>
              </div>
              <div className="summary-card">
                <div className="summary-label">Precision</div>
                <div className="summary-value small">{formatPercent(channelDetail.summary.precisionBySeconds)}</div>
              </div>
              <div className="summary-card">
                <div className="summary-label">Break Hit Rate</div>
                <div className="summary-value small">{formatPercent(channelDetail.summary.breakHitRate)}</div>
              </div>
              <div className="summary-card">
                <div className="summary-label">Matched Breaks</div>
                <div className="summary-value small">
                  {channelDetail.summary.matchedGroundTruthBreaks}/{channelDetail.summary.totalGroundTruthBreaks}
                </div>
              </div>
            </div>

            <div className="model-timeline-card">
              <h3>Ground Truth vs Model Timeline</h3>
              <TimelineLane
                label="Ground truth"
                intervals={channelDetail.groundTruthIntervals}
                rangeStartMs={detailWindow.startMs}
                rangeEndMs={detailWindow.endMs}
                colorClass="truth"
                timeZone={timezone}
              />
              <TimelineLane
                label="Model"
                intervals={channelDetail.modelIntervals}
                rangeStartMs={detailWindow.startMs}
                rangeEndMs={detailWindow.endMs}
                colorClass="model"
                timeZone={timezone}
              />
              <TimelineAxis
                rangeStartMs={detailWindow.startMs}
                rangeEndMs={detailWindow.endMs}
                timeZone={timezone}
              />
            </div>

            <div className="charts-grid">
              <div className="chart-item">
                <h3>Hour of Day Performance</h3>
                <div className="ads-table-container">
                  <table className="ads-table compact-table">
                    <thead>
                      <tr>
                        <th>Hour</th>
                        <th>Recall</th>
                        <th>Break Hit Rate</th>
                        <th>Breaks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channelDetail.hourOfDay.map((row) => (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>{formatPercent(row.recallBySeconds)}</td>
                          <td>{formatPercent(row.breakHitRate)}</td>
                          <td>{row.matchedGroundTruthBreaks}/{row.totalGroundTruthBreaks}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="chart-item">
                <h3>Duration Bucket Performance</h3>
                <div className="ads-table-container">
                  <table className="ads-table compact-table">
                    <thead>
                      <tr>
                        <th>Bucket</th>
                        <th>Recall</th>
                        <th>Break Hit Rate</th>
                        <th>Avg Capture</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channelDetail.durationBuckets.map((row) => (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>{formatPercent(row.recallBySeconds)}</td>
                          <td>{formatPercent(row.breakHitRate)}</td>
                          <td>{formatPercent(row.averageCapturedPercentage)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="ads-section">
              <h2>Recording / File Breakdown</h2>
              <div className="ads-table-container">
                <table className="ads-table compact-table">
                  <thead>
                    <tr>
                      <th>Recording</th>
                      <th>Started</th>
                      <th>Breaks</th>
                      <th>Matched</th>
                      <th>Recall</th>
                      <th>Truth Seconds</th>
                      <th>Overlap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelDetail.recordings.map((recording) => (
                      <tr key={recording.recordingName}>
                        <td>{recording.recordingName}</td>
                        <td>{formatDateTime(recording.recordingStartedAt ?? recording.firstTruthStartMs, timezone)}</td>
                        <td>{recording.totalBreaks}</td>
                        <td>{recording.matchedBreaks}</td>
                        <td>{formatPercent(recording.recallBySeconds)}</td>
                        <td>{formatSeconds(recording.truthSeconds)}</td>
                        <td>{formatSeconds(recording.overlapSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="ads-section">
              <h2>Per-Break Breakdown</h2>
              <div className="ads-table-container">
                <table className="ads-table model-detail-table">
                  <thead>
                    <tr>
                      <th>Recording</th>
                      <th>Break</th>
                      <th>Truth Start</th>
                      <th>Truth End</th>
                      <th>Model Overlap</th>
                      <th>Captured</th>
                      <th>Latency</th>
                      <th>Missed</th>
                      <th>Matched Intervals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelDetail.breakComparisons.map((comparison) => (
                      <tr key={comparison.breakId}>
                        <td>{comparison.recordingName}</td>
                        <td>{comparison.breakNumber}</td>
                        <td>{formatDateTime(comparison.truthStartMs, timezone)}</td>
                        <td>{formatDateTime(comparison.truthEndMs, timezone)}</td>
                        <td>{formatSeconds(comparison.overlapSec)}</td>
                        <td>{formatPercent(comparison.capturedPercentage)}</td>
                        <td>{formatSeconds(comparison.latencySec)}</td>
                        <td>
                          <span className={`alert-chip ${comparison.missedEntirely ? 'critical' : 'info'}`}>
                            {comparison.missedEntirely ? 'Missed' : 'Captured'}
                          </span>
                        </td>
                        <td>
                          <details className="matched-intervals">
                            <summary>{comparison.matchedModelIntervals.length} intervals</summary>
                            <div className="matched-interval-list">
                              {comparison.matchedModelIntervals.length === 0 ? (
                                <div>No matching model intervals.</div>
                              ) : (
                                comparison.matchedModelIntervals.map((interval) => (
                                  <div key={`${comparison.breakId}-${interval.sourceId}`} className="matched-interval-item">
                                    <strong>{interval.sourceId}</strong>
                                    <span>{formatTimeOnly(interval.startMs, timezone)} - {formatTimeOnly(interval.endMs, timezone)}</span>
                                    <span>Overlap {formatSeconds(interval.overlapSec)}</span>
                                  </div>
                                ))
                              )}
                            </div>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {selectedBreakdownRow && selectedBreakdownRow.warnings.length > 0 && (
              <div className="model-channel-warning-panel">
                <h3>Active Warnings for Channel {selectedBreakdownRow.channel}</h3>
                <div className="alert-chip-list">
                  {selectedBreakdownRow.warnings.map((warning) => (
                    <span key={`${selectedBreakdownRow.channel}-${warning.code}`} className={severityClass(warning.severity)}>
                      {warning.title}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
