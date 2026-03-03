import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import serverless from 'serverless-http'
import { loadLocalEnv } from '../server/loadEnv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

loadLocalEnv(path.resolve(__dirname, '..'))

interface CliOptions {
  path: string
  method: string
  auth: boolean
  body: string | null
  timeoutMs: number
  username: string
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args.set(key, 'true')
    } else {
      args.set(key, next)
      index += 1
    }
  }

  const endpointPath = args.get('path')
  if (!endpointPath) {
    throw new Error('--path is required')
  }

  return {
    path: endpointPath,
    method: (args.get('method') || 'GET').toUpperCase(),
    auth: args.get('auth') !== 'false',
    body: args.get('body') || null,
    timeoutMs: Number.parseInt(args.get('timeout-ms') || '20000', 10),
    username: args.get('username') || 'codex-test',
  }
}

function buildSessionCookie(username: string): string {
  const payload = Buffer.from(JSON.stringify({ username }), 'utf8').toString('base64url')
  const secret = process.env.SESSION_SECRET || 'dev-secret'
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `session=${payload}.${signature}`
}

function toQueryParams(url: URL): Record<string, string> | null {
  const entries = Array.from(url.searchParams.entries())
  if (entries.length === 0) {
    return null
  }

  return Object.fromEntries(entries)
}

function summarizeBody(body: unknown): unknown {
  if (body == null || typeof body !== 'object') {
    return body
  }

  if (Array.isArray(body)) {
    return { type: 'array', length: body.length }
  }

  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => {
      if (Array.isArray(value)) {
        return [key, { type: 'array', length: value.length }]
      }
      if (value && typeof value === 'object') {
        return [key, { type: 'object', keys: Object.keys(value).slice(0, 12) }]
      }
      return [key, value]
    }),
  )
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  process.env.AWS_LAMBDA_FUNCTION_NAME = '1'

  const timeout = setTimeout(() => {
    console.log(JSON.stringify({
      path: options.path,
      status: 0,
      ok: false,
      timeoutMs: options.timeoutMs,
      body: { error: `Timed out after ${options.timeoutMs}ms` },
    }, null, 2))
    process.exit(124)
  }, options.timeoutMs)

  try {
    const serverModule = await import('../server')
    const app = (serverModule.default as any)?.default ?? serverModule.default
    const handler = serverless(app)
    const url = new URL(options.path, 'http://localhost')
    const rawBody = options.body
    const parsedBody = rawBody ? JSON.parse(rawBody) : null

    const response = await handler({
      httpMethod: options.method,
      path: url.pathname,
      queryStringParameters: toQueryParams(url),
      headers: {
        ...(options.auth ? { cookie: buildSessionCookie(options.username) } : {}),
        ...(parsedBody ? { 'content-type': 'application/json' } : {}),
      },
      body: parsedBody ? JSON.stringify(parsedBody) : null,
      isBase64Encoded: false,
    }, {}) as { statusCode: number; body?: string }

    let parsedResponseBody: unknown = response.body ?? null
    try {
      parsedResponseBody = JSON.parse(response.body ?? 'null')
    } catch {
      parsedResponseBody = response.body ?? null
    }

    console.log(JSON.stringify({
      path: options.path,
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      body: summarizeBody(parsedResponseBody),
    }, null, 2))
  } finally {
    clearTimeout(timeout)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
