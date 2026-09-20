import { assetResponse, assets, dashboardOrigin, readBody, responseHeaders, workspaceCookie } from './handler.mjs'
import { renderAccountPage } from './account-page.mjs'
import { customerOperations, nativeReadOperations, DashboardError } from './service.mjs'

const pages = new Set(['/sign-in', '/sign-up', '/magic-link'])
const accountAssets = new Map([['/auth.css', ['auth.css', 'text/css; charset=utf-8']], ['/auth.js', ['auth.js', 'text/javascript; charset=utf-8']]])

// Account sessions last seven days and refresh with activity; the marker is reissued on every session read.
const sessionLifetime = 7 * 24 * 60 * 60

export function accountDashboardHandler({ publicUrl, workerUrl, proxySecret, request: backend, asset, nativeMail }) {
  const origin = dashboardOrigin(publicUrl)
  const secure = origin.protocol === 'https:'
  if (!proxySecret || proxySecret.length < 32) throw new Error('AUTH_PROXY_SECRET must contain at least 32 characters')
  return async (request, { clientIdentity } = {}) => {
    const headers = responseHeaders()
    const json = (value, status = 200) => Response.json(value, { status, headers })
    try {
      const url = new URL(request.url), path = url.pathname
      if (url.origin !== origin.origin) throw new DashboardError('Invalid host', 403)
      if (request.method === 'GET') {
        const entry = pages.has(path) ? ['auth.html', 'text/html; charset=utf-8'] : accountAssets.get(path) ?? assets.get(path)
        if (entry) {
          const body = await asset(entry[0], request)
          return assetResponse(pages.has(path) ? await renderAccountPage(body, url) : body, entry)
        }
        if (path === '/healthz') return json({ status: 'ok', service: 'bezalel-email-dashboard' })
      }
      const session = path === '/api/session' && request.method === 'GET'
      const auth = path.startsWith('/api/auth/')
      const logout = path === '/api/logout'
      const operation = path.startsWith('/api/rpc/') ? path.slice('/api/rpc/'.length) : ''
      const nativeOperation = path.startsWith('/api/native-rpc/') ? path.slice('/api/native-rpc/'.length) : ''
      if (nativeOperation && (!nativeMail || !nativeReadOperations.has(nativeOperation))) throw new DashboardError('Not found', 404)
      if (!session && !auth && !logout && !nativeOperation && (!customerOperations.has(operation) || operation === 'session')) throw new DashboardError('Not found', 404)
      if (!session) {
        if (request.method !== 'POST') throw new DashboardError('Not found', 404)
        if (request.headers.get('origin') !== origin.origin) throw new DashboardError('Invalid request origin', 403)
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new DashboardError('Expected application/json', 415)
      }
      const ip = clientIdentity?.()
      if (!ip) throw new DashboardError('Client address unavailable', 400)
      const endpoint = session || nativeOperation ? '/account-rpc/session' : logout ? '/api/auth/sign-out' : auth ? path + url.search : `/account-rpc/${operation}`
      const forwarded = new Headers({ authorization: `Bearer ${proxySecret}`, 'x-bezalel-client-ip': ip, origin: origin.origin, 'content-type': 'application/json' })
      if (request.headers.has('cookie')) forwarded.set('cookie', request.headers.get('cookie'))
      const method = session ? 'POST' : request.method
      const response = await backend(new URL(endpoint, workerUrl), { method, headers: forwarded,
        ...(method === 'POST' ? { body: session || nativeOperation ? '{}' : await readBody(request) } : {}), redirect: 'manual', signal: AbortSignal.timeout(45_000) })
      for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie)
      const location = response.headers.get('location')
      if (location && response.status >= 300 && response.status < 400) { headers.set('location', location); return new Response(null, { status: response.status, headers }) }
      const body = await response.json()
      if (session || logout) headers.append('set-cookie', workspaceCookie(secure, session && response.ok ? sessionLifetime : 0))
      if (session && response.status === 401) return json({ authenticated: false, authMode: 'account' })
      if (!response.ok) return json({ error: body.error?.message ?? body.message ?? 'Account request failed', code: body.code, authMode: 'account' }, response.status)
      const nativeMailEnabled = nativeMail?.permits(body.result?.customer) === true
      if (nativeOperation) {
        if (!nativeMailEnabled) throw new DashboardError('Administrator access required', 403)
        let input
        try { input = JSON.parse(new TextDecoder().decode(await readBody(request))) }
        catch (error) { if (error instanceof DashboardError) throw error; throw new DashboardError('Expected a JSON object') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DashboardError('Expected a JSON object')
        return json({ result: await nativeMail.execute(nativeOperation, input) })
      }
      if (session) return json({ authenticated: true, authMode: 'account', ...body.result, nativeMailEnabled })
      if (logout) return json({ authenticated: false, logoutUrl: '/sign-in' })
      return json(body)
    } catch (error) {
      return json({ error: error instanceof DashboardError ? error.message : 'The account service did not respond. Try again.', authMode: 'account' }, error instanceof DashboardError ? error.status : 502)
    }
  }
}
