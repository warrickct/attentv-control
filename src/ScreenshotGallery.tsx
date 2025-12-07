import { useState, useEffect } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface ScreenshotData {
  deviceId: string
  screenshotUrl: string | null
  screenshotKey: string | null
  lastModified: string | null
  error?: string
}

export default function ScreenshotGallery() {
  const [screenshots, setScreenshots] = useState<ScreenshotData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchScreenshots = async () => {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch(`${API_URL}/api/screenshots`)
        if (!response.ok) {
          throw new Error('Failed to fetch screenshots')
        }
        const data = await response.json()
        setScreenshots(data.screenshots || [])
      } catch (err: any) {
        setError(err.message || 'Failed to fetch screenshots')
        console.error('Error fetching screenshots:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchScreenshots()
  }, [])

  // Format device name for display (same logic as App.tsx)
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

  const formatDate = (dateString: string | null) => {
    if (!dateString) return null
    try {
      const date = new Date(dateString)
      return date.toLocaleString()
    } catch {
      return dateString
    }
  }

  if (loading) {
    return <div className="loading">Loading screenshots...</div>
  }

  if (error) {
    return (
      <div className="error">
        <strong>Error:</strong> {error}
      </div>
    )
  }

  return (
    <div className="screenshot-gallery">
      <h2>Device Screenshots</h2>
      <div className="screenshot-grid">
        {screenshots.map((screenshot) => (
          <div key={screenshot.deviceId} className="screenshot-card">
            <div className="screenshot-card-header">
              <h3>{formatDeviceName(screenshot.deviceId)}</h3>
              {screenshot.lastModified && (
                <span className="screenshot-timestamp">
                  {formatDate(screenshot.lastModified)}
                </span>
              )}
            </div>
            <div className="screenshot-image-container">
              {screenshot.screenshotUrl ? (
                <img
                  src={screenshot.screenshotUrl}
                  alt={`Screenshot for ${formatDeviceName(screenshot.deviceId)}`}
                  className="screenshot-image"
                  onError={(e) => {
                    // Fallback if image fails to load
                    const target = e.target as HTMLImageElement
                    target.style.display = 'none'
                    const placeholder = target.nextElementSibling as HTMLElement
                    if (placeholder) {
                      placeholder.style.display = 'flex'
                    }
                  }}
                />
              ) : null}
              {!screenshot.screenshotUrl && (
                <div className="screenshot-placeholder">
                  <p>No screenshot available for <strong>{formatDeviceName(screenshot.deviceId)}</strong></p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

