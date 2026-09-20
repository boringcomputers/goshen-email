import worker from '../../src/worker.mjs'
export { Dashboard } from '../../src/worker.mjs'

export default {
  fetch(request, env) {
    const url = new URL(request.url)
    url.protocol = 'https:'
    const headers = new Headers(request.headers)
    url.host = headers.get('x-test-host') ?? 'dashboard.example'
    headers.set('origin', headers.get('x-test-origin') ?? 'https://dashboard.example')
    headers.set('cf-connecting-ip', headers.get('x-test-ip') ?? '192.0.2.1')
    if (env.DASHBOARD_AUTH_MODE === 'access') env.MAIL_API = {
      async fetch(url, init) {
        if (init.headers.authorization !== 'Bearer fixture-access-assertion')
          return Response.json({ error: { message: 'Invalid identity' } }, { status: 401 })
        return Response.json({ result: new URL(url).pathname.endsWith('/session')
          ? { customer: { email: 'customer@example.net', role: 'customer' } }
          : { inboxes: [{ inboxId: 'customer@example.com' }] } })
      },
    }
    if (env.DASHBOARD_AUTH_MODE === 'account') {
      env.MAIL_API = { async fetch(url, init) {
        if (init.headers.get('authorization') !== `Bearer ${env.AUTH_PROXY_SECRET}`)
          return Response.json({ error: { message: 'Invalid proxy' } }, { status: 401 })
        const cookie = init.headers.get('cookie')
        if (!['fixture=owner', 'fixture=customer'].includes(cookie)) return Response.json({ error: { message: 'Sign in' } }, { status: 401 })
        return Response.json({ result: new URL(url).pathname.endsWith('/session')
          ? { customer: cookie === 'fixture=owner' ? { email: 'owner@example.net', role: 'admin' } : { email: 'customer@example.net', role: 'customer' } }
          : { inboxes: [{ inboxId: 'standalone@example.com' }] } })
      } }
      env.NATIVE_MAIL_API = { async fetch(url, init) {
        if (init.headers.authorization !== `Bearer ${env.NATIVE_MAIL_API_TOKEN}` || new URL(url).origin !== env.NATIVE_MAIL_WORKER_URL)
          return Response.json({ error: { message: 'Invalid native credential or destination' } }, { status: 401 })
        return Response.json({ result: { inboxes: [{ inboxId: 'native@goshenemail.com' }] } })
      } }
    }
    return worker.fetch(new Request(url, { method: request.method, headers, body: request.body }), env)
  },
}
