import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001')

interface DayOfWeekPattern {
  dayOfWeek: number
  dayName: string
  plays: number
  duration: number
}

export default function DayOfWeekChart() {
  const [patterns, setPatterns] = useState<DayOfWeekPattern[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchPatterns = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch(`${API_URL}/api/stats/aggregate/day-of-week`)
        if (!response.ok) {
          throw new Error('Failed to fetch day of week patterns')
        }
        const data = await response.json()
        setPatterns(data.patterns || [])
      } catch (err: any) {
        setError(err.message || 'Failed to fetch day of week patterns')
        console.error('Error fetching day of week patterns:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchPatterns()
  }, [])

  // Calculate insights
  const insights = useMemo(() => {
    if (patterns.length === 0) return null

    const maxPlays = Math.max(...patterns.map(p => p.plays))
    const minPlays = Math.min(...patterns.map(p => p.plays))
    const avgPlays = patterns.reduce((sum, p) => sum + p.plays, 0) / patterns.length

    const busiestDay = patterns.find(p => p.plays === maxPlays)
    const quietestDay = patterns.find(p => p.plays === minPlays)

    const busiestMultiplier = busiestDay ? (busiestDay.plays / avgPlays).toFixed(1) : '1.0'
    const quietestMultiplier = quietestDay ? (avgPlays / quietestDay.plays).toFixed(1) : '1.0'

    return {
      busiestDay,
      quietestDay,
      busiestMultiplier,
      quietestMultiplier,
      avgPlays: Math.round(avgPlays),
    }
  }, [patterns])

  // Get max value for color scaling
  const maxPlays = useMemo(() => {
    return Math.max(...patterns.map(p => p.plays), 1)
  }, [patterns])

  const getColor = (plays: number) => {
    const intensity = plays / maxPlays
    if (intensity < 0.3) return '#e3f2fd'
    if (intensity < 0.5) return '#90caf9'
    if (intensity < 0.7) return '#42a5f5'
    if (intensity < 0.9) return '#1e88e5'
    return '#1565c0'
  }

  if (loading) {
    return <div className="loading">Loading day of week patterns...</div>
  }

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="day-of-week-chart-container">
      <h3>Play Volume by Day of Week</h3>
      {insights && (
        <div className="insights-callout">
          <strong>Insights:</strong> {insights.busiestDay?.dayName} sees {insights.busiestMultiplier}x more plays than average. 
          {insights.quietestDay && ` ${insights.quietestDay.dayName} is the quietest day.`}
        </div>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={patterns} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="dayName" />
          <YAxis />
          <Tooltip 
            formatter={(value: number) => [`${value} plays`, 'Plays']}
            labelFormatter={(label) => `Day: ${label}`}
          />
          <Bar dataKey="plays" fill="#1976d2">
            {patterns.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={getColor(entry.plays)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

