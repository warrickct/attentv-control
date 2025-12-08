import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001')

interface HourlyPattern {
  hour: number
  dayOfWeek?: number
  plays: number
  duration: number
}

interface HourOfDayHeatmapProps {
  includeDayOfWeek?: boolean
}

export default function HourOfDayHeatmap({ includeDayOfWeek = false }: HourOfDayHeatmapProps) {
  const [patterns, setPatterns] = useState<HourlyPattern[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchPatterns = async () => {
      try {
        setLoading(true)
        setError(null)
        const url = `${API_URL}/api/stats/aggregate/hourly-patterns?dayOfWeek=${includeDayOfWeek}`
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error('Failed to fetch hourly patterns')
        }
        const data = await response.json()
        setPatterns(data.patterns || [])
      } catch (err: any) {
        setError(err.message || 'Failed to fetch hourly patterns')
        console.error('Error fetching hourly patterns:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchPatterns()
  }, [includeDayOfWeek])

  // Process data for chart
  const chartData = useMemo(() => {
    if (includeDayOfWeek) {
      // Group by day of week, then by hour
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      const dayMap = new Map<number, Map<number, { plays: number, duration: number }>>()
      
      patterns.forEach(pattern => {
        if (pattern.dayOfWeek === undefined) return
        if (!dayMap.has(pattern.dayOfWeek)) {
          dayMap.set(pattern.dayOfWeek, new Map())
        }
        const hourMap = dayMap.get(pattern.dayOfWeek)!
        hourMap.set(pattern.hour, {
          plays: (hourMap.get(pattern.hour)?.plays || 0) + pattern.plays,
          duration: (hourMap.get(pattern.hour)?.duration || 0) + pattern.duration,
        })
      })

      // Convert to array format for stacked bar chart
      const hours = Array.from({ length: 24 }, (_, i) => i)
      return hours.map(hour => {
        const entry: any = { hour: `${hour}:00` }
        dayNames.forEach((dayName, dayIndex) => {
          const dayData = dayMap.get(dayIndex)?.get(hour)
          entry[dayName] = dayData?.plays || 0
        })
        return entry
      })
    } else {
      // Simple hourly aggregation
      const hourMap = new Map<number, { plays: number, duration: number }>()
      
      patterns.forEach(pattern => {
        const existing = hourMap.get(pattern.hour) || { plays: 0, duration: 0 }
        hourMap.set(pattern.hour, {
          plays: existing.plays + pattern.plays,
          duration: existing.duration + pattern.duration,
        })
      })

      return Array.from({ length: 24 }, (_, i) => ({
        hour: `${i}:00`,
        plays: hourMap.get(i)?.plays || 0,
        duration: hourMap.get(i)?.duration || 0,
      }))
    }
  }, [patterns, includeDayOfWeek])

  if (loading) {
    return <div className="loading">Loading hourly patterns...</div>
  }

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const colors = ['#1565c0', '#1976d2', '#1e88e5', '#2196f3', '#42a5f5', '#64b5f6', '#90caf9']

  return (
    <div className="heatmap-container">
      <h3>Play Volume by Hour of Day</h3>
      <ResponsiveContainer width="100%" height={400}>
        <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis 
            dataKey="hour" 
            angle={-45} 
            textAnchor="end" 
            height={80}
            tick={{ fontSize: 11 }}
          />
          <YAxis />
          <Tooltip 
            formatter={(value: number) => [`${value} plays`, 'Plays']}
            labelFormatter={(label) => `Hour: ${label}`}
          />
          <Legend />
          {includeDayOfWeek ? (
            dayNames.map((day, index) => (
              <Bar key={day} dataKey={day} stackId="a" fill={colors[index]} />
            ))
          ) : (
            <Bar dataKey="plays" fill="#1976d2" />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

