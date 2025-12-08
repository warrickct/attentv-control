import express from 'express'
import cors from 'cors'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { fromIni } from '@aws-sdk/credential-providers'

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || '0.0.0.0' // Bind to all interfaces for network access

// Middleware
app.use(cors())
app.use(express.json())

// Serve static files from dist directory in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')))
}

// Handle favicon requests to avoid CSP errors
app.get('/favicon.ico', (req, res) => {
  res.status(204).end()
})

// Initialize AWS clients
// Using attentv-terraform profile which has DynamoDB and S3 permissions
const profileName = process.env.AWS_PROFILE || 'attentv-terraform'
const region = process.env.AWS_REGION || 'ap-southeast-2'
const awsCredentials = fromIni({ profile: profileName })

const client = new DynamoDBClient({
  region,
  credentials: awsCredentials,
})
const docClient = DynamoDBDocumentClient.from(client)

const s3Client = new S3Client({
  region,
  credentials: awsCredentials,
})

const S3_BUCKET = 'attntv'
const SCREENSHOT_BUCKET = process.env.NODE_ENV === 'production' 
  ? 'attentv-iot-screenshots-prod' 
  : 'attentv-iot-screenshots-dev'

// Cache for device data (in-memory)
interface CacheEntry<T> {
  data: T
  timestamp: number
}

const CACHE_TTL = 30000 // 30 seconds
const AGGREGATE_CACHE_TTL = 60000 // 60 seconds for aggregate queries
const deviceSummaryCache = new Map<string, CacheEntry<any>>()
const deviceAdsCache = new Map<string, CacheEntry<any>>()
const aggregateCache = new Map<string, CacheEntry<any>>()

// Helper to get cached data or null if expired
function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string, ttl: number = CACHE_TTL): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  
  const age = Date.now() - entry.timestamp
  if (age > ttl) {
    cache.delete(key)
    return null
  }
  
  return entry.data
}

// Helper to set cached data
function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
  cache.set(key, {
    data,
    timestamp: Date.now(),
  })
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Get list of devices from S3 bucket (folder names)
app.get('/api/devices', async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Delimiter: '/',
    })

    const response = await s3Client.send(command)
    const devices = (response.CommonPrefixes || [])
      .map(prefix => prefix.Prefix?.replace('/', ''))
      .filter((device): device is string => !!device && device !== 'ad_metrics')
      .sort()

    res.json({ devices })
  } catch (error: any) {
    console.error('Error listing devices:', error)
    res.status(500).json({
      error: error.message || 'Failed to list devices',
      code: error.name,
    })
  }
})

// Get list of ad files for a specific device
app.get('/api/devices/:deviceId/ads', async (req, res) => {
  try {
    const { deviceId } = req.params
    const prefix = `${deviceId}/`

    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
    })

    const response = await s3Client.send(command)
    const ads = (response.Contents || [])
      .map(obj => obj.Key?.replace(prefix, ''))
      .filter((ad): ad is string => !!ad && ad.endsWith('.mp4'))
      .sort()

    res.json({ deviceId, ads })
  } catch (error: any) {
    console.error('Error listing ads:', error)
    res.status(500).json({
      error: error.message || 'Failed to list ads',
      code: error.name,
    })
  }
})

// Helper function to get ISO timestamp for N hours ago
const getHoursAgoTimestamp = (hours: number): string => {
  const date = new Date()
  date.setHours(date.getHours() - hours)
  return date.toISOString()
}

