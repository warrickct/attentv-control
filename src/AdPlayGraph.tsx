import { useState, useEffect, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface TimeSeriesItem {
  timestamp: string
  ad_filename: string
  play_duration?: number
  play_id?: string
}

type RangeOption = '1h' | '1d' | '1w' | '1month' | 'total'
type GranularityOption = 'minute' | 'hour' | 'day' | 'week' | '1%' | '5%' | '10%'

interface AdPlayGraphProps {
  deviceId: string
}

export default function AdPlayGraph({ deviceId }: AdPlayGraphProps) {
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<RangeOption>('1w')
  const [granularity, setGranularity] = useState<GranularityOption>('hour')

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
    setRange('1w')
    setGranularity('hour')
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

    return { start, end: now }
  }, [range, timeSeriesData])

  // Filter data by date range
  const filteredData = useMemo(() => {
    return timeSeriesData.filter(item => {
      const itemDate = new Date(item.timestamp)
      return itemDate >= dateRange.start && itemDate <= dateRange.end
    })
  }, [timeSeriesData, dateRange])

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

  // Bucket data by time intervals
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

    // Convert to array and sort by time
    const result = Array.from(buckets.entries())
      .map(([time, data]) => {
        const entry: any = {
          time: formatTimeLabel(time, granularity),
          timestamp: time,
          fullTime: new Date(time).toLocaleString(),
          total: data.count,
          totalDuration: data.totalDuration,
        }
        
        // Add counts per ad
        data.ads.forEach((adData, adFilename) => {
          entry[adFilename] = adData.count
          entry[`${adFilename}_duration`] = adData.duration
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
          <label htmlFor="range-select">Range:</label>
          <select
            id="range-select"
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
        <div className="control-group">
          <label htmlFor="granularity-select">Granularity:</label>
          <select
            id="granularity-select"
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
        <div className="control-info">
          <span>Data points: {bucketedData.length}</span>
          <span>Total plays: {filteredData.length}</span>
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
              contentStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.95)', border: '1px solid #ccc' }}
              labelFormatter={(value) => {
                const item = bucketedData.find(d => d.time === value)
                return item?.fullTime || value
              }}
              formatter={(value: any, name: string, props: any) => {
                const item = props.payload
                if (name === 'Total Plays') {
                  return [
                    <>
                      <div>{value} plays</div>
                      <div style={{ color: '#666', fontSize: '0.85em', marginTop: '4px' }}>
                        Total Duration: {formatDuration(item.totalDuration)}
                      </div>
                    </>,
                    name
                  ]
                }
                // For individual ads, show count and duration
                const adDuration = item[`${name}_duration`]
                if (adDuration !== undefined) {
                  return [
                    <>
                      <div>{value} plays</div>
                      <div style={{ color: '#666', fontSize: '0.85em', marginTop: '4px' }}>
                        Duration: {formatDuration(adDuration)}
                      </div>
                    </>,
                    name
                  ]
                }
                return [value, name]
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
              name="Total Plays"
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
    </div>
  )
}

