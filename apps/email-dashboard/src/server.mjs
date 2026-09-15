import { createServer } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DashboardError, operations } from './service.mjs'

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
])
const equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const lifetime = 8 * 60 * 60 * 1000

async function readJson(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 5 * 1024 * 1024) throw new DashboardError('Request too large', 413)
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch { throw new DashboardError('Expected a JSON object') }
}

export function dashboardServer({ client, password, publicUrl, now = Date.now }) {
  if (!password || password.length < 32) throw new Error('DASHBOARD_PASSWORD must contain at least 32 characters')
  const origin = new URL(publicUrl)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
    throw new Error('DASHBOARD_PUBLIC_URL must be an HTTPS origin, or HTTP on loopback')
  const secure = origin.protocol === 'https:'
  const cookieName = secure ? '__Host-mail-session' : 'mail-session'
  const signingKey = randomBytes(32)
  const sessions = new Map()
  const sign = (value) => createHmac('sha256', signingKey).update(value).digest('base64url')
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`
  const sessionFor = (request) => {
    const value = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    if (!value) return undefined
    const [id, signature, extra] = value.split('.')
    if (!id || !signature || extra || !equal(signature, sign(id))) return undefined
    const expires = sessions.get(id)
    if (!expires || expires <= now()) { sessions.delete(id); return undefined }
    return id
  }
  let failureCount = 0, retryAfter = 0
  return createServer({ requestTimeout: 60_000, headersTimeout: 15_000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    const json = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }
    try {
      if (request.headers.host !== origin.host) throw new DashboardError('Invalid host', 403)
      const url = new URL(request.url, origin)
      const path = url.pathname
      if (request.method === 'GET' && assets.has(path)) {
        const [file, contentType] = assets.get(path)
        response.setHeader('content-type', contentType)
        response.end(await readFile(new URL(`../public/${file}`, import.meta.url)))
        return
      }
      if (request.method === 'GET' && path === '/healthz') return json({ status: 'ok', service: 'bezalel-email-dashboard' })
      if (request.method === 'GET' && path === '/api/session') return json({ authenticated: Boolean(sessionFor(request)) })
      if (request.method !== 'POST') throw new DashboardError('Not found', 404)
      if (request.headers.origin !== origin.origin) throw new DashboardError('Invalid request origin', 403)
      if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new DashboardError('Expected application/json', 415)
      if (path === '/api/login') {
        if (now() < retryAfter) throw new DashboardError('Too many sign-in attempts. Try again in a minute.', 429)
        const body = await readJson(request)
        if (typeof body.password !== 'string' || !equal(body.password, password)) {
          if (++failureCount >= 5) { retryAfter = now() + 60_000; failureCount = 0 }
          throw new DashboardError('Incorrect dashboard password', 401)
        }
        failureCount = 0
        for (const [id, expires] of sessions) if (expires <= now()) sessions.delete(id)
        if (sessions.size >= 100) throw new DashboardError('Too many dashboard sessions', 429)
        const previous = sessionFor(request)
        if (previous) sessions.delete(previous)
        const id = randomBytes(32).toString('base64url')
        sessions.set(id, now() + lifetime)
        response.setHeader('set-cookie', cookie(`${id}.${sign(id)}`, lifetime / 1000))
        return json({ authenticated: true })
      }
      const session = sessionFor(request)
      if (!session) throw new DashboardError('Sign in to continue', 401)
      if (path === '/api/logout') {
        sessions.delete(session)
        response.setHeader('set-cookie', cookie('', 0))
        return json({ authenticated: false })
      }
      const operation = path.startsWith('/api/rpc/') ? path.slice('/api/rpc/'.length) : ''
      if (!operations.has(operation)) throw new DashboardError('Not found', 404)
      return json({ result: await client.execute(operation, await readJson(request)) })
    } catch (error) {
      if (!response.headersSent) json({ error: error instanceof DashboardError ? error.message : 'Dashboard request failed' }, error instanceof DashboardError ? error.status : 500)
      else response.destroy()
    }
  })
}