// Get aggregated stats for a device
app.get('/api/stats/device/:deviceId/summary', async (req, res) => {
  try {
    const { deviceId } = req.params
    const forceRefresh = req.query.refresh === 'true'
    
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = getCached(deviceSummaryCache, deviceId)
      if (cached) {
        return res.json(cached)
      }
    }

    const tableName = 'attentv-ad-plays-prod'
    const oneHourAgo = getHoursAgoTimestamp(1)
    const twentyFourHoursAgo = getHoursAgoTimestamp(24)

    // Query for plays in past 24 hours
    const query24hr = new QueryCommand({
      TableName: tableName,
      IndexName: 'device-index',
      KeyConditionExpression: '#device = :device AND #timestamp >= :timestamp24hr',
      ExpressionAttributeNames: {
        '#device': 'device_id',
        '#timestamp': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':device': deviceId,
        ':timestamp24hr': twentyFourHoursAgo,
      },
      Select: 'COUNT',
    })

    // Query for plays in past 1 hour
    const query1hr = new QueryCommand({
      TableName: tableName,
      IndexName: 'device-index',
      KeyConditionExpression: '#device = :device AND #timestamp >= :timestamp1hr',
      ExpressionAttributeNames: {
        '#device': 'device_id',
        '#timestamp': 'timestamp',
      },
      ExpressionAttributeValues: {
        ':device': deviceId,
        ':timestamp1hr': oneHourAgo,
      },
      Select: 'COUNT',
    })

    // Query for last play time (most recent)
    const queryLast = new QueryCommand({
      TableName: tableName,
      IndexName: 'device-index',
      KeyConditionExpression: '#device = :device',
      ExpressionAttributeNames: {
        '#device': 'device_id',
      },
      ExpressionAttributeValues: {
        ':device': deviceId,
      },
      Limit: 1,
      ScanIndexForward: false, // Get most recent first
    })

    const [result24hr, result1hr, resultLast] = await Promise.all([
      docClient.send(query24hr),
      docClient.send(query1hr),
      docClient.send(queryLast),
    ])

    const response = {
      deviceId,
      plays24hr: result24hr.Count ?? 0,
      plays1hr: result1hr.Count ?? 0,
      lastPlayTime: resultLast.Items?.[0]?.timestamp || null,
      lastPlayData: resultLast.Items?.[0] || null,
    }

    // Cache the response
    setCached(deviceSummaryCache, deviceId, response)

    res.json(response)
  } catch (error: any) {
    console.error('Error fetching device summary:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch device summary',
      code: error.name,
    })
  }
})

// Get all play data for a device (for time series)
app.get('/api/stats/device/:deviceId/timeseries', async (req, res) => {
  try {
    const { deviceId } = req.params
    const tableName = 'attentv-ad-plays-prod'

    // Get all items for this device (with pagination)
    const items: any[] = []
    let lastEvaluatedKey = undefined
    let hasMore = true

    while (hasMore) {
      const queryParams: any = {
        TableName: tableName,
        IndexName: 'device-index',
        KeyConditionExpression: '#device = :device',
        ExpressionAttributeNames: {
          '#device': 'device_id',
        },
        ExpressionAttributeValues: {
          ':device': deviceId,
        },
      }

      if (lastEvaluatedKey) {
        queryParams.ExclusiveStartKey = lastEvaluatedKey
      }

      const query = new QueryCommand(queryParams)
      const response = await docClient.send(query)
      
      if (response.Items) {
        items.push(...response.Items)
      }
      
      lastEvaluatedKey = response.LastEvaluatedKey
      hasMore = !!lastEvaluatedKey
    }

    // Return items with timestamp and ad_filename
    const timeSeriesData = items.map(item => ({
      timestamp: item.timestamp,
      ad_filename: item.ad_filename,
      play_duration: item.play_duration,
      play_id: item.play_id,
    }))

    res.json({
      deviceId,
      items: timeSeriesData,
      count: timeSeriesData.length,
    })
  } catch (error: any) {
    console.error('Error fetching time series data:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch time series data',
      code: error.name,
    })
  }
})

