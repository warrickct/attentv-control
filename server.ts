import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { fromIni } from '@aws-sdk/credential-providers'
import { loadLocalEnv } from './server/loadEnv'
import { registerAuthRoutes } from './server/auth'
import { registerQuickQuestionRoutes } from './server/quickQuestion'
import { requireSession } from './server/session'
import { registerModelPerformanceRoutes } from './server/modelPerformance'
import { getDataLabelChannels, getDataLabels } from './server/dataLabels'
import {
  getAdsLeaderboard,
  getAggregateSummary,
  getDayOfWeekPatterns,
  getDeviceAds,
  getDeviceSummary,
  getDeviceTimeSeries,
  getDevicesComparison,
  getHourlyPatterns,
  getWeekComparison,
} from './server/adPlayAnalytics'
import { getSqlMirrorStatus, startSqlMirrorSyncService } from './server/sqlMirror'

function resolveRuntimeDirname(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname
  }

  return dirname(fileURLToPath(import.meta.url))
}

const runtimeDir = resolveRuntimeDirname()

loadLocalEnv(runtimeDir)

const app = express()
const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || '0.0.0.0' // Bind to all interfaces for network access

// Middleware
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json())

// Serve static files from dist directory in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(runtimeDir, 'dist')))
}

// Handle favicon requests to avoid CSP errors
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/x-icon')
  res.setHeader('Cache-Control', 'public, max-age=31536000')
  res.status(204).end()
})

// Initialize AWS clients
// Using iotdevice profile which has DynamoDB and S3 permissions
// const profileName = process.env.AWS_PROFILE || 'attentv-terraform'  // Alternative profile
const profileName = process.env.AWS_PROFILE || 'iotdevice'
const region = process.env.MY_AWS_REGION || process.env.AWS_REGION || 'ap-southeast-2'
const explicitAwsCredentials =
  process.env.MY_AWS_ACCESS_KEY_ID && process.env.MY_AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY,
        ...(process.env.MY_AWS_SESSION_TOKEN
          ? { sessionToken: process.env.MY_AWS_SESSION_TOKEN }
          : {}),
      }
    : undefined
const shouldUseProfileCredentials =
  !explicitAwsCredentials &&
  !process.env.AWS_ACCESS_KEY_ID &&
  !process.env.AWS_SECRET_ACCESS_KEY
const awsCredentials = shouldUseProfileCredentials ? fromIni({ profile: profileName }) : explicitAwsCredentials

const client = new DynamoDBClient({
  region,
  ...(awsCredentials ? { credentials: awsCredentials } : {}),
})
const docClient = DynamoDBDocumentClient.from(client)

const s3Client = new S3Client({
  region,
  ...(awsCredentials ? { credentials: awsCredentials } : {}),
})

const S3_BUCKET = 'attntv'
const SCREENSHOT_BUCKET = process.env.NODE_ENV === 'production' 
  ? 'attentv-iot-screenshots-prod' 
  : 'attentv-iot-screenshots-dev'
const DATA_LABELS_TABLE = process.env.DATA_LABELS_TABLE || 'data_labels'

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
const dataLabelsChannelsCache = new Map<string, CacheEntry<string[]>>()
const sqlMirrorStatusCache = new Map<string, CacheEntry<any>>()
const AD_PLAYS_TABLE = process.env.AD_PLAYS_TABLE || 'attentv-ad-plays-prod'

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
app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok' })
})

registerAuthRoutes({
  app,
  docClient,
})

app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' || req.path === '/auth/me' || req.path === '/auth/logout') {
    return next()
  }
  return requireSession(req, res, next)
})

registerModelPerformanceRoutes({
  app,
  docClient,
  dataLabelsTable: DATA_LABELS_TABLE,
})

app.get('/api/sql-mirror/status', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = 'sql-mirror-status'

    if (!forceRefresh) {
      const cached = getCached(sqlMirrorStatusCache, cacheKey, 30000)
      if (cached) {
        return res.json(cached)
      }
    }

    const response = await getSqlMirrorStatus()
    setCached(sqlMirrorStatusCache, cacheKey, response)
    res.json(response)
  } catch (error: any) {
    console.error('Error fetching SQL mirror status:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch SQL mirror status',
      code: error.name,
    })
  }
})

registerQuickQuestionRoutes({
  app,
  docClient,
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

// --- Data Labels table (data_labels) ---
// GET /api/data-labels/channels - list distinct channel values
app.get('/api/data-labels/channels', async (req, res) => {
  try {
    const cacheKey = 'channels'
    const cached = getCached(dataLabelsChannelsCache, cacheKey, 60000)
    if (cached) return res.json({ channels: cached })

    const channels = await getDataLabelChannels()
    setCached(dataLabelsChannelsCache, cacheKey, channels)
    res.json({ channels })
  } catch (error: any) {
    console.error('Error fetching data-labels channels:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch channels',
      code: error.name,
    })
  }
})

// GET /api/data-labels?channel=9 - get items (optional channel filter)
app.get('/api/data-labels', async (req, res) => {
  try {
    const channel = req.query.channel as string | undefined
    const items = await getDataLabels({ channel, limit: 50000 })

    res.json({
      items,
      count: items.length,
    })
  } catch (error: any) {
    console.error('Error fetching data-labels:', error)
    res.status(500).json({
      error: error.message || 'Failed to fetch data labels',
      code: error.name,
    })
  }
})

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

    const response = await getDeviceSummary({ deviceId })

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
    res.json(await getDeviceTimeSeries({ deviceId }))
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

    const response = await getDeviceAds({ deviceId })

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

    const response = await getAggregateSummary({
      knownDevices: await getAllDevices(),
    })

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

    const response = await getHourlyPatterns(includeDayOfWeek)
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

    const response = await getDayOfWeekPatterns()
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

    const response = await getWeekComparison()

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

    const response = await getAdsLeaderboard({
      limit,
      sortBy: sortBy === 'duration' || sortBy === 'frequency' ? sortBy : 'plays',
    })

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

    const response = await getDevicesComparison({
      knownDevices: await getAllDevices(),
    })
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
// This must be last, after all API routes and static file serving
if (process.env.NODE_ENV === 'production') {
  const distIndex = path.join(__dirname, 'dist', 'index.html')
  app.use((req, res) => {
    // Don't serve index.html for API routes (they should have been handled already)
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' })
    }
    if (!fs.existsSync(distIndex)) {
      return res.status(503).send(
        'Frontend not built. Run: npm run build'
      )
    }
    res.sendFile(distIndex)
  })
}

if (process.env.NETLIFY !== 'true' && process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  void startSqlMirrorSyncService({
    docClient,
    dataLabelsTable: DATA_LABELS_TABLE,
    adPlaysTable: AD_PLAYS_TABLE,
    listKnownDevices: getAllDevices,
  }).catch((error) => {
    console.error('Failed to start SQL mirror sync service:', error)
  })

  app.listen(Number(PORT), HOST, () => {
    console.log(`🚀 Server running on http://${HOST}:${PORT}`)
    console.log(`📊 Ad Statistics Monitor API ready`)
    if (process.env.NODE_ENV === 'production') {
      console.log(`🌐 Access from network: http://<your-ip>:${PORT}`)
    }
  })
}

export default app
