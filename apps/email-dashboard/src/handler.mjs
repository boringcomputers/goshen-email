import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { DashboardError, operations } from './service.mjs'

export const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/app/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/landing.css', ['landing.css', 'text/css; charset=utf-8']],
  ['/images/solenne.svg', ['images/solenne.svg', 'image/svg+xml']],
  ['/images/imessage.png', ['images/imessage.png', 'image/png']],
  ['/images/whatsapp.png', ['images/whatsapp.png', 'image/png']],
  ['/images/slack.png', ['images/slack.png', 'image/png']],
  ['/images/email.png', ['images/email.png', 'image/png']],
  ['/images/telegram.png', ['images/telegram.png', 'image/png']],
  ['/images/teams.png', ['images/teams.png', 'image/png']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
  ['/fonts/InterVariable.woff2', ['fonts/InterVariable.woff2', 'font/woff2']],
])
const equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const lifetime = 8 * 60 * 60 * 1000

export async function readBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request.body ?? []) {
    length += chunk.length
    if (length > 5 * 1024 * 1024) throw new DashboardError('Request too large', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson(request) {
  const body = await readBody(request)
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch { throw new DashboardError('Expected a JSON object') }
}

export function dashboardHandler({ client, password, publicUrl, asset, state = {}, now = Date.now }) {
  if (!password || password.length < 32) throw new Error('DASHBOARD_PASSWORD must contain at least 32 characters')
  const origin = dashboardOrigin(publicUrl)
  const secure = origin.protocol === 'https:'
  const cookieName = secure ? '__Host-mail-session' : 'mail-session'
  const signingKey = state.signingKey ?? randomBytes(32)
  const sessions = state.sessions ?? new Map()
  const sign = (value) => createHmac('sha256', signingKey).update(value).digest('base64url')
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`
  const sessionFor = (request) => {
    const value = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    if (!value) return undefined
    const [id, signature, extra] = value.split('.')
    if (!id || !signature || extra || !equal(signature, sign(id))) return undefined
    const expires = sessions.get(id)
    if (!expires || expires <= now()) { sessions.delete(id); return undefined }
    return id
  }
  const attempts = state.attempts ?? new Map()
  return async (request, { clientIdentity } = {}) => {
    const headers = responseHeaders()
    const json = (value, status = 200) => {
      headers.set('content-type', 'application/json; charset=utf-8')
      return new Response(JSON.stringify(value), { status, headers })
    }
    try {
      if (new URL(request.url).host !== origin.host) throw new DashboardError('Invalid host', 403)
      const url = new URL(request.url, origin)
      const path = url.pathname
      if (request.method === 'GET' && assets.has(path)) {
        const [file, contentType] = assets.get(path)
        headers.set('content-type', contentType)
        return new Response(await asset(file, request), { headers })
      }
      if (request.method === 'GET' && path === '/healthz') return json({ status: 'ok', service: 'bezalel-email-dashboard' })
      if (request.method === 'GET' && path === '/api/session') return json({ authenticated: Boolean(sessionFor(request)) })
      if (request.method !== 'POST') throw new DashboardError('Not found', 404)
      if (request.headers.get('origin') !== origin.origin) throw new DashboardError('Invalid request origin', 403)
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new DashboardError('Expected application/json', 415)
      if (path === '/api/login') {
        const identity = clientIdentity?.()
        if (!identity) throw new DashboardError('Client address is unavailable', 400)
        for (const [key, attempt] of attempts) if (attempt.expires <= now()) attempts.delete(key)
        const attempt = attempts.get(identity)
        if (attempt?.failures >= 5) throw new DashboardError('Too many sign-in attempts. Try again in a minute.', 429)
        const body = await readJson(request)
        const current = attempts.get(identity)
        if (current?.failures >= 5 && current.expires > now()) throw new DashboardError('Too many sign-in attempts. Try again in a minute.', 429)
        if (typeof body.password !== 'string' || !equal(body.password, password)) {
          if (!current && attempts.size >= 10_000) attempts.delete(attempts.keys().next().value)
          attempts.set(identity, { failures: (current && current.expires > now() ? current.failures : 0) + 1, expires: now() + 60_000 })
          throw new DashboardError('Incorrect dashboard password', 401)
        }
        attempts.delete(identity)
        for (const [id, expires] of sessions) if (expires <= now()) sessions.delete(id)
        const previous = sessionFor(request)
        if (sessions.size >= 100 && !previous) throw new DashboardError('Too many dashboard sessions', 429)
        if (previous) sessions.delete(previous)
        const id = randomBytes(32).toString('base64url')
        sessions.set(id, now() + lifetime)
        headers.set('set-cookie', cookie(`${id}.${sign(id)}`, lifetime / 1000))
        return json({ authenticated: true })
      }
      const session = sessionFor(request)
      if (!session) throw new DashboardError('Sign in to continue', 401)
      if (path === '/api/logout') {
        sessions.delete(session)
        headers.set('set-cookie', cookie('', 0))
        return json({ authenticated: false })
      }
      const operation = path.startsWith('/api/rpc/') ? path.slice('/api/rpc/'.length) : ''
      if (!operations.has(operation)) throw new DashboardError('Not found', 404)
      return json({ result: await client.execute(operation, await readJson(request)) })
    } catch (error) {
      return json({ error: error instanceof DashboardError ? error.message : 'Dashboard request failed' }, error instanceof DashboardError ? error.status : 500)
    }
  }
}

export function dashboardOrigin(publicUrl) {
  const origin = new URL(publicUrl)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
    throw new Error('DASHBOARD_PUBLIC_URL must be an HTTPS origin, or HTTP on loopback')
  return origin
}

export function responseHeaders() {
  return new Headers({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    })
}