// Get per-ad aggregations for a device
app.get('/api/stats/device/:deviceId/ads', async (req, res) => {
  try {
    const { deviceId } = req.params
    const forceRefresh = req.query.refresh === 'true'
    
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = getCached(deviceAdsCache, deviceId)
      if (cached) {
        return res.json(cached)
      }
    }

    const tableName = 'attentv-ad-plays-prod'

    // First, get list of ads for this device from S3
    const prefix = `${deviceId}/`
    const s3Command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
    })
    const s3Response = await s3Client.send(s3Command)
    const ads = (s3Response.Contents || [])
      .map(obj => obj.Key?.replace(prefix, ''))
      .filter((ad): ad is string => !!ad && ad.endsWith('.mp4'))
      .sort()

    // Query DynamoDB for each ad using device-index (more efficient)
    // Query by device_id, then filter by ad_filename
    const adStats = await Promise.all(
      ads.map(async (adFilename) => {
        try {
          // Get all items for this device and ad (with pagination)
          const items: any[] = []
          let lastEvaluatedKey = undefined
          let hasMore = true

          while (hasMore) {
            const queryParams: any = {
              TableName: tableName,
              IndexName: 'device-index',
              KeyConditionExpression: '#device = :device',
              FilterExpression: '#ad = :ad',
              ExpressionAttributeNames: {
                '#device': 'device_id',
                '#ad': 'ad_filename',
              },
              ExpressionAttributeValues: {
                ':device': deviceId,
                ':ad': adFilename,
              },
            }

            // Only add ExclusiveStartKey if we have one (not on first iteration)
            if (lastEvaluatedKey) {
              queryParams.ExclusiveStartKey = lastEvaluatedKey
            }

            const paginatedQuery = new QueryCommand(queryParams)
            const response = await docClient.send(paginatedQuery)
            
            // Add items that passed the filter
            if (response.Items) {
              items.push(...response.Items)
            }
            
            // Check if there are more pages
            lastEvaluatedKey = response.LastEvaluatedKey
            hasMore = !!lastEvaluatedKey
          }

          // Calculate aggregations
          const totalPlays = items.length
          const totalDuration = items.reduce((sum, item) => sum + (item.play_duration || 0), 0)
          const averageDuration = totalPlays > 0 ? totalDuration / totalPlays : 0
          
          // Find last played timestamp
          let lastPlayed: string | null = null
          if (items.length > 0) {
            const sorted = [...items].sort((a, b) => {
              const timeA = new Date(a.timestamp || 0).getTime()
              const timeB = new Date(b.timestamp || 0).getTime()
              return timeB - timeA
            })
            lastPlayed = sorted[0]?.timestamp || null
          }

          return {
            adFilename,
            totalPlays,
            totalDuration,
            averageDuration,
            lastPlayed,
          }
        } catch (error: any) {
          console.error(`Error fetching stats for ad ${adFilename}:`, error)
          return {
            adFilename,
            totalPlays: 0,
            totalDuration: 0,
            averageDuration: 0,
            lastPlayed: null,
            error: error.message,
          }
        }
      })
    )

    const response = {
      deviceId,
      ads: adStats,
    }

    // Cache the response
    setCached(deviceAdsCache, deviceId, response)

    res.json(response)
  } catch (error: any) {
    console.error('Error fetching ad aggregations:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch ad aggregations',
      code: error.name,
    })
  }
})

// Helper function to get all devices
async function getAllDevices(): Promise<string[]> {
  try {
    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Delimiter: '/',
    })
    const response = await s3Client.send(command)
    return (response.CommonPrefixes || [])
      .map(prefix => prefix.Prefix?.replace('/', ''))
      .filter((device): device is string => !!device && device !== 'ad_metrics')
      .sort()
  } catch (error) {
    console.error('Error getting devices:', error)
    return []
  }
}

// Helper function to get all items for a device with pagination
async function getAllItemsForDevice(deviceId: string): Promise<any[]> {
  const tableName = 'attentv-ad-plays-prod'
  const items: any[] = []
  let lastEvaluatedKey = undefined
  let hasMore = true

  while (hasMore) {
    const queryParams: any = {
      TableName: tableName,
      IndexName: 'device-index',
      KeyConditionExpression: '#device = :device',
      ExpressionAttributeNames: {
        '#device': 'device_id',
      },
      ExpressionAttributeValues: {
        ':device': deviceId,
      },
    }

    if (lastEvaluatedKey) {
      queryParams.ExclusiveStartKey = lastEvaluatedKey
    }

    const query = new QueryCommand(queryParams)
    const response = await docClient.send(query)
    
    if (response.Items) {
      items.push(...response.Items)
    }
    
    lastEvaluatedKey = response.LastEvaluatedKey
    hasMore = !!lastEvaluatedKey
  }

  return items
}

