import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

export interface SessionUser {
  username: string
}

const COOKIE_NAME = 'session'

function getSessionSecret(): string {
  return process.env.SESSION_SECRET || 'dev-secret'
}

function sign(data: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(data).digest('base64url')
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Lax' | 'Strict' | 'None'
    path?: string
    maxAge?: number
  } = {},
): string {
  const parts = [`${name}=${value}`]
  parts.push(`Path=${options.path || '/'}`)
  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${options.maxAge}`)
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly')
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`)
  }
  if (options.secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

function parseCookieHeader(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) {
    return {}
  }

  return Object.fromEntries(
    headerValue
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=')
        if (separatorIndex === -1) {
          return [part, '']
        }
        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))]
      }),
  )
}

function buildCookieValue(payload: SessionUser): string {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${b64}.${sign(b64)}`
}

export function readSession(request: Request): SessionUser | null {
  const cookies = parseCookieHeader(request.headers.cookie)
  const cookieValue = cookies[COOKIE_NAME]
  if (!cookieValue) {
    return null
  }

  const [b64, signature] = cookieValue.split('.')
  if (!b64 || !signature) {
    return null
  }
  if (sign(b64) !== signature) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
    if (!payload || typeof payload.username !== 'string') {
      return null
    }
    return { username: payload.username }
  } catch {
    return null
  }
}

export function setSessionCookie(response: Response, payload: SessionUser): void {
  response.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, buildCookieValue(payload), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    }),
  )
}

export function clearSessionCookie(response: Response): void {
  response.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    }),
  )
}

export function requireSession(request: Request, response: Response, next: NextFunction): void {
  const session = readSession(request)
  if (!session) {
    response.status(401).json({ error: 'Authentication required' })
    return
  }

  response.locals.session = session
  next()
}
