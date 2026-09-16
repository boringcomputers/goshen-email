import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { dashboardHandler } from './handler.mjs'
import { DashboardError } from './service.mjs'

export function dashboardServer({ trustedProxyIps = [], handler = dashboardHandler, ...options }) {
  const normalizeIp = (value) => value?.startsWith('::ffff:') ? value.slice(7) : value
  if (trustedProxyIps.some((address) => !isIP(address))) throw new Error('Trusted proxy addresses must be IP literals')
  const proxies = new Set(trustedProxyIps.map(normalizeIp))
  const handle = handler({ ...options, asset: (file) => readFile(new URL(`../public/${file}`, import.meta.url)) })
  return createServer({ requestTimeout: 60_000, headersTimeout: 15_000 }, async (incoming, outgoing) => {
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const origin = new URL(options.publicUrl)
      if (incoming.headers.host !== origin.host) throw new DashboardError('Invalid host', 403)
      const request = new Request(`${origin.protocol}//${incoming.headers.host}${incoming.url}`, {
        method: incoming.method, headers,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
      })
      const response = await handle(request, { clientIdentity: () => {
        const peer = normalizeIp(incoming.socket.remoteAddress)
        const forwarded = incoming.headers['x-real-ip']
        if (proxies.has(peer)) {
          if (typeof forwarded !== 'string' || !isIP(forwarded)) throw new DashboardError('The trusted proxy must set X-Real-IP', 400)
          return normalizeIp(forwarded)
        }
        return peer
      } })
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(response.headers.has('set-cookie') ? { 'set-cookie': response.headers.getSetCookie() } : {}) })
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(error instanceof DashboardError ? error.status : 500, {
        'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
      }).end(JSON.stringify({ error: error instanceof DashboardError ? error.message : 'Dashboard request failed' }))
      else outgoing.destroy()
    }
  })
}
