import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

// Local development only. The dashboard server rejects API calls whose Origin is not its own, so
// the proxy presents the dashboard origin, but only for requests that came from this dev server's
// own page. Requests from any other origin keep their Origin and the dashboard still rejects them.
function dashboardProxy(target: string): ProxyOptions {
  const dashboard = new URL(target)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(dashboard.hostname))
    throw new Error('DASHBOARD_URL must point at a loopback dashboard server')
  return {
    target: dashboard.origin,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (request, incoming) => {
        const origin = incoming.headers.origin
        if (origin && origin === `http://${incoming.headers.host}`) request.setHeader('origin', dashboard.origin)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Anchored so the /api-keys page stays with this app.
  const proxy = { '^/api/': dashboardProxy(env.DASHBOARD_URL || 'http://127.0.0.1:3038') }
  const port = Number(env.EMAIL_WEB_PORT || 5290)
  return {
    plugins: [tailwindcss(), sveltekit()],
    server: { host: '127.0.0.1', port, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port, strictPort: true, proxy },
  }
})
