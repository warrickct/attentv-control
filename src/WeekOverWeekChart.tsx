import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001')

interface WeekComparison {
  currentWeek: {
    plays: number
    duration: number
    uniqueAds: number
  }
  previousWeek: {
    plays: number
    duration: number
    uniqueAds: number
  }
  change: {
    plays: number
    duration: number
    uniqueAds: number
  }
}

export default function WeekOverWeekChart() {
  const [comparison, setComparison] = useState<WeekComparison | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchComparison = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch(`${API_URL}/api/stats/aggregate/week-comparison`)
        if (!response.ok) {
          throw new Error('Failed to fetch week comparison')
        }
        const data = await response.json()
        setComparison(data)
      } catch (err: any) {
        setError(err.message || 'Failed to fetch week comparison')
        console.error('Error fetching week comparison:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchComparison()
  }, [])

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
  }

  const formatChange = (change: number) => {
    const sign = change >= 0 ? '+' : ''
    return `${sign}${change}`
  }

  const getChangeColor = (change: number) => {
    return change >= 0 ? '#4caf50' : '#f44336'
  }

  if (loading) {
    return <div className="loading">Loading week comparison...</div>
  }

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  if (!comparison) {
    return <div className="empty-state">No comparison data available</div>
  }

  const chartData = [
    {
      name: 'Previous Week',
      plays: comparison.previousWeek.plays,
      duration: Math.round(comparison.previousWeek.duration / 60), // Convert to minutes
      uniqueAds: comparison.previousWeek.uniqueAds,
    },
    {
      name: 'Current Week',
      plays: comparison.currentWeek.plays,
      duration: Math.round(comparison.currentWeek.duration / 60),
      uniqueAds: comparison.currentWeek.uniqueAds,
    },
  ]

  return (
    <div className="week-comparison-container">
      <h3>Week-over-Week Comparison</h3>
      <div className="comparison-metrics">
        <div className="comparison-metric">
          <div className="metric-label">Plays</div>
          <div className="metric-value">
            {comparison.currentWeek.plays}
            <span className="metric-change" style={{ color: getChangeColor(comparison.change.plays) }}>
              ({formatChange(comparison.change.plays)})
            </span>
          </div>
        </div>
        <div className="comparison-metric">
          <div className="metric-label">Duration</div>
          <div className="metric-value">
            {formatDuration(comparison.currentWeek.duration)}
            <span className="metric-change" style={{ color: getChangeColor(comparison.change.duration) }}>
              ({formatChange(Math.round(comparison.change.duration / 60))} min)
            </span>
          </div>
        </div>
        <div className="comparison-metric">
          <div className="metric-label">Unique Ads</div>
          <div className="metric-value">
            {comparison.currentWeek.uniqueAds}
            <span className="metric-change" style={{ color: getChangeColor(comparison.change.uniqueAds) }}>
              ({formatChange(comparison.change.uniqueAds)})
            </span>
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="plays" stroke="#1976d2" strokeWidth={2} name="Plays" />
          <Line type="monotone" dataKey="duration" stroke="#4caf50" strokeWidth={2} name="Duration (min)" />
          <Line type="monotone" dataKey="uniqueAds" stroke="#ff9800" strokeWidth={2} name="Unique Ads" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