// Get aggregate summary across all devices
app.get('/api/stats/aggregate/summary', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = 'aggregate-summary'
    
    if (!forceRefresh) {
      const cached = getCached(aggregateCache, cacheKey, AGGREGATE_CACHE_TTL)
      if (cached) {
        return res.json(cached)
      }
    }

    const devices = await getAllDevices()
    const tableName = 'attentv-ad-plays-prod'
    
    const now = new Date()
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Get all items across all devices
    const allItems: any[] = []
    const uniqueAds = new Set<string>()
    let totalDuration = 0

    for (const deviceId of devices) {
      const items = await getAllItemsForDevice(deviceId)
      allItems.push(...items)
      
      items.forEach(item => {
        if (item.ad_filename) uniqueAds.add(item.ad_filename)
        if (item.play_duration) totalDuration += item.play_duration
      })
    }

    const totalPlays = allItems.length
    const totalPlays24hr = allItems.filter(item => item.timestamp >= oneDayAgo).length
    const totalPlays7d = allItems.filter(item => item.timestamp >= sevenDaysAgo).length
    const totalPlays30d = allItems.filter(item => item.timestamp >= thirtyDaysAgo).length
    const activeDevices = devices.length
    const avgPlaysPerDevice = activeDevices > 0 ? totalPlays / activeDevices : 0

    const response = {
      totalPlays,
      totalPlays24hr,
      totalPlays7d,
      totalPlays30d,
      uniqueAds: uniqueAds.size,
      totalDuration,
      activeDevices,
      avgPlaysPerDevice: Math.round(avgPlaysPerDevice * 100) / 100,
    }

    setCached(aggregateCache, cacheKey, response)
    res.json(response)
  } catch (error: any) {
    console.error('Error fetching aggregate summary:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch aggregate summary',
      code: error.name,
    })
  }
})

// Get hourly patterns (hour of day and optionally day of week)
app.get('/api/stats/aggregate/hourly-patterns', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true'
    const includeDayOfWeek = req.query.dayOfWeek === 'true'
    const cacheKey = `hourly-patterns-${includeDayOfWeek}`
    
    if (!forceRefresh) {
      const cached = getCached(aggregateCache, cacheKey, AGGREGATE_CACHE_TTL)
      if (cached) {
        return res.json(cached)
      }
    }

    const devices = await getAllDevices()
    const allItems: any[] = []

    for (const deviceId of devices) {
      const items = await getAllItemsForDevice(deviceId)
      allItems.push(...items)
    }

    // Group by hour (and optionally day of week)
    const hourMap = new Map<string, { plays: number, duration: number }>()

    allItems.forEach(item => {
      if (!item.timestamp) return
      
      const date = new Date(item.timestamp)
      const hour = date.getUTCHours()
      const dayOfWeek = includeDayOfWeek ? date.getUTCDay() : null
      const key = includeDayOfWeek ? `${hour}-${dayOfWeek}` : `${hour}`
      
      const existing = hourMap.get(key) || { plays: 0, duration: 0 }
      hourMap.set(key, {
        plays: existing.plays + 1,
        duration: existing.duration + (item.play_duration || 0),
      })
    })

    const result = Array.from(hourMap.entries()).map(([key, data]) => {
      const [hour, dayOfWeek] = key.split('-').map(Number)
      return {
        hour: Number(hour),
        dayOfWeek: includeDayOfWeek && dayOfWeek !== undefined ? dayOfWeek : undefined,
        plays: data.plays,
        duration: data.duration,
      }
    })

    const response = { patterns: result }
    setCached(aggregateCache, cacheKey, response)
    res.json(response)
  } catch (error: any) {
    console.error('Error fetching hourly patterns:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch hourly patterns',
      code: error.name,
    })
  }
})

