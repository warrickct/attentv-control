import fs from 'node:fs'
import { Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector'
import { GoogleAuth } from 'google-auth-library'
import { Pool } from 'pg'

let pgPoolPromise: Promise<Pool> | null = null
let cloudSqlConnector: Connector | null = null

function parseBoolean(value: unknown, defaultValue: boolean = false): boolean {
  if (typeof value !== 'string') {
    return defaultValue
  }

  return value === 'true' || value === '1'
}

function shouldUseCloudSqlConnector(): boolean {
  return Boolean(process.env.INSTANCE_CONNECTION_NAME)
}

function getCloudSqlCredentialsAuth(): GoogleAuth | undefined {
  const inlineCredentialsJson =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON ||
    process.env.GCP_SERVICE_ACCOUNT_JSON

  const credentialsJson = inlineCredentialsJson ||
    (() => {
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
      if (!credentialsPath || !fs.existsSync(credentialsPath)) {
        return null
      }

      return fs.readFileSync(credentialsPath, 'utf8')
    })()

  if (!credentialsJson) {
    return undefined
  }

  return new GoogleAuth({
    credentials: JSON.parse(credentialsJson),
    scopes: ['https://www.googleapis.com/auth/sqlservice.admin'],
  })
}

export async function getPostgresPool(): Promise<Pool> {
  if (pgPoolPromise) {
    return pgPoolPromise
  }

  pgPoolPromise = (async () => {
    const connectionString = process.env.DATABASE_URL
    const sslEnabled = parseBoolean(process.env.PGSSLMODE)

    if (connectionString && !shouldUseCloudSqlConnector()) {
      return new Pool({
        connectionString,
        ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
      })
    }

    if (shouldUseCloudSqlConnector()) {
      const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME
      if (!instanceConnectionName) {
        throw new Error('INSTANCE_CONNECTION_NAME is required when using the Cloud SQL connector.')
      }

      const auth = getCloudSqlCredentialsAuth()
      cloudSqlConnector = new Connector(auth ? { auth } : undefined)
      const clientOptions = await cloudSqlConnector.getOptions({
        instanceConnectionName,
        ipType: (process.env.CLOUD_SQL_IP_TYPE || 'PUBLIC') as IpAddressTypes,
      })

      return new Pool({
        ...clientOptions,
        user: process.env.DB_USER || process.env.PGUSER || 'postgres',
        password: process.env.GOOGLE_SQL_PASS || process.env.PGPASSWORD,
        database: process.env.DB_NAME || process.env.PGDATABASE || 'fingerprints',
        max: Number.parseInt(process.env.DB_POOL_MAX || '5', 10),
      })
    }

    return new Pool({
      host: process.env.PGHOST || '127.0.0.1',
      port: Number.parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.DB_USER || process.env.PGUSER || 'postgres',
      password: process.env.GOOGLE_SQL_PASS || process.env.PGPASSWORD,
      database: process.env.DB_NAME || process.env.PGDATABASE || 'fingerprints',
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
    })
  })()

  return pgPoolPromise
}

export async function closePostgresPool(): Promise<void> {
  if (pgPoolPromise) {
    const pool = await pgPoolPromise
    await pool.end()
    pgPoolPromise = null
  }

  if (cloudSqlConnector) {
    cloudSqlConnector.close()
    cloudSqlConnector = null
  }
}
