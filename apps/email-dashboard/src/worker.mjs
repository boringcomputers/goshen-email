import { DurableObject } from 'cloudflare:workers'
import { isIP } from 'node:net'
import { dashboardHandler, readBody } from './handler.mjs'
import { durableState } from './durable-state.mjs'
import { DashboardError, mailClient } from './service.mjs'

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
        url.pathname = file === 'index.html' ? '/' : `/${file}`
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
    return env.DASHBOARD.get(env.DASHBOARD.idFromName('owner')).fetch(request)
  },
}