// Get day of week patterns
app.get('/api/stats/aggregate/day-of-week', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = 'day-of-week'
    
    if (!forceRefresh) {
      const cached = getCached(aggregateCache, cacheKey, AGGREGATE_CACHE_TTL)
      if (cached) {
        return res.json(cached)
      }
    }

    const devices = await getAllDevices()
    const allItems: any[] = []

    for (const deviceId of devices) {
      const items = await getAllItemsForDevice(deviceId)
      allItems.push(...items)
    }

    // Group by day of week (0 = Sunday, 6 = Saturday)
    const dayMap = new Map<number, { plays: number, duration: number }>()

    allItems.forEach(item => {
      if (!item.timestamp) return
      
      const date = new Date(item.timestamp)
      const dayOfWeek = date.getUTCDay()
      
      const existing = dayMap.get(dayOfWeek) || { plays: 0, duration: 0 }
      dayMap.set(dayOfWeek, {
        plays: existing.plays + 1,
        duration: existing.duration + (item.play_duration || 0),
      })
    })

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const result = Array.from(dayMap.entries())
      .map(([dayOfWeek, data]) => ({
        dayOfWeek,
        dayName: dayNames[dayOfWeek],
        plays: data.plays,
        duration: data.duration,
      }))
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek)

    const response = { patterns: result }
    setCached(aggregateCache, cacheKey, response)
    res.json(response)
  } catch (error: any) {
    console.error('Error fetching day of week patterns:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch day of week patterns',
      code: error.name,
    })
  }
})

// Get week-over-week comparison
app.get('/api/stats/aggregate/week-comparison', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = 'week-comparison'
    
    if (!forceRefresh) {
      const cached = getCached(aggregateCache, cacheKey, AGGREGATE_CACHE_TTL)
      if (cached) {
        return res.json(cached)
      }
    }

    const devices = await getAllDevices()
    const allItems: any[] = []

    for (const deviceId of devices) {
      const items = await getAllItemsForDevice(deviceId)
      allItems.push(...items)
    }

    const now = new Date()
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)

    // Current week (last 7 days)
    const currentWeekItems = allItems.filter(item => {
      if (!item.timestamp) return false
      const date = new Date(item.timestamp)
      return date >= oneWeekAgo
    })

    // Previous week (7-14 days ago)
    const previousWeekItems = allItems.filter(item => {
      if (!item.timestamp) return false
      const date = new Date(item.timestamp)
      return date >= twoWeeksAgo && date < oneWeekAgo
    })

    const getWeekStats = (items: any[]) => {
      const uniqueAds = new Set<string>()
      let totalDuration = 0
      
      items.forEach(item => {
        if (item.ad_filename) uniqueAds.add(item.ad_filename)
        if (item.play_duration) totalDuration += item.play_duration
      })

      return {
        plays: items.length,
        duration: totalDuration,
        uniqueAds: uniqueAds.size,
      }
    }

    const currentWeek = getWeekStats(currentWeekItems)
    const previousWeek = getWeekStats(previousWeekItems)

    const change = {
      plays: currentWeek.plays - previousWeek.plays,
      duration: currentWeek.duration - previousWeek.duration,
      uniqueAds: currentWeek.uniqueAds - previousWeek.uniqueAds,
    }

    const response = {
      currentWeek,
      previousWeek,
      change,
    }

    setCached(aggregateCache, cacheKey, response)
    res.json(response)
  } catch (error: any) {
    console.error('Error fetching week comparison:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch week comparison',
      code: error.name,
    })
  }
})

