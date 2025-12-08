import { useState, useEffect } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001')

interface AdLeaderboardItem {
  adFilename: string
  totalPlays: number
  totalDuration: number
  averageDuration: number
  frequency: number
  deviceCount: number
  lastPlayed: string | null
}

type SortBy = 'plays' | 'duration' | 'frequency'

export default function TopAdsLeaderboard() {
  const [ads, setAds] = useState<AdLeaderboardItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortBy>('plays')
  const [limit, setLimit] = useState(20)

  useEffect(() => {
    const fetchLeaderboard = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch(`${API_URL}/api/stats/ads/leaderboard?limit=${limit}&sortBy=${sortBy}`)
        if (!response.ok) {
          throw new Error('Failed to fetch ads leaderboard')
        }
        const data = await response.json()
        setAds(data.ads || [])
      } catch (err: any) {
        setError(err.message || 'Failed to fetch ads leaderboard')
        console.error('Error fetching ads leaderboard:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchLeaderboard()
  }, [sortBy, limit])

  const formatDuration = (seconds: number | undefined) => {
    if (seconds === undefined || seconds === 0) return '0s'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`
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

  if (loading) {
    return <div className="loading">Loading top ads...</div>
  }

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="leaderboard-container">
      <div className="leaderboard-header">
        <h3>Top Performing Ads</h3>
        <div className="leaderboard-controls">
          <label>
            Sort by:
            <select 
              value={sortBy} 
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="control-select"
            >
              <option value="plays">Total Plays</option>
              <option value="duration">Total Duration</option>
              <option value="frequency">Play Frequency</option>
            </select>
          </label>
          <label>
            Limit:
            <select 
              value={limit} 
              onChange={(e) => setLimit(Number(e.target.value))}
              className="control-select"
            >
              <option value="10">Top 10</option>
              <option value="20">Top 20</option>
              <option value="50">Top 50</option>
            </select>
          </label>
        </div>
      </div>
      <div className="ads-table-container">
        <table className="ads-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Ad Filename</th>
              <th>Total Plays</th>
              <th>Total Duration</th>
              <th>Avg Duration</th>
              <th>Frequency (plays/day)</th>
              <th>Devices</th>
              <th>Last Played</th>
            </tr>
          </thead>
          <tbody>
            {ads.map((ad, index) => (
              <tr key={ad.adFilename}>
                <td>{index + 1}</td>
                <td>{ad.adFilename}</td>
                <td>{ad.totalPlays.toLocaleString()}</td>
                <td>{formatDuration(ad.totalDuration)}</td>
                <td>{formatDuration(ad.averageDuration)}</td>
                <td>{ad.frequency.toFixed(2)}</td>
                <td>{ad.deviceCount}</td>
                <td>{formatDate(ad.lastPlayed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

