import { assets, dashboardOrigin, readJson, responseHeaders } from './handler.mjs'
import { customerOperations, DashboardError } from './service.mjs'

export function accessDashboardHandler({ client, publicUrl, asset }) {
  const origin = dashboardOrigin(publicUrl)
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
        const [file, contentType] = assets.get(path)
        headers.set('content-type', contentType)
        return new Response(await asset(file, request), { headers })
      }
      if (request.method === 'GET' && path === '/healthz') return json({ status: 'ok', service: 'bezalel-email-dashboard' })
      const token = request.headers.get('cf-access-jwt-assertion')
      if (request.method === 'GET' && path === '/api/session') {
        if (!token) return json({ authenticated: false, authMode: 'access' })
        return json({ authenticated: true, authMode: 'access', ...await client.execute('session', {}, token) })
      }
      if (request.method !== 'POST') throw new DashboardError('Not found', 404)
      if (request.headers.get('origin') !== origin.origin) throw new DashboardError('Invalid request origin', 403)
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
        throw new DashboardError('Expected application/json', 415)
      if (!token) throw new DashboardError('Sign in to continue', 401)
      if (path === '/api/logout') return json({ logoutUrl: '/cdn-cgi/access/logout' })
      const operation = path.startsWith('/api/rpc/') ? path.slice('/api/rpc/'.length) : ''
      if (!customerOperations.has(operation) || operation === 'session') throw new DashboardError('Not found', 404)
      return json({ result: await client.execute(operation, await readJson(request), token) })
    } catch (error) {
      return json({ error: error instanceof DashboardError ? error.message : 'Dashboard request failed', authMode: 'access' },
        error instanceof DashboardError ? error.status : 500)
    }
  }
}