// Get top ads leaderboard across all devices
app.get('/api/stats/ads/leaderboard', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true'
    const limit = parseInt(req.query.limit as string) || 20
    const sortBy = (req.query.sortBy as string) || 'plays' // plays, duration, frequency
    const cacheKey = `ads-leaderboard-${limit}-${sortBy}`
    
    if (!forceRefresh) {
      const cached = getCached(aggregateCache, cacheKey, AGGREGATE_CACHE_TTL)
      if (cached) {
        return res.json(cached)
      }
    }

    const devices = await getAllDevices()
    const tableName = 'attentv-ad-plays-prod'
    
    // Get all unique ads from S3
    const allAds = new Set<string>()
    for (const deviceId of devices) {
      const prefix = `${deviceId}/`
      const s3Command = new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
      })
      const s3Response = await s3Client.send(s3Command)
      const ads = (s3Response.Contents || [])
        .map(obj => obj.Key?.replace(prefix, ''))
        .filter((ad): ad is string => !!ad && ad.endsWith('.mp4'))
      ads.forEach(ad => allAds.add(ad))
    }

    // Get stats for each ad across all devices
    const adStats = await Promise.all(
      Array.from(allAds).map(async (adFilename) => {
        try {
          const items: any[] = []
          const deviceSet = new Set<string>()

          // Query each device for this ad
          for (const deviceId of devices) {
            let lastEvaluatedKey = undefined
            let hasMore = true

            while (hasMore) {
              const queryParams: any = {
                TableName: tableName,
                IndexName: 'device-index',
                KeyConditionExpression: '#device = :device',
                FilterExpression: '#ad = :ad',
                ExpressionAttributeNames: {
                  '#device': 'device_id',
                  '#ad': 'ad_filename',
                },
                ExpressionAttributeValues: {
                  ':device': deviceId,
                  ':ad': adFilename,
                },
              }

              if (lastEvaluatedKey) {
                queryParams.ExclusiveStartKey = lastEvaluatedKey
              }

              const query = new QueryCommand(queryParams)
              const response = await docClient.send(query)
              
              if (response.Items) {
                items.push(...response.Items)
                deviceSet.add(deviceId)
              }
              
              lastEvaluatedKey = response.LastEvaluatedKey
              hasMore = !!lastEvaluatedKey
            }
          }

          const totalPlays = items.length
          const totalDuration = items.reduce((sum, item) => sum + (item.play_duration || 0), 0)
          const averageDuration = totalPlays > 0 ? totalDuration / totalPlays : 0
          
          // Calculate frequency (plays per day)
          let frequency = 0
          if (items.length > 0) {
            const sorted = items.sort((a, b) => {
              const timeA = new Date(a.timestamp || 0).getTime()
              const timeB = new Date(b.timestamp || 0).getTime()
              return timeA - timeB
            })
            const firstPlay = new Date(sorted[0].timestamp)
            const lastPlay = new Date(sorted[sorted.length - 1].timestamp)
            const daysDiff = Math.max(1, (lastPlay.getTime() - firstPlay.getTime()) / (1000 * 60 * 60 * 24))
            frequency = totalPlays / daysDiff
          }

          // Find last played
          let lastPlayed: string | null = null
          if (items.length > 0) {
            const sorted = [...items].sort((a, b) => {
              const timeA = new Date(a.timestamp || 0).getTime()
              const timeB = new Date(b.timestamp || 0).getTime()
              return timeB - timeA
            })
            lastPlayed = sorted[0]?.timestamp || null
          }

          return {
            adFilename,
            totalPlays,
            totalDuration,
            averageDuration,
            frequency: Math.round(frequency * 100) / 100,
            deviceCount: deviceSet.size,
            lastPlayed,
          }
        } catch (error: any) {
          console.error(`Error fetching stats for ad ${adFilename}:`, error)
          return {
            adFilename,
            totalPlays: 0,
            totalDuration: 0,
            averageDuration: 0,
            frequency: 0,
            deviceCount: 0,
            lastPlayed: null,
            error: error.message,
          }
        }
      })
    )

    // Sort by requested field
    const sorted = adStats.sort((a, b) => {
      switch (sortBy) {
        case 'duration':
          return b.totalDuration - a.totalDuration
        case 'frequency':
          return b.frequency - a.frequency
        case 'plays':
        default:
          return b.totalPlays - a.totalPlays
      }
    })

    const response = {
      ads: sorted.slice(0, limit),
      total: sorted.length,
    }

    setCached(aggregateCache, cacheKey, response)
    res.json(response)
  } catch (error: any) {
    console.error('Error fetching ads leaderboard:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch ads leaderboard',
      code: error.name,
    })
  }
})

