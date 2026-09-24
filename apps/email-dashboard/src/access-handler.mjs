import { assetResponse, assets, dashboardOrigin, readJson, responseHeaders, workspaceCookie } from './handler.mjs'
import { customerOperations, DashboardError } from './service.mjs'

// Access sessions are Cloudflare's; the marker is reissued on every session read and lasts a day at most.
const markerLifetime = 24 * 60 * 60

export function accessDashboardHandler({ client, publicUrl, asset }) {
  const origin = dashboardOrigin(publicUrl)
  const secure = origin.protocol === 'https:'
  return async (request) => {
    const headers = responseHeaders()
    const json = (value, status = 200) => {
      headers.set('content-type', 'application/json; charset=utf-8')
      return new Response(JSON.stringify(value), { status, headers })
    }
    try {
      const url = new URL(request.url)
      if (url.origin !== origin.origin) throw new DashboardError('Invalid host', 403)
      const path = url.pathname
      if (request.method === 'GET' && assets.has(path)) {
        const entry = assets.get(path)
        return assetResponse(await asset(entry[0], request), entry)
      }
      if (request.method === 'GET' && path === '/healthz') return json({ status: 'ok', service: 'bezalel-email-dashboard' })
      const token = request.headers.get('cf-access-jwt-assertion')
      if (request.method === 'GET' && path === '/api/session') {
        if (!token) { headers.append('set-cookie', workspaceCookie(secure, 0)); return json({ authenticated: false, authMode: 'access' }) }
        const result = await client.execute('session', {}, token)
        headers.append('set-cookie', workspaceCookie(secure, markerLifetime))
        return json({ authenticated: true, authMode: 'access', ...result })
      }
      if (request.method !== 'POST') throw new DashboardError('Not found', 404)
      if (request.headers.get('origin') !== origin.origin) throw new DashboardError('Invalid request origin', 403)
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
        throw new DashboardError('Expected application/json', 415)
      if (!token) throw new DashboardError('Sign in to continue', 401)
      if (path === '/api/logout') { headers.append('set-cookie', workspaceCookie(secure, 0)); return json({ logoutUrl: '/cdn-cgi/access/logout' }) }
      const operation = path.startsWith('/api/rpc/') ? path.slice('/api/rpc/'.length) : ''
      if (!customerOperations.has(operation) || operation === 'session') throw new DashboardError('Not found', 404)
      return json({ result: await client.execute(operation, await readJson(request), token) })
    } catch (error) {
      return json({ error: error instanceof DashboardError ? error.message : 'Dashboard request failed',
        ...(error instanceof DashboardError && error.code ? { code: error.code } : {}), authMode: 'access' },
        error instanceof DashboardError ? error.status : 500)
    }
  }
}
