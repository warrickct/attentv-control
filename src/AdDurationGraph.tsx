import { useState, useEffect, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001')

interface TimeSeriesItem {
  timestamp: string
  ad_filename: string
  play_duration?: number
  play_id?: string
}

type RangeOption = '1h' | '1d' | '1w' | '1month' | 'total'
type GranularityOption = 'minute' | 'hour' | 'day' | 'week' | '1%' | '5%' | '10%'

interface AdDurationGraphProps {
  deviceId: string
}

export default function AdDurationGraph({ deviceId }: AdDurationGraphProps) {
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<RangeOption>('1d')
  const [granularity, setGranularity] = useState<GranularityOption>('hour')
  const [customStartDate, setCustomStartDate] = useState<string>('')
  const [customEndDate, setCustomEndDate] = useState<string>('')
  const [useCustomDateRange, setUseCustomDateRange] = useState(false)
  const [useTimeRangeFilter, setUseTimeRangeFilter] = useState(false)
  const [timeRangeStart, setTimeRangeStart] = useState<string>('00:00')
  const [timeRangeEnd, setTimeRangeEnd] = useState<string>('23:59')

  // Get valid granularities for a given range
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

  // Get valid granularities for current range
  const validGranularities = useMemo(() => getValidGranularities(range), [range])

  // Auto-adjust granularity if it becomes invalid when range changes
  useEffect(() => {
    if (!validGranularities.includes(granularity)) {
      // Set to the largest valid granularity (most appropriate default)
      if (validGranularities.includes('hour')) {
        setGranularity('hour')
      } else if (validGranularities.includes('day')) {
        setGranularity('day')
      } else if (validGranularities.includes('minute')) {
        setGranularity('minute')
      } else {
        setGranularity(validGranularities[0])
      }
    }
  }, [range, validGranularities, granularity])

  // Reset state when device changes
  useEffect(() => {
    setTimeSeriesData([])
    setError(null)
    setRange('1d')
    setGranularity('hour')
    setCustomStartDate('')
    setCustomEndDate('')
    setUseCustomDateRange(false)
    setUseTimeRangeFilter(false)
    setTimeRangeStart('00:00')
    setTimeRangeEnd('23:59')
  }, [deviceId])

  // Fetch time series data
  useEffect(() => {
    const fetchTimeSeries = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(`${API_URL}/api/stats/device/${deviceId}/timeseries`)
        if (!response.ok) {
          throw new Error('Failed to fetch time series data')
        }
        const data = await response.json()
        setTimeSeriesData(data.items || [])
      } catch (err: any) {
        setError(err.message || 'Failed to fetch time series data')
        console.error('Error fetching time series:', err)
      } finally {
        setLoading(false)
      }
    }

    if (deviceId) {
      fetchTimeSeries()
    }
  }, [deviceId])

  // Calculate date range based on selection
  const dateRange = useMemo(() => {
    const now = new Date()
    let start: Date
    let end: Date = now

    if (useCustomDateRange && customStartDate && customEndDate) {
      start = new Date(customStartDate)
      end = new Date(customEndDate)
      // Set end time to end of day
      end.setHours(23, 59, 59, 999)
      // Set start time to start of day
      start.setHours(0, 0, 0, 0)
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
          // Use earliest timestamp from data
          if (timeSeriesData.length > 0) {
            const sorted = [...timeSeriesData].sort((a, b) => 
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            )
            start = new Date(sorted[0].timestamp)
          } else {
            start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) // Default to 30 days
          }
          break
      }
    }

    return { start, end }
  }, [range, timeSeriesData, useCustomDateRange, customStartDate, customEndDate])

  // Filter data by date range and optional time-of-day range
  const filteredData = useMemo(() => {
    return timeSeriesData.filter(item => {
      const itemDate = new Date(item.timestamp)
      
      // Filter by date range
      if (itemDate < dateRange.start || itemDate > dateRange.end) {
        return false
      }
      
      // Filter by time-of-day range if enabled
      if (useTimeRangeFilter) {
        const itemHour = itemDate.getHours()
        const itemMinute = itemDate.getMinutes()
        const itemTimeMinutes = itemHour * 60 + itemMinute
        
        const [startHour, startMin] = timeRangeStart.split(':').map(Number)
        const [endHour, endMin] = timeRangeEnd.split(':').map(Number)
        const startTimeMinutes = startHour * 60 + startMin
        const endTimeMinutes = endHour * 60 + endMin
        
        // Handle time range that spans midnight (e.g., 12pm-12am = 12:00 to 00:00)
        if (startTimeMinutes > endTimeMinutes) {
          // Range spans midnight
          if (itemTimeMinutes < startTimeMinutes && itemTimeMinutes > endTimeMinutes) {
            return false
          }
        } else {
          // Normal range
          if (itemTimeMinutes < startTimeMinutes || itemTimeMinutes > endTimeMinutes) {
            return false
          }
        }
      }
      
      return true
    })
  }, [timeSeriesData, dateRange, useTimeRangeFilter, timeRangeStart, timeRangeEnd])

  // Calculate bucket size based on granularity
  const bucketSize = useMemo(() => {
    const rangeMs = dateRange.end.getTime() - dateRange.start.getTime()
    
    switch (granularity) {
      case 'minute':
        return 60 * 1000 // 1 minute
      case 'hour':
        return 60 * 60 * 1000 // 1 hour
      case 'day':
        return 24 * 60 * 60 * 1000 // 1 day
      case 'week':
        return 7 * 24 * 60 * 60 * 1000 // 1 week
      case '1%':
        return rangeMs * 0.01
      case '5%':
        return rangeMs * 0.05
      case '10%':
        return rangeMs * 0.1
      default:
        return 60 * 60 * 1000 // Default to 1 hour
    }
  }, [granularity, dateRange])

  // Format time label based on granularity
  const formatTimeLabel = (timestamp: string, granularity: GranularityOption) => {
    const date = new Date(timestamp)
    switch (granularity) {
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

  // Format duration helper
  const formatDuration = (seconds: number | undefined) => {
    if (seconds === undefined || seconds === 0) return '0s'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`
    } else {
      return `${secs}s`
    }
  }

  // Bucket data by time intervals - aggregate by duration instead of count
  const bucketedData = useMemo(() => {
    if (filteredData.length === 0) return []

    // Create buckets with duration tracking
    const buckets = new Map<string, { 
      count: number
      totalDuration: number
      ads: Map<string, { count: number; duration: number }>
    }>()
    
    filteredData.forEach(item => {
      const itemDate = new Date(item.timestamp)
      const bucketTime = Math.floor(itemDate.getTime() / bucketSize) * bucketSize
      const bucketKey = new Date(bucketTime).toISOString()
      
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { 
          count: 0, 
          totalDuration: 0,
          ads: new Map() 
        })
      }
      
      const bucket = buckets.get(bucketKey)!
      bucket.count++
      bucket.totalDuration += item.play_duration || 0
      
      const adData = bucket.ads.get(item.ad_filename) || { count: 0, duration: 0 }
      adData.count++
      adData.duration += item.play_duration || 0
      bucket.ads.set(item.ad_filename, adData)
    })

    // Calculate bucket size in seconds for percentage calculation
    const bucketSizeSeconds = bucketSize / 1000

    // Convert to array and sort by time - use duration instead of count
    const result = Array.from(buckets.entries())
      .map(([time, data]) => {
        const percentage = bucketSizeSeconds > 0 ? (data.totalDuration / bucketSizeSeconds) * 100 : 0
        const entry: any = {
          time: formatTimeLabel(time, granularity),
          timestamp: time,
          fullTime: new Date(time).toLocaleString(),
          total: data.totalDuration, // Use duration instead of count
          totalPlays: data.count, // Keep count for tooltip
          totalDuration: data.totalDuration,
          bucketSizeSeconds, // Store for tooltip
          percentage, // Percentage of bucket time spent playing ads
        }
        
        // Add duration per ad (instead of count)
        data.ads.forEach((adData, adFilename) => {
          const adPercentage = bucketSizeSeconds > 0 ? (adData.duration / bucketSizeSeconds) * 100 : 0
          entry[adFilename] = adData.duration // Use duration instead of count
          entry[`${adFilename}_count`] = adData.count // Keep count for tooltip
          entry[`${adFilename}_duration`] = adData.duration
          entry[`${adFilename}_percentage`] = adPercentage // Percentage for this ad
        })
        
        return entry
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    return result
  }, [filteredData, bucketSize, granularity])

  // Get unique ad filenames for legend
  const adFilenames = useMemo(() => {
    const ads = new Set<string>()
    filteredData.forEach(item => ads.add(item.ad_filename))
    return Array.from(ads).sort()
  }, [filteredData])

  // Generate colors for each ad
  const colors = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#00f2fe', '#43e97b', '#fa709a']

  if (loading) {
    return <div className="loading">Loading time series data...</div>
  }

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="graph-container">
      <div className="graph-controls">
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
              <label htmlFor="start-date-duration">Start Date:</label>
              <input
                id="start-date-duration"
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="control-select"
                style={{ padding: '0.5rem 1rem' }}
              />
            </div>
            <div className="control-group">
              <label htmlFor="end-date-duration">End Date:</label>
              <input
                id="end-date-duration"
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
            <label htmlFor="range-select-duration">Range:</label>
            <select
              id="range-select-duration"
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
          <label htmlFor="granularity-select-duration">Granularity:</label>
          <select
            id="granularity-select-duration"
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as GranularityOption)}
            className="control-select"
          >
            <option value="minute" disabled={!validGranularities.includes('minute')}>
              Minute
            </option>
            <option value="hour" disabled={!validGranularities.includes('hour')}>
              Hour
            </option>
            <option value="day" disabled={!validGranularities.includes('day')}>
              Day
            </option>
            <option value="week" disabled={!validGranularities.includes('week')}>
              Week
            </option>
            <option value="1%" disabled={!validGranularities.includes('1%')}>
              1% of Range
            </option>
            <option value="5%" disabled={!validGranularities.includes('5%')}>
              5% of Range
            </option>
            <option value="10%" disabled={!validGranularities.includes('10%')}>
              10% of Range
            </option>
          </select>
        </div>
        <div className="control-group">
          <label>
            <input
              type="checkbox"
              checked={useTimeRangeFilter}
              onChange={(e) => setUseTimeRangeFilter(e.target.checked)}
              style={{ marginRight: '0.5rem' }}
            />
            Filter by Time of Day
          </label>
        </div>
        {useTimeRangeFilter && (
          <>
            <div className="control-group">
              <label htmlFor="time-start-duration">Start Time:</label>
              <input
                id="time-start-duration"
                type="time"
                value={timeRangeStart}
                onChange={(e) => setTimeRangeStart(e.target.value)}
                className="control-select"
                style={{ padding: '0.5rem 1rem' }}
              />
            </div>
            <div className="control-group">
              <label htmlFor="time-end-duration">End Time:</label>
              <input
                id="time-end-duration"
                type="time"
                value={timeRangeEnd}
                onChange={(e) => setTimeRangeEnd(e.target.value)}
                className="control-select"
                style={{ padding: '0.5rem 1rem' }}
              />
            </div>
          </>
        )}
        <div className="control-info">
          <span>Data points: {bucketedData.length}</span>
          <span>Total duration: {formatDuration(bucketedData.reduce((sum, d) => sum + (d.totalDuration || 0), 0))}</span>
        </div>
      </div>

      {bucketedData.length === 0 ? (
        <div className="empty-state">
          <p>No data available for the selected range.</p>
        </div>
      ) : (
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
              contentStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', border: '1px solid #ccc', padding: '12px' }}
              labelFormatter={(value) => {
                const item = bucketedData.find(d => d.time === value)
                return item?.fullTime || value
              }}
              formatter={(value: any, name: string, props: any) => {
                const item = props.payload
                if (name === 'Total Duration') {
                  const avgDuration = item.totalPlays > 0 ? (value / item.totalPlays) : 0
                  const percentage = item.percentage || 0
                  return [
                    <div key="total" style={{ lineHeight: '1.6' }}>
                      <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>All Ads Combined</div>
                      <div>Total Duration: <strong>{formatDuration(value)}</strong></div>
                      <div style={{ color: '#666', fontSize: '0.9em' }}>
                        Total Plays: {item.totalPlays}
                      </div>
                      <div style={{ color: '#666', fontSize: '0.9em', marginTop: '2px' }}>
                        Avg Duration/Play: {formatDuration(avgDuration)}
                      </div>
                      <div style={{ color: '#667eea', fontSize: '0.9em', marginTop: '4px', fontWeight: '600' }}>
                        {percentage.toFixed(1)}% of time bucket
                      </div>
                    </div>,
                    ''
                  ]
                }
                // For individual ads, show duration and count
                const adCount = item[`${name}_count`]
                if (adCount !== undefined && adCount > 0) {
                  const avgDuration = value / adCount
                  const adPercentage = item[`${name}_percentage`] || 0
                  return [
                    <div key={name} style={{ lineHeight: '1.6' }}>
                      <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>{name}</div>
                      <div>Total Duration: <strong>{formatDuration(value)}</strong></div>
                      <div style={{ color: '#666', fontSize: '0.9em' }}>
                        Plays: {adCount}
                      </div>
                      <div style={{ color: '#666', fontSize: '0.9em', marginTop: '2px' }}>
                        Avg Duration/Play: {formatDuration(avgDuration)}
                      </div>
                      <div style={{ color: '#667eea', fontSize: '0.9em', marginTop: '4px', fontWeight: '600' }}>
                        {adPercentage.toFixed(1)}% of time bucket
                      </div>
                    </div>,
                    ''
                  ]
                }
                return [formatDuration(value), name]
              }}
            />
            <Legend 
              wrapperStyle={{ paddingTop: '20px' }}
              iconType="line"
            />
            <Line 
              type="monotone" 
              dataKey="total" 
              stroke="#667eea" 
              strokeWidth={2}
              name="Total Duration"
              dot={false}
            />
            {adFilenames.map((adFilename, index) => (
              <Line
                key={adFilename}
                type="monotone"
                dataKey={adFilename}
                stroke={colors[index % colors.length]}
                strokeWidth={1.5}
                name={adFilename}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Summary Statistics */}
      {bucketedData.length > 0 && (
        <div className="graph-summary">
          <h3>Summary Statistics</h3>
          <div className="summary-stats-grid">
            <div className="summary-stat-card">
              <div className="stat-label">Total Duration</div>
              <div className="stat-value">
                {formatDuration(filteredData.reduce((sum, item) => sum + (item.play_duration || 0), 0))}
              </div>
            </div>
            <div className="summary-stat-card">
              <div className="stat-label">Average Duration per Bucket</div>
              <div className="stat-value">
                {bucketedData.length > 0
                  ? formatDuration(bucketedData.reduce((sum, d) => sum + (d.totalDuration || 0), 0) / bucketedData.length)
                  : '0s'}
              </div>
            </div>
            <div className="summary-stat-card">
              <div className="stat-label">Total Plays</div>
              <div className="stat-value">{filteredData.length.toLocaleString()}</div>
            </div>
            <div className="summary-stat-card">
              <div className="stat-label">Average Duration per Play</div>
              <div className="stat-value">
                {filteredData.length > 0
                  ? formatDuration(filteredData.reduce((sum, item) => sum + (item.play_duration || 0), 0) / filteredData.length)
                  : '0s'}
              </div>
            </div>
            <div className="summary-stat-card">
              <div className="stat-label">% of Time Range</div>
              <div className="stat-value">
                {(() => {
                  const totalDuration = filteredData.reduce((sum, item) => sum + (item.play_duration || 0), 0)
                  const rangeSeconds = (dateRange.end.getTime() - dateRange.start.getTime()) / 1000
                  const percentage = rangeSeconds > 0 ? (totalDuration / rangeSeconds) * 100 : 0
                  return `${percentage.toFixed(1)}%`
                })()}
              </div>
            </div>
          </div>
          
          {/* Per-Ad Breakdown */}
          {adFilenames.length > 0 && (
            <div className="per-ad-breakdown">
              <h4>Per-Ad Breakdown</h4>
              <div className="ads-breakdown-table">
                <table>
                  <thead>
                    <tr>
                      <th>Ad</th>
                      <th>Total Duration</th>
                      <th>Total Plays</th>
                      <th>Avg Duration/Play</th>
                      <th>% of Total Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adFilenames.map(adFilename => {
                      const adItems = filteredData.filter(item => item.ad_filename === adFilename)
                      const adTotalPlays = adItems.length
                      const adTotalDuration = adItems.reduce((sum, item) => sum + (item.play_duration || 0), 0)
                      const adAvgDuration = adTotalPlays > 0 ? adTotalDuration / adTotalPlays : 0
                      const totalDuration = filteredData.reduce((sum, item) => sum + (item.play_duration || 0), 0)
                      const adPercentage = totalDuration > 0 ? (adTotalDuration / totalDuration) * 100 : 0
                      
                      return (
                        <tr key={adFilename}>
                          <td>{adFilename}</td>
                          <td>{formatDuration(adTotalDuration)}</td>
                          <td>{adTotalPlays.toLocaleString()}</td>
                          <td>{formatDuration(adAvgDuration)}</td>
                          <td>{adPercentage.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