// Get device comparison metrics
app.get('/api/stats/devices/comparison', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = 'devices-comparison'
    
    if (!forceRefresh) {
      const cached = getCached(aggregateCache, cacheKey, AGGREGATE_CACHE_TTL)
      if (cached) {
        return res.json(cached)
      }
    }

    const devices = await getAllDevices()
    const tableName = 'attentv-ad-plays-prod'
    
    const deviceStats = await Promise.all(
      devices.map(async (deviceId) => {
        const items = await getAllItemsForDevice(deviceId)
        
        const totalPlays = items.length
        const totalDuration = items.reduce((sum, item) => sum + (item.play_duration || 0), 0)
        
        // Calculate average plays per day
        let avgPlaysPerDay = 0
        if (items.length > 0) {
          const sorted = items.sort((a, b) => {
            const timeA = new Date(a.timestamp || 0).getTime()
            const timeB = new Date(b.timestamp || 0).getTime()
            return timeA - timeB
          })
          const firstPlay = new Date(sorted[0].timestamp)
          const lastPlay = new Date(sorted[sorted.length - 1].timestamp)
          const daysDiff = Math.max(1, (lastPlay.getTime() - firstPlay.getTime()) / (1000 * 60 * 60 * 24))
          avgPlaysPerDay = totalPlays / daysDiff
        }

        return {
          deviceId,
          totalPlays,
          avgPlaysPerDay: Math.round(avgPlaysPerDay * 100) / 100,
          totalDuration,
        }
      })
    )

    const response = { devices: deviceStats }
    setCached(aggregateCache, cacheKey, response)
    res.json(response)
  } catch (error: any) {
    console.error('Error fetching device comparison:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch device comparison',
      code: error.name,
    })
  }
})

// Get statistics from DynamoDB table
// Supports both Scan and Query operations
// Query options:
// - Primary key: { partitionKey: "play_id", partitionValue: "xxx" }
// - GSI ad-file-index: { partitionKey: "ad_filename", partitionValue: "xxx", indexName: "ad-file-index" }
// - GSI device-index: { partitionKey: "device_id", partitionValue: "xxx", indexName: "device-index" }
// - Timestamp range: { sortKey: "timestamp", sortValueStart: "xxx", sortValueEnd: "xxx" }
app.post('/api/stats', async (req, res) => {
  try {
    const { 
      tableName, 
      limit = 100, 
      partitionKey, 
      partitionValue, 
      sortKey, 
      sortValue,
      sortValueStart,
      sortValueEnd,
      indexName
    } = req.body

    if (!tableName) {
      return res.status(400).json({ error: 'Table name is required' })
    }

    let command;
    
    // If partition key is provided, use Query instead of Scan
    if (partitionKey && partitionValue !== undefined) {
      const attrNames: Record<string, string> = {}
      const attrValues: Record<string, any> = {}
      const conditions: string[] = []
      
      // Partition key condition (required)
      attrNames['#pk'] = partitionKey
      attrValues[':pk'] = partitionValue
      conditions.push('#pk = :pk')
      
      // Sort key condition (optional)
      if (sortKey) {
        attrNames['#sk'] = sortKey
        
        if (sortValueStart !== undefined && sortValueEnd !== undefined) {
          // Range query: BETWEEN start AND end
          attrValues[':sk_start'] = sortValueStart
          attrValues[':sk_end'] = sortValueEnd
          conditions.push('#sk BETWEEN :sk_start AND :sk_end')
        } else if (sortValue !== undefined) {
          // Exact match
          attrValues[':sk'] = sortValue
          conditions.push('#sk = :sk')
        } else if (sortValueStart !== undefined) {
          // Greater than or equal
          attrValues[':sk_start'] = sortValueStart
          conditions.push('#sk >= :sk_start')
        } else if (sortValueEnd !== undefined) {
          // Less than or equal
          attrValues[':sk_end'] = sortValueEnd
          conditions.push('#sk <= :sk_end')
        }
      }
      
      const queryParams: any = {
        TableName: tableName,
        KeyConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: attrNames,
        ExpressionAttributeValues: attrValues,
        Limit: limit,
      }
      
      // Use GSI if specified
      if (indexName) {
        queryParams.IndexName = indexName
      }
      
      command = new QueryCommand(queryParams)
    } else {
      // Default to Scan if no partition key provided
      command = new ScanCommand({
        TableName: tableName,
        Limit: limit,
      })
    }

    const response = await docClient.send(command)
    res.json({
      items: response.Items || [],
      count: response.Count || 0,
      scannedCount: response.ScannedCount || 0,
    })
  } catch (error: any) {
    console.error('Error fetching stats:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch statistics',
      code: error.name,
    })
  }
})

