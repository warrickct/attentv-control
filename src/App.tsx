import { useState, useEffect, useCallback } from 'react'
import './App.css'
import AdPlayGraph from './AdPlayGraph'
import AdDurationGraph from './AdDurationGraph'
import AggregateDashboard from './AggregateDashboard'
import HourOfDayHeatmap from './HourOfDayHeatmap'
import DayOfWeekChart from './DayOfWeekChart'
import WeekOverWeekChart from './WeekOverWeekChart'
import TopAdsLeaderboard from './TopAdsLeaderboard'
import DeviceComparisonChart from './DeviceComparisonChart'
import ScreenshotGallery from './ScreenshotGallery'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface DeviceSummary {
  deviceId: string
  plays24hr: number
  plays1hr: number
  lastPlayTime: string | null
  lastPlayData: any
}

interface AdAggregation {
  adFilename: string
  totalPlays: number
  totalDuration: number
  averageDuration: number
  lastPlayed: string | null
  error?: string
}

type ViewMode = 'screenshots' | 'overview' | 'device'

function App() {
  const [devices, setDevices] = useState<string[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('screenshots')
  const [deviceSummaries, setDeviceSummaries] = useState<Record<string, DeviceSummary>>({})
  const [adAggregations, setAdAggregations] = useState<Record<string, AdAggregation[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingDevices, setLoadingDevices] = useState(true)

  // Fetch device list from S3
  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/devices`)
      if (!response.ok) {
        throw new Error('Failed to fetch devices')
      }
      const data = await response.json()
      setDevices(data.devices || [])
      if (data.devices && data.devices.length > 0 && !selectedDevice) {
        setSelectedDevice(data.devices[0])
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch devices')
      console.error('Error fetching devices:', err)
    } finally {
      setLoadingDevices(false)
    }
  }, [selectedDevice])

  // Fetch device summary (24hr/1hr counts, last play)
  const fetchDeviceSummary = useCallback(async (deviceId: string, forceRefresh = false) => {
    try {
      const url = `${API_URL}/api/stats/device/${deviceId}/summary${forceRefresh ? '?refresh=true' : ''}`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch summary for ${deviceId}`)
      }
      const data = await response.json()
      setDeviceSummaries(prev => ({
        ...prev,
        [deviceId]: data,
      }))
    } catch (err: any) {
      console.error(`Error fetching summary for ${deviceId}:`, err)
      setDeviceSummaries(prev => ({
        ...prev,
        [deviceId]: {
          deviceId,
          plays24hr: 0,
          plays1hr: 0,
          lastPlayTime: null,
          lastPlayData: null,
        },
      }))
    }
  }, [])

  // Fetch ad aggregations for a device
  const fetchAdAggregations = useCallback(async (deviceId: string, forceRefresh = false) => {
    try {
      setLoading(true)
      const url = `${API_URL}/api/stats/device/${deviceId}/ads${forceRefresh ? '?refresh=true' : ''}`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch ad aggregations for ${deviceId}`)
      }
      const data = await response.json()
      setAdAggregations(prev => ({
        ...prev,
        [deviceId]: data.ads || [],
      }))
    } catch (err: any) {
      console.error(`Error fetching ad aggregations for ${deviceId}:`, err)
      setAdAggregations(prev => ({
        ...prev,
        [deviceId]: [],
      }))
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch data for selected device
  const fetchDeviceData = useCallback(async (deviceId: string, forceRefresh = false) => {
    await Promise.all([
      fetchDeviceSummary(deviceId, forceRefresh),
      fetchAdAggregations(deviceId, forceRefresh),
    ])
  }, [fetchDeviceSummary, fetchAdAggregations])

  // Manual refresh handler
  const handleRefresh = useCallback(() => {
    if (selectedDevice) {
      fetchDeviceData(selectedDevice, true)
    }
  }, [selectedDevice, fetchDeviceData])

  // Initial load
  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  // Fetch data when device is selected
  useEffect(() => {
    if (selectedDevice) {
      fetchDeviceData(selectedDevice)
    }
  }, [selectedDevice, fetchDeviceData])

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

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return 'Never'
    try {
      const date = new Date(dateString)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMins = Math.floor(diffMs / 60000)
      const diffHours = Math.floor(diffMs / 3600000)
      const diffDays = Math.floor(diffMs / 86400000)

      if (diffMins < 1) return 'Just now'
      if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`
      if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
      if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`
      return date.toLocaleString()
    } catch {
      return dateString
    }
  }

  // Format device name for display
  const formatDeviceName = (deviceId: string): string => {
    // Special mappings
    if (deviceId === 'attntv-nuc-1') {
      return 'The Dava'
    }
    if (deviceId === 'attentv-edge-3-flying-duck') {
      return 'Flying Duck'
    }
    
    // Extract part after "attentv-<number>-"
    const match = deviceId.match(/^attentv-\d+-(.+)$/)
    if (match) {
      return match[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    }
    
    // Fallback to original if pattern doesn't match
    return deviceId
  }

  const currentSummary = selectedDevice ? deviceSummaries[selectedDevice] : null
  const currentAds = selectedDevice ? adAggregations[selectedDevice] || [] : []

  return (
    <div className="app">
      <header className="header">
        <h1>Ad Play Statistics Dashboard</h1>
        <p>Monitor ad play data by device from AWS DynamoDB</p>
      </header>

      {loadingDevices ? (
        <div className="loading">Loading devices...</div>
      ) : error ? (
        <div className="error">
          <strong>Error:</strong> {error}
        </div>
      ) : devices.length === 0 ? (
        <div className="empty-state">
          <p>No devices found in S3 bucket.</p>
        </div>
      ) : (
        <>
          {/* View Mode Tabs */}
          <div className="view-mode-tabs">
            <button
              className={`view-mode-tab ${viewMode === 'screenshots' ? 'active' : ''}`}
              onClick={() => setViewMode('screenshots')}
            >
              Screenshots
            </button>
            <button
              className={`view-mode-tab ${viewMode === 'overview' ? 'active' : ''}`}
              onClick={() => setViewMode('overview')}
            >
              Overview
            </button>
            <button
              className={`view-mode-tab ${viewMode === 'device' ? 'active' : ''}`}
              onClick={() => {
                setViewMode('device')
                if (!selectedDevice && devices.length > 0) {
                  setSelectedDevice(devices[0])
                }
              }}
            >
              Device Details
            </button>
          </div>

          {viewMode === 'screenshots' ? (
            <div className="screenshots-content">
              <ScreenshotGallery />
            </div>
          ) : viewMode === 'overview' ? (
            <div className="overview-content">
              <AggregateDashboard />
              
              <div className="insights-section">
                <h2>Time-Based Patterns</h2>
                <div className="charts-grid">
                  <div className="chart-item">
                    <HourOfDayHeatmap includeDayOfWeek={false} />
                  </div>
                  <div className="chart-item">
                    <DayOfWeekChart />
                  </div>
                  <div className="chart-item full-width">
                    <WeekOverWeekChart />
                  </div>
                </div>
              </div>

              <div className="insights-section">
                <h2>Performance Insights</h2>
                <div className="charts-grid">
                  <div className="chart-item full-width">
                    <TopAdsLeaderboard />
                  </div>
                  <div className="chart-item full-width">
                    <DeviceComparisonChart />
                  </div>
                </div>
              </div>
            </div>
          ) : selectedDevice && (
            <div className="device-content">
              {/* Device Tabs */}
              <div className="device-tabs">
                {devices.map(device => (
                  <button
                    key={device}
                    className={`device-tab ${selectedDevice === device ? 'active' : ''}`}
                    onClick={() => setSelectedDevice(device)}
                    title={device}
                  >
                    {formatDeviceName(device)}
                    {deviceSummaries[device] && (
                      <span className="tab-badge">{deviceSummaries[device].plays24hr}</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Refresh Button */}
              <div className="refresh-controls">
                <button 
                  onClick={handleRefresh} 
                  disabled={loading}
                  className="refresh-button"
                >
                  {loading ? 'Refreshing...' : '🔄 Refresh'}
                </button>
              </div>

              {/* Summary Cards */}
              <div className="summary-cards">
                <div className="summary-card">
                  <div className="summary-label">Plays (24hr)</div>
                  <div className="summary-value">
                    {currentSummary?.plays24hr ?? '...'}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Plays (1hr)</div>
                  <div className="summary-value">
                    {currentSummary?.plays1hr ?? '...'}
                  </div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Last Play</div>
                  <div className="summary-value small">
                    {currentSummary?.lastPlayTime 
                      ? formatDate(currentSummary.lastPlayTime)
                      : '...'}
                  </div>
                </div>
              </div>

              {/* Time Series Graph - Plays */}
              <div className="graph-section">
                <h2>Ad Plays Over Time</h2>
                <AdPlayGraph deviceId={selectedDevice} />
              </div>

              {/* Time Series Graph - Duration */}
              <div className="graph-section">
                <h2>Ad Duration Over Time</h2>
                <AdDurationGraph deviceId={selectedDevice} />
              </div>

              {/* Ad Aggregations Table */}
              <div className="ads-section">
                <h2>Ad Statistics</h2>
                {loading ? (
                  <div className="loading">Loading ad statistics...</div>
                ) : currentAds.length === 0 ? (
                  <div className="empty-state">
                    <p>No ad statistics available for this device.</p>
                  </div>
                ) : (
                  <div className="ads-table-container">
                    <table className="ads-table">
                      <thead>
                        <tr>
                          <th>Ad Filename</th>
                          <th>Total Plays</th>
                          <th>Total Duration</th>
                          <th>Average Duration</th>
                          <th>Last Played</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentAds.map((ad, index) => (
                          <tr key={ad.adFilename || index}>
                            <td>{ad.adFilename}</td>
                            <td>{ad.totalPlays}</td>
                            <td>{formatDuration(ad.totalDuration)}</td>
                            <td>{formatDuration(ad.averageDuration)}</td>
                            <td>{formatDate(ad.lastPlayed)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default App
