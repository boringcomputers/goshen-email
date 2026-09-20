import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { DashboardError, operations } from './service.mjs'

export const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/app/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/landing.css', ['landing.css', 'text/css; charset=utf-8']],
  ['/site-header.css', ['site-header.css', 'text/css; charset=utf-8']],
  ['/images/solenne.svg', ['images/solenne.svg', 'image/svg+xml']],
  ['/images/imessage.png', ['images/imessage.png', 'image/png']],
  ['/images/whatsapp.png', ['images/whatsapp.png', 'image/png']],
  ['/images/slack.png', ['images/slack.png', 'image/png']],
  ['/images/email.png', ['images/email.png', 'image/png']],
  ['/images/telegram.png', ['images/telegram.png', 'image/png']],
  ['/images/teams.png', ['images/teams.png', 'image/png']],
  ['/triage.js', ['triage.js', 'text/javascript; charset=utf-8']],
  ['/triage.css', ['triage.css', 'text/css; charset=utf-8']],
  ['/developer.js', ['developer.js', 'text/javascript; charset=utf-8']],
  ['/developer.css', ['developer.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dashboard-boot.js', ['dashboard-boot.js', 'text/javascript; charset=utf-8']],
  ['/dashboard-shell.js', ['dashboard-shell.js', 'text/javascript; charset=utf-8']],
  ['/console.js', ['console.js', 'text/javascript; charset=utf-8']],
  ['/console.css', ['console.css', 'text/css; charset=utf-8']],
  ['/notifications.js', ['notifications.js', 'text/javascript; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/native-mail.js', ['native-mail.js', 'text/javascript; charset=utf-8']],
  ['/native-mail.css', ['native-mail.css', 'text/css; charset=utf-8']],
  ['/setup.js', ['setup.js', 'text/javascript; charset=utf-8']],
  ['/setup.css', ['setup.css', 'text/css; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
  ['/fonts/InterVariable.woff2', ['fonts/InterVariable.woff2', 'font/woff2']],
])
const equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const lifetime = 8 * 60 * 60 * 1000

// A random marker the browser can read, issued with each authenticated session response and cleared
// when the session ends. dashboard-shell.js paints its saved workspace only while the marker matches
// the one saved with it, so an ended session or another account never sees the previous workspace
// before the session request answers. The server never reads it and it grants nothing.
export function workspaceCookie(secure, maxAge) {
  const value = maxAge > 0 ? randomBytes(16).toString('base64url') : ''
  return `${secure ? '__Host-' : ''}workspace=${value}; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

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
        const entry = assets.get(path)
        return assetResponse(await asset(entry[0], request), entry)
      }
      if (request.method === 'GET' && path === '/healthz') return json({ status: 'ok', service: 'bezalel-email-dashboard' })
      if (request.method === 'GET' && path === '/api/session') {
        const authenticated = Boolean(sessionFor(request))
        headers.append('set-cookie', workspaceCookie(secure, authenticated ? lifetime / 1000 : 0))
        return json({ authenticated })
      }
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
        headers.append('set-cookie', workspaceCookie(secure, 0))
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

// The Worker also answers on workers.dev and www. Send those GET requests to the public origin
// instead of the 403 the handlers return for an unexpected host. Other methods keep the 403.
export function canonicalHostRedirect(request, publicUrl) {
  const origin = dashboardOrigin(publicUrl)
  const url = new URL(request.url)
  if (url.host === origin.host || !['GET', 'HEAD'].includes(request.method)) return undefined
  // Assign the components rather than resolving a relative reference: a path starting with // would
  // otherwise be read as scheme-relative and replace the host.
  const location = new URL(origin)
  location.pathname = url.pathname
  location.search = url.search
  const headers = responseHeaders()
  headers.set('location', location.href)
  return new Response(null, { status: 301, headers })
}

export function responseHeaders() {
  return new Headers({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    })
}

export function assetResponse(body, [file, contentType]) {
  const headers = responseHeaders()
  headers.set('content-type', contentType)
  if (file === 'fonts/InterVariable.woff2' && contentType === 'font/woff2')
    headers.set('cache-control', 'public, max-age=3600')
  return new Response(body, { headers })
}
