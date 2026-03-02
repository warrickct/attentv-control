import type { Express } from 'express'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { clearSessionCookie, readSession, setSessionCookie } from './session'

interface RegisterAuthRoutesOptions {
  app: Express
  docClient: DynamoDBDocumentClient
}

interface UserRecord {
  username: string
  password: string
}

export function registerAuthRoutes(options: RegisterAuthRoutesOptions): void {
  const { app, docClient } = options
  const usersTable = process.env.DYNAMO_USERS_TABLE || 'users'

  app.get('/api/auth/me', (request, response) => {
    const session = readSession(request)
    response.json({ user: session ?? null })
  })

  app.post('/api/auth/login', async (request, response) => {
    try {
      const { username, password } = request.body ?? {}
      if (!username || !password) {
        return response.status(400).json({ error: 'Missing username or password' })
      }

      const result = await docClient.send(new GetCommand({
        TableName: usersTable,
        Key: { username },
      }))
      const user = result.Item as UserRecord | undefined

      if (!user || user.password !== password) {
        return response.status(401).json({ error: 'Invalid credentials' })
      }

      setSessionCookie(response, { username: user.username })
      return response.json({ ok: true, user: { username: user.username } })
    } catch (error: any) {
      console.error('Error logging in:', error)
      return response.status(500).json({ error: error.message || 'Login failed' })
    }
  })

  app.post('/api/auth/logout', (_request, response) => {
    clearSessionCookie(response)
    response.json({ ok: true })
  })
}
