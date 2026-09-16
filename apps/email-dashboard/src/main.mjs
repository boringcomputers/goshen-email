import { accountDashboardHandler } from './account-handler.mjs'
import { dashboardServer } from './server.mjs'
import { mailClient } from './service.mjs'

const port = Number(process.env.PORT ?? 3031)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535')
const publicUrl = process.env.DASHBOARD_PUBLIC_URL ?? `http://127.0.0.1:${port}`
const server = dashboardServer({
  ...(process.env.DASHBOARD_AUTH_MODE === 'account' ? {
    handler: accountDashboardHandler, workerUrl: process.env.MAIL_WORKER_URL,
    proxySecret: process.env.AUTH_PROXY_SECRET, request: fetch,
  } : { client: mailClient({ workerUrl: process.env.MAIL_WORKER_URL, apiToken: process.env.MAIL_API_TOKEN }) }),
  password: process.env.DASHBOARD_PASSWORD, publicUrl,
  trustedProxyIps: (process.env.DASHBOARD_TRUSTED_PROXY_IPS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
})
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Email dashboard: ${publicUrl}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
})
