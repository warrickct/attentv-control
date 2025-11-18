import express from 'express'
import cors from 'cors'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { fromIni } from '@aws-sdk/credential-providers'

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// Handle favicon requests to avoid CSP errors
app.get('/favicon.ico', (req, res) => {
  res.status(204).end()
})

// Initialize DynamoDB client
// Using attentv-terraform profile which has DynamoDB Scan permissions
const profileName = process.env.AWS_PROFILE || 'attentv-terraform'
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-southeast-2',
  credentials: fromIni({ profile: profileName }),
})
const docClient = DynamoDBDocumentClient.from(client)

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Get statistics from DynamoDB table
// Supports both Scan and Query operations
app.post('/api/stats', async (req, res) => {
  try {
    const { tableName, limit = 100, partitionKey, partitionValue, sortKey, sortValue } = req.body

    if (!tableName) {
      return res.status(400).json({ error: 'Table name is required' })
    }

    let command;
    
    // If partition key is provided, use Query instead of Scan
    if (partitionKey && partitionValue !== undefined) {
      const keyCondition: any = {
        [partitionKey]: partitionValue
      }
      
      // Add sort key condition if provided
      if (sortKey && sortValue !== undefined) {
        keyCondition[sortKey] = sortValue
      } else if (sortKey) {
        // If sort key name is provided but no value, we can't do an exact query
        // This would require a different query structure
      }
      
      command = new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: Object.keys(keyCondition).map((key, idx) => {
          const exprName = `#key${idx}`
          return `${exprName} = :val${idx}`
        }).join(' AND '),
        ExpressionAttributeNames: Object.keys(keyCondition).reduce((acc, key, idx) => {
          acc[`#key${idx}`] = key
          return acc
        }, {} as Record<string, string>),
        ExpressionAttributeValues: Object.values(keyCondition).reduce((acc, val, idx) => {
          acc[`:val${idx}`] = val
          return acc
        }, {} as Record<string, any>),
        Limit: limit,
      })
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

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
  console.log(`📊 Ad Statistics Monitor API ready`)
})

