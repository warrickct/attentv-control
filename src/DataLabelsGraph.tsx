import { useState, useEffect, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001')

export interface DataLabelItem {
  channel: string
  startTime: string
  duration?: number | string
  id?: string
  is_test?: boolean | string
  stopTime?: string
  userName?: string
}

type RangeOption = '1h' | '1d' | '1w' | '1month' | 'total'
type GranularityOption = 'minute' | 'hour' | 'day' | 'week' | '1%' | '5%' | '10%'
type AggregateOption = 'count' | 'duration'

export default function DataLabelsGraph() {
  const [channels, setChannels] = useState<string[]>([])
  const [selectedChannel, setSelectedChannel] = useState<string>('all')
  const [rawData, setRawData] = useState<DataLabelItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<RangeOption>('1d')
  const [granularity, setGranularity] = useState<GranularityOption>('hour')
  const [aggregate, setAggregate] = useState<AggregateOption>('count')
  const [customStartDate, setCustomStartDate] = useState<string>('')
  const [customEndDate, setCustomEndDate] = useState<string>('')
  const [useCustomDateRange, setUseCustomDateRange] = useState(false)
  const [excludeTest, setExcludeTest] = useState(true)

  const getValidGranularities = (rangeOption: RangeOption): GranularityOption[] => {
    switch (rangeOption) {
      case '1h':
        return ['minute', 'hour', '1%', '5%', '10%']
      case '1d':
        return ['minute', 'hour', 'day', '1%', '5%', '10%']
      case '1w':
      case '1month':
      case 'total':
        return ['minute', 'hour', 'day', 'week', '1%', '5%', '10%']
      default:
        return ['minute', 'hour', 'day', 'week', '1%', '5%', '10%']
    }
  }

  const validGranularities = useMemo(() => getValidGranularities(range), [range])

  useEffect(() => {
    if (!validGranularities.includes(granularity)) {
      if (validGranularities.includes('hour')) setGranularity('hour')
      else if (validGranularities.includes('day')) setGranularity('day')
      else if (validGranularities.includes('minute')) setGranularity('minute')
      else setGranularity(validGranularities[0])
    }
  }, [range, validGranularities, granularity])

  useEffect(() => {
    const fetchChannels = async () => {
      try {
        setLoadingChannels(true)
        const res = await fetch(`${API_URL}/api/data-labels/channels`)
        if (!res.ok) throw new Error('Failed to fetch channels')
        const data = await res.json()
        setChannels(data.channels || [])
      } catch (err: any) {
        console.error('Error fetching channels:', err)
        setError(err.message || 'Failed to fetch channels')
      } finally {
        setLoadingChannels(false)
      }
    }
    fetchChannels()
  }, [])

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      setError(null)
      try {
        const url = selectedChannel && selectedChannel !== 'all'
          ? `${API_URL}/api/data-labels?channel=${encodeURIComponent(selectedChannel)}`
          : `${API_URL}/api/data-labels`
        const res = await fetch(url)
        if (!res.ok) throw new Error('Failed to fetch data labels')
        const data = await res.json()
        setRawData(data.items || [])
      } catch (err: any) {
        setError(err.message || 'Failed to fetch data labels')
        setRawData([])
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [selectedChannel])

  const dateRange = useMemo(() => {
    const now = new Date()
    let start: Date
    let end: Date = new Date(now)

    const isValidDate = (d: Date) => Number.isFinite(d.getTime())

    if (useCustomDateRange && customStartDate && customEndDate) {
      const customStart = new Date(customStartDate)
      const customEnd = new Date(customEndDate)
      customEnd.setHours(23, 59, 59, 999)
      customStart.setHours(0, 0, 0, 0)
      if (isValidDate(customStart) && isValidDate(customEnd) && customStart <= customEnd) {
        start = customStart
        end = customEnd
      } else {
        start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      }
    } else {
      switch (range) {
        case '1h':
          start = new Date(now.getTime() - 60 * 60 * 1000)
          break
        case '1d':
          start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
          break
        case '1w':
          start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
          break
        case '1month':
          start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          break
        case 'total':
          if (rawData.length > 0) {
            const sorted = [...rawData].sort((a, b) =>
              new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
            )
            const firstStart = new Date(sorted[0].startTime)
            start = isValidDate(firstStart) ? firstStart : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          } else {
            start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
          }
          break
        default:
          start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      }
    }
    if (!isValidDate(start)) start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    if (!isValidDate(end)) end = new Date(now)
    return { start, end }
  }, [range, rawData, useCustomDateRange, customStartDate, customEndDate])

  const filteredData = useMemo(() => {
    return rawData.filter(item => {
      const itemDate = new Date(item.startTime)
      if (!Number.isFinite(itemDate.getTime())) return false
      if (itemDate < dateRange.start || itemDate > dateRange.end) return false
      if (excludeTest) {
        const isTest = item.is_test === true || item.is_test === 'true'
        if (isTest) return false
      }
      return true
    })
  }, [rawData, dateRange, excludeTest])

  const bucketSize = useMemo(() => {
    const rangeMs = dateRange.end.getTime() - dateRange.start.getTime()
    if (!Number.isFinite(rangeMs) || rangeMs <= 0) return 60 * 60 * 1000
    switch (granularity) {
      case 'minute':
        return 60 * 1000
      case 'hour':
        return 60 * 60 * 1000
      case 'day':
        return 24 * 60 * 60 * 1000
      case 'week':
        return 7 * 24 * 60 * 60 * 1000
      case '1%':
        return rangeMs * 0.01
      case '5%':
        return rangeMs * 0.05
      case '10%':
        return rangeMs * 0.1
      default:
        return 60 * 60 * 1000
    }
  }, [granularity, dateRange])

  const formatTimeLabel = (timestamp: string, g: GranularityOption) => {
    const date = new Date(timestamp)
    switch (g) {
      case 'minute':
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      case 'hour':
        return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' })
      case 'day':
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      case 'week':
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
      default:
        return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' })
    }
  }

  const parseDuration = (d: number | string | undefined): number => {
    if (d === undefined || d === null) return 0
    const n = typeof d === 'string' ? parseFloat(d) : d
    return Number.isFinite(n) ? n : 0
  }

  const bucketedData = useMemo(() => {
    if (filteredData.length === 0) return []
    const buckets = new Map<string, { count: number; duration: number }>()
    filteredData.forEach(item => {
      const itemDate = new Date(item.startTime)
      const bucketTime = Math.floor(itemDate.getTime() / bucketSize) * bucketSize
      const bucketKey = new Date(bucketTime).toISOString()
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { count: 0, duration: 0 })
      }
      const b = buckets.get(bucketKey)!
      b.count++
      b.duration += parseDuration(item.duration)
    })
    return Array.from(buckets.entries())
      .map(([time, data]) => ({
        time: formatTimeLabel(time, granularity),
        timestamp: time,
        fullTime: new Date(time).toLocaleString(),
        count: data.count,
        duration: data.duration,
      }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }, [filteredData, bucketSize, granularity])

  const formatDuration = (seconds: number) => {
    if (seconds === undefined || seconds === 0) return '0s'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) return `${h}h ${m}m ${s}s`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  const totalDuration = useMemo(
    () => filteredData.reduce((sum, item) => sum + parseDuration(item.duration), 0),
    [filteredData]
  )

  if (loadingChannels) {
    return <div className="loading">Loading channels...</div>
  }

  return (
    <div className="graph-container">
      <div className="graph-controls">
        <div className="control-group">
          <label htmlFor="channel-select">Channel:</label>
          <select
            id="channel-select"
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
            className="control-select"
          >
            <option value="all">All channels</option>
            {channels.map((ch) => (
              <option key={ch} value={ch}>
                {ch}
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={useCustomDateRange}
              onChange={(e) => {
                setUseCustomDateRange(e.target.checked)
                if (!e.target.checked) {
                  setCustomStartDate('')
                  setCustomEndDate('')
                }
              }}
              style={{ marginRight: '0.5rem' }}
            />
            Custom Date Range
          </label>
        </div>
        {useCustomDateRange ? (
          <>
            <div className="control-group">
              <label htmlFor="dl-start-date">Start:</label>
              <input
                id="dl-start-date"
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="control-select"
                style={{ padding: '0.5rem 1rem' }}
              />
            </div>
            <div className="control-group">
              <label htmlFor="dl-end-date">End:</label>
              <input
                id="dl-end-date"
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="control-select"
                style={{ padding: '0.5rem 1rem' }}
              />
            </div>
          </>
        ) : (
          <div className="control-group">
            <label htmlFor="dl-range-select">Range:</label>
            <select
              id="dl-range-select"
              value={range}
              onChange={(e) => setRange(e.target.value as RangeOption)}
              className="control-select"
            >
              <option value="1h">1 Hour</option>
              <option value="1d">1 Day</option>
              <option value="1w">1 Week</option>
              <option value="1month">1 Month</option>
              <option value="total">Total</option>
            </select>
          </div>
        )}
        <div className="control-group">
          <label htmlFor="dl-granularity">Granularity:</label>
          <select
            id="dl-granularity"
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as GranularityOption)}
            className="control-select"
          >
            {['minute', 'hour', 'day', 'week'].map((g) => (
              <option key={g} value={g} disabled={!validGranularities.includes(g as GranularityOption)}>
                {g.charAt(0).toUpperCase() + g.slice(1)}
              </option>
            ))}
            {['1%', '5%', '10%'].map((g) => (
              <option key={g} value={g} disabled={!validGranularities.includes(g as GranularityOption)}>
                {g} of range
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <label htmlFor="dl-aggregate">Aggregate:</label>
          <select
            id="dl-aggregate"
            value={aggregate}
            onChange={(e) => setAggregate(e.target.value as AggregateOption)}
            className="control-select"
          >
            <option value="count">Count (labels per bucket)</option>
            <option value="duration">Total duration (per bucket)</option>
          </select>
        </div>
        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={excludeTest}
              onChange={(e) => setExcludeTest(e.target.checked)}
              style={{ marginRight: '0.5rem' }}
            />
            Exclude test
          </label>
        </div>
        <div className="control-info">
          <span>Buckets: {bucketedData.length}</span>
          <span>Labels: {filteredData.length}</span>
        </div>
      </div>

      {error && (
        <div className="error">Error: {error}</div>
      )}

      {!error && bucketedData.length === 0 && !loading && (
        <div className="empty-state">
          <p>No data for the selected channel and range.</p>
        </div>
      )}

      {!error && bucketedData.length > 0 && (
        <>
          <ResponsiveContainer width="100%" height={450}>
            <LineChart data={bucketedData} margin={{ top: 20, right: 30, left: 20, bottom: 120 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                angle={-45}
                textAnchor="end"
                height={120}
                interval="preserveStartEnd"
                tick={{ fontSize: 11 }}
              />
              <YAxis />
              <Tooltip
                contentStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', border: '1px solid #ccc' }}
                labelFormatter={(value) => {
                  const item = bucketedData.find((d) => d.time === value)
                  return item?.fullTime || value
                }}
                formatter={(value: number) => [
                  aggregate === 'count' ? `${value} labels` : formatDuration(value),
                  aggregate === 'count' ? 'Label count' : 'Duration',
                ]}
              />
              <Line
                type="monotone"
                dataKey={aggregate === 'count' ? 'count' : 'duration'}
                stroke="#667eea"
                strokeWidth={2}
                name={aggregate === 'count' ? 'Label count' : 'Total duration'}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>

          <div className="graph-summary">
            <h3>Summary</h3>
            <div className="summary-stats-grid">
              <div className="summary-stat-card">
                <div className="stat-label">Total labels</div>
                <div className="stat-value">{filteredData.length.toLocaleString()}</div>
              </div>
              <div className="summary-stat-card">
                <div className="stat-label">Total duration</div>
                <div className="stat-value">{formatDuration(totalDuration)}</div>
              </div>
              <div className="summary-stat-card">
                <div className="stat-label">Avg duration / label</div>
                <div className="stat-value">
                  {filteredData.length > 0 ? formatDuration(totalDuration / filteredData.length) : '0s'}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {loading && rawData.length === 0 && <div className="loading">Loading data labels...</div>}
    </div>
  )
}
