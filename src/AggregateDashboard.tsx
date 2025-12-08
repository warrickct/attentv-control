import { useState, useEffect } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001')

interface AggregateSummary {
  totalPlays: number
  totalPlays24hr: number
  totalPlays7d: number
  totalPlays30d: number
  uniqueAds: number
  totalDuration: number
  activeDevices: number
  avgPlaysPerDevice: number
}

interface AggregateDashboardProps {
  onRefresh?: () => void
}

export default function AggregateDashboard({ onRefresh }: AggregateDashboardProps) {
  const [summary, setSummary] = useState<AggregateSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSummary = async (forceRefresh = false) => {
    try {
      setLoading(true)
      setError(null)
      const url = `${API_URL}/api/stats/aggregate/summary${forceRefresh ? '?refresh=true' : ''}`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error('Failed to fetch aggregate summary')
      }
      const data = await response.json()
      setSummary(data)
    } catch (err: any) {
      setError(err.message || 'Failed to fetch aggregate summary')
      console.error('Error fetching aggregate summary:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSummary()
  }, [])

  const formatDuration = (seconds: number | undefined) => {
    if (seconds === undefined || seconds === 0) return '0s'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    } else if (minutes > 0) {
      return `${minutes}m`
    } else {
      return `${Math.floor(seconds)}s`
    }
  }

  const formatNumber = (num: number) => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`
    } else if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`
    }
    return num.toString()
  }

  const handleRefresh = () => {
    fetchSummary(true)
    onRefresh?.()
  }

  if (loading && !summary) {
    return <div className="loading">Loading aggregate statistics...</div>
  }

  if (error && !summary) {
    return (
      <div className="error">
        <strong>Error:</strong> {error}
        <button onClick={() => fetchSummary(true)} className="refresh-button" style={{ marginLeft: '10px' }}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="aggregate-dashboard">
      <div className="refresh-controls">
        <button 
          onClick={handleRefresh} 
          disabled={loading}
          className="refresh-button"
        >
          {loading ? 'Refreshing...' : '🔄 Refresh'}
        </button>
      </div>

      <div className="summary-cards aggregate-cards">
        <div className="summary-card aggregate-card">
          <div className="summary-label">Total Plays (All Time)</div>
          <div className="summary-value large">
            {summary ? formatNumber(summary.totalPlays) : '...'}
          </div>
        </div>
        <div className="summary-card aggregate-card">
          <div className="summary-label">Plays (24hr)</div>
          <div className="summary-value">
            {summary ? formatNumber(summary.totalPlays24hr) : '...'}
          </div>
        </div>
        <div className="summary-card aggregate-card">
          <div className="summary-label">Plays (7 days)</div>
          <div className="summary-value">
            {summary ? formatNumber(summary.totalPlays7d) : '...'}
          </div>
        </div>
        <div className="summary-card aggregate-card">
          <div className="summary-label">Plays (30 days)</div>
          <div className="summary-value">
            {summary ? formatNumber(summary.totalPlays30d) : '...'}
          </div>
        </div>
        <div className="summary-card aggregate-card">
          <div className="summary-label">Unique Ads</div>
          <div className="summary-value">
            {summary ? summary.uniqueAds : '...'}
          </div>
        </div>
        <div className="summary-card aggregate-card">
          <div className="summary-label">Total Duration</div>
          <div className="summary-value">
            {summary ? formatDuration(summary.totalDuration) : '...'}
          </div>
        </div>
        <div className="summary-card aggregate-card">
          <div className="summary-label">Active Devices</div>
          <div className="summary-value">
            {summary ? summary.activeDevices : '...'}
          </div>
        </div>
        <div className="summary-card aggregate-card">
          <div className="summary-label">Avg Plays/Device</div>
          <div className="summary-value">
            {summary ? formatNumber(summary.avgPlaysPerDevice) : '...'}
          </div>
        </div>
      </div>
    </div>
  )
}

