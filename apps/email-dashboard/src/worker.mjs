import { accountDashboardHandler } from './account-handler.mjs'
import { DurableObject } from 'cloudflare:workers'
import { isIP } from 'node:net'
import { dashboardHandler, readBody } from './handler.mjs'
import { durableState } from './durable-state.mjs'
import { accessDashboardHandler } from './access-handler.mjs'
import { DashboardError, customerMailClient, mailClient } from './service.mjs'

export class Dashboard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.handle = dashboardHandler({
      password: env.DASHBOARD_PASSWORD,
      publicUrl: env.DASHBOARD_PUBLIC_URL,
      state: ctx.storage.transactionSync(() => durableState(ctx.storage.sql, env.DASHBOARD_PASSWORD)),
      client: mailClient({ workerUrl: env.MAIL_WORKER_URL, apiToken: env.MAIL_API_TOKEN,
        request: (url, init) => env.MAIL_API.fetch(url, init) }),
      asset: async (file, request) => {
        const url = new URL(request.url)
        url.pathname = `/${file}`
        const response = await env.ASSETS.fetch(url)
        if (!response.ok) throw new Error('Dashboard asset unavailable')
        return response.body
      },
    })
  }
  fetch(request) {
    return this.handle(request, { clientIdentity: () => {
      const address = request.headers.get('cf-connecting-ip')
      return address && isIP(address) ? address : undefined
    } })
  }
}

export default {
  async fetch(request, env) {
    // Consume the bounded body before forwarding so early auth responses can close the stream.
    // https://github.com/cloudflare/workerd/issues/918
    try {
      if (request.body) request = new Request(request, { body: await readBody(request) })
    } catch (error) {
      return Response.json({ error: error instanceof DashboardError ? error.message : 'Could not read request' }, {
        status: error instanceof DashboardError ? error.status : 400,
        headers: { 'cache-control': 'no-store' },
      })
    }
    if (env.DASHBOARD_AUTH_MODE === 'account') {
      return accountDashboardHandler({
        publicUrl: env.DASHBOARD_PUBLIC_URL, workerUrl: env.MAIL_WORKER_URL, proxySecret: env.AUTH_PROXY_SECRET,
        request: (url, init) => env.MAIL_API.fetch(url, init),
        asset: async (file, request) => {
          const url = new URL(request.url); url.pathname = `/${file}`
          const response = await env.ASSETS.fetch(url)
          if (!response.ok) throw new Error('Dashboard asset unavailable')
          return response.body
        },
      })(request, { clientIdentity: () => {
        const ip = request.headers.get('cf-connecting-ip')
        return ip && isIP(ip) ? ip : undefined
      } })
    }
    if (env.DASHBOARD_AUTH_MODE === 'access') {
      return accessDashboardHandler({
        publicUrl: env.DASHBOARD_PUBLIC_URL,
        client: customerMailClient({ workerUrl: env.MAIL_WORKER_URL,
          request: (url, init) => env.MAIL_API.fetch(url, init) }),
        asset: async (file, request) => {
          const url = new URL(request.url)
          url.pathname = `/${file}`
          const response = await env.ASSETS.fetch(url)
          if (!response.ok) throw new Error('Dashboard asset unavailable')
          return response.body
        },
      })(request)
    }
    if (env.DASHBOARD_AUTH_MODE !== 'password')
      return Response.json({ error: 'Dashboard sign-in is not configured' }, { status: 503 })
    return env.DASHBOARD.get(env.DASHBOARD.idFromName('owner')).fetch(request)
  },
}
