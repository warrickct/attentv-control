import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
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

// Cache for device data (in-memory)
interface CacheEntry<T> {
  data: T
  timestamp: number
}

const CACHE_TTL = 30000 // 30 seconds
const deviceSummaryCache = new Map<string, CacheEntry<any>>()
const deviceAdsCache = new Map<string, CacheEntry<any>>()

// Helper to get cached data or null if expired
function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key)
  if (!entry) return null
  
  const age = Date.now() - entry.timestamp
  if (age > CACHE_TTL) {
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

// Serve React app for all non-API routes (production only)
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
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