// Get list of tables (optional - requires ListTables permission)
app.get('/api/tables', async (req, res) => {
  try {
    const { ListTablesCommand } = await import('@aws-sdk/client-dynamodb')
    const command = new ListTablesCommand({})
    const response = await client.send(command)
    res.json({ tables: response.TableNames || [] })
  } catch (error: any) {
    console.error('Error listing tables:', error)
    res.status(500).json({
      error: error.message || 'Failed to list tables',
      code: error.name,
    })
  }
})

// Get latest screenshots for all devices
app.get('/api/screenshots', async (req, res) => {
  try {
    const devices = await getAllDevices()
    const screenshotData = await Promise.all(
      devices.map(async (deviceId) => {
        try {
          const prefix = `${deviceId}/`
          const command = new ListObjectsV2Command({
            Bucket: SCREENSHOT_BUCKET,
            Prefix: prefix,
          })

          const response = await s3Client.send(command)
          const screenshots = (response.Contents || [])
            .filter(obj => obj.Key && obj.Key.endsWith('.png'))
            .sort((a, b) => {
              // Sort by LastModified date (most recent first)
              const timeA = a.LastModified?.getTime() || 0
              const timeB = b.LastModified?.getTime() || 0
              return timeB - timeA
            })

          if (screenshots.length === 0) {
            return {
              deviceId,
              screenshotUrl: null,
              screenshotKey: null,
              lastModified: null,
            }
          }

          const latest = screenshots[0]
          const screenshotKey = latest.Key!

          // Generate presigned URL (valid for 1 hour)
          const getObjectCommand = new GetObjectCommand({
            Bucket: SCREENSHOT_BUCKET,
            Key: screenshotKey,
          })
          
          const screenshotUrl = await getSignedUrl(s3Client, getObjectCommand, { expiresIn: 3600 })

          return {
            deviceId,
            screenshotUrl,
            screenshotKey,
            lastModified: latest.LastModified?.toISOString() || null,
          }
        } catch (error: any) {
          console.error(`Error fetching screenshot for ${deviceId}:`, error)
          return {
            deviceId,
            screenshotUrl: null,
            screenshotKey: null,
            lastModified: null,
            error: error.message,
          }
        }
      })
    )

    res.json({ screenshots: screenshotData })
  } catch (error: any) {
    console.error('Error fetching screenshots:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch screenshots',
      code: error.name,
    })
  }
})

// Serve React app for all non-API routes (production only)
if (process.env.NODE_ENV === 'production') {
  app.get('/*', (req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.sendFile(path.join(__dirname, 'dist', 'index.html'))
  })
}

app.listen(Number(PORT), HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`)
  console.log(`📊 Ad Statistics Monitor API ready`)
  if (process.env.NODE_ENV === 'production') {
    console.log(`🌐 Access from network: http://<your-ip>:${PORT}`)
  }
})

