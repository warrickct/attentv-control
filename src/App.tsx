import { useState, useEffect, useCallback } from 'react'
import './App.css'

interface AdStatistic {
  play_id?: string
  ad_filename?: string
  device_id?: string
  environment?: string
  play_duration?: number
  play_start_time?: string
  play_end_time?: string
  play_status?: string
  switch_type?: string
  bug_detected?: boolean
  timestamp?: string
  metadata?: {
    interruption_time?: number
    interruption_reason?: string
    ad_filename?: string
    [key: string]: any
  }
  [key: string]: any
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const TABLE_NAME = 'attentv-ad-plays-prod'

function App() {
  const [stats, setStats] = useState<AdStatistic[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    if (!TABLE_NAME || TABLE_NAME === 'YOUR_TABLE_NAME_HERE') {
      setError('Table name not configured. Please update TABLE_NAME in App.tsx')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`${API_URL}/api/stats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tableName: TABLE_NAME,
          limit: 100,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to fetch statistics')
      }

      const data = await response.json()
      setStats(data.items || [])
    } catch (err: any) {
      setError(err.message || 'Failed to fetch statistics')
      console.error('Error fetching stats:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Auto-fetch on mount and refresh every 30 seconds
    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    return () => clearInterval(interval)
  }, [fetchStats])

  const formatNumber = (num: number | undefined) => {
    if (num === undefined) return 'N/A'
    return new Intl.NumberFormat().format(num)
  }

  const formatDuration = (seconds: number | undefined) => {
    if (seconds === undefined) return 'N/A'
    if (seconds < 60) return `${seconds.toFixed(2)}s`
    const mins = Math.floor(seconds / 60)
    const secs = (seconds % 60).toFixed(2)
    return `${mins}m ${secs}s`
  }

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return 'N/A'
    try {
      return new Date(dateString).toLocaleString()
    } catch {
      return dateString
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Ad Play Statistics Monitor</h1>
        <p>Monitor ad play data from AWS DynamoDB</p>
      </header>

      <div className="controls">
        <div className="input-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%' }}>
            <span style={{ fontWeight: 600, color: '#333' }}>
              Table: <code style={{ background: '#f0f0f0', padding: '0.25rem 0.5rem', borderRadius: '4px' }}>{TABLE_NAME}</code>
            </span>
            <button onClick={fetchStats} disabled={loading} style={{ marginLeft: 'auto' }}>
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {stats.length > 0 && (
        <div className="stats-container">
          <h2>Statistics ({stats.length} items)</h2>
          <div className="stats-grid">
            {stats.map((stat, index) => (
              <div key={stat.play_id || index} className="stat-card">
                <h3>{stat.ad_filename || stat.play_id || `Play ${index + 1}`}</h3>
                <div className="stat-details">
                  {stat.play_id && (
                    <div className="stat-item">
                      <span className="label">Play ID:</span>
                      <span className="value" style={{ fontSize: '0.9rem', fontFamily: 'monospace' }}>{stat.play_id}</span>
                    </div>
                  )}
                  {stat.device_id && (
                    <div className="stat-item">
                      <span className="label">Device:</span>
                      <span className="value">{stat.device_id}</span>
                    </div>
                  )}
                  {stat.environment && (
                    <div className="stat-item">
                      <span className="label">Environment:</span>
                      <span className="value">{stat.environment}</span>
                    </div>
                  )}
                  {stat.play_duration !== undefined && (
                    <div className="stat-item">
                      <span className="label">Duration:</span>
                      <span className="value">{formatDuration(stat.play_duration)}</span>
                    </div>
                  )}
                  {stat.play_status && (
                    <div className="stat-item">
                      <span className="label">Status:</span>
                      <span className="value" style={{ 
                        color: stat.play_status === 'completed' ? '#28a745' : stat.play_status === 'interrupted' ? '#dc3545' : '#ffc107',
                        fontWeight: '600'
                      }}>{stat.play_status}</span>
                    </div>
                  )}
                  {stat.switch_type && (
                    <div className="stat-item">
                      <span className="label">Switch Type:</span>
                      <span className="value">{stat.switch_type}</span>
                    </div>
                  )}
                  {stat.bug_detected !== undefined && (
                    <div className="stat-item">
                      <span className="label">Bug Detected:</span>
                      <span className="value" style={{ 
                        color: stat.bug_detected ? '#dc3545' : '#28a745',
                        fontWeight: '600'
                      }}>{stat.bug_detected ? 'Yes' : 'No'}</span>
                    </div>
                  )}
                  {stat.play_start_time && (
                    <div className="stat-item">
                      <span className="label">Start Time:</span>
                      <span className="value">{formatDate(stat.play_start_time)}</span>
                    </div>
                  )}
                  {stat.play_end_time && (
                    <div className="stat-item">
                      <span className="label">End Time:</span>
                      <span className="value">{formatDate(stat.play_end_time)}</span>
                    </div>
                  )}
                  {stat.metadata?.interruption_reason && (
                    <div className="stat-item">
                      <span className="label">Interruption Reason:</span>
                      <span className="value">{stat.metadata.interruption_reason}</span>
                    </div>
                  )}
                </div>
                <details className="raw-data">
                  <summary>Raw Data</summary>
                  <pre>{JSON.stringify(stat, null, 2)}</pre>
                </details>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && stats.length === 0 && !error && (
        <div className="empty-state">
          <p>No statistics found. Make sure the table name is correct and contains data.</p>
        </div>
      )}
    </div>
  )
}

export default App

