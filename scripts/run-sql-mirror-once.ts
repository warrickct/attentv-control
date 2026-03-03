import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { fromIni } from '@aws-sdk/credential-providers'
import { loadLocalEnv } from '../server/loadEnv'
import { closePostgresPool } from '../server/postgres'
import { runSqlMirrorSyncCycle } from '../server/sqlMirror'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

loadLocalEnv(path.resolve(__dirname, '..'))

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

const dynamoClient = new DynamoDBClient({
  region,
  ...(awsCredentials ? { credentials: awsCredentials } : {}),
})
const docClient = DynamoDBDocumentClient.from(dynamoClient)

const s3Client = new S3Client({
  region,
  ...(awsCredentials ? { credentials: awsCredentials } : {}),
})

async function listKnownDevices(): Promise<string[]> {
  const bucketName = 'attntv'
  const response = await s3Client.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Delimiter: '/',
  }))

  return (response.CommonPrefixes || [])
    .map((prefix) => prefix.Prefix?.replace('/', ''))
    .filter((device): device is string => Boolean(device) && device !== 'ad_metrics')
    .sort()
}

async function main(): Promise<void> {
  try {
    await runSqlMirrorSyncCycle({
      docClient,
      dataLabelsTable: process.env.DATA_LABELS_TABLE || 'data_labels',
      adPlaysTable: process.env.AD_PLAYS_TABLE || 'attentv-ad-plays-prod',
      listKnownDevices,
    })
  } finally {
    await closePostgresPool()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
