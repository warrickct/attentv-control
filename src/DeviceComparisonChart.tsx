import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface DeviceComparison {
  deviceId: string
  totalPlays: number
  avgPlaysPerDay: number
  totalDuration: number
}

export default function DeviceComparisonChart() {
  const [devices, setDevices] = useState<DeviceComparison[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<'plays' | 'avgPlaysPerDay' | 'duration'>('plays')

  useEffect(() => {
    const fetchComparison = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch(`${API_URL}/api/stats/devices/comparison`)
        if (!response.ok) {
          throw new Error('Failed to fetch device comparison')
        }
        const data = await response.json()
        setDevices(data.devices || [])
      } catch (err: any) {
        setError(err.message || 'Failed to fetch device comparison')
        console.error('Error fetching device comparison:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchComparison()
  }, [])

  // Format device name for display
  const formatDeviceName = (deviceId: string): string => {
    if (deviceId === 'attntv-nuc-1') {
      return 'The Dava'
    }
    if (deviceId === 'attentv-edge-3-flying-duck') {
      return 'Flying Duck'
    }
    
    const match = deviceId.match(/^attentv-\d+-(.+)$/)
    if (match) {
      return match[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    }
    
    return deviceId
  }

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
  }

  if (loading) {
    return <div className="loading">Loading device comparison...</div>
  }

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  // Sort by selected metric
  const sortedDevices = [...devices].sort((a, b) => {
    switch (metric) {
      case 'avgPlaysPerDay':
        return b.avgPlaysPerDay - a.avgPlaysPerDay
      case 'duration':
        return b.totalDuration - a.totalDuration
      case 'plays':
      default:
        return b.totalPlays - a.totalPlays
    }
  })

  const chartData = sortedDevices.map(device => ({
    name: formatDeviceName(device.deviceId),
    plays: device.totalPlays,
    avgPlaysPerDay: Math.round(device.avgPlaysPerDay * 100) / 100,
    duration: Math.round(device.totalDuration / 60), // Convert to minutes
  }))

  return (
    <div className="device-comparison-container">
      <div className="comparison-header">
        <h3>Device Performance Comparison</h3>
        <label>
          Compare by:
          <select 
            value={metric} 
            onChange={(e) => setMetric(e.target.value as typeof metric)}
            className="control-select"
          >
            <option value="plays">Total Plays</option>
            <option value="avgPlaysPerDay">Average Plays/Day</option>
            <option value="duration">Total Duration</option>
          </select>
        </label>
      </div>
      <ResponsiveContainer width="100%" height={400}>
        <BarChart 
          data={chartData} 
          layout="vertical"
          margin={{ top: 20, right: 30, left: 100, bottom: 20 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" />
          <YAxis dataKey="name" type="category" width={80} />
          <Tooltip 
            formatter={(value: number, name: string) => {
              if (name === 'duration') {
                return [`${formatDuration(value * 60)}`, 'Duration']
              }
              return [value, name === 'plays' ? 'Total Plays' : 'Avg Plays/Day']
            }}
          />
          <Legend />
          <Bar 
            dataKey={metric === 'plays' ? 'plays' : metric === 'avgPlaysPerDay' ? 'avgPlaysPerDay' : 'duration'} 
            fill="#1976d2" 
            name={metric === 'plays' ? 'Total Plays' : metric === 'avgPlaysPerDay' ? 'Avg Plays/Day' : 'Duration (min)'}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

