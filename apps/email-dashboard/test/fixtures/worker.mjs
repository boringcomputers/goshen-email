import worker from '../../src/worker.mjs'
export { Dashboard } from '../../src/worker.mjs'

export default {
  fetch(request, env) {
    const url = new URL(request.url)
    url.protocol = 'https:'
    url.host = 'dashboard.example'
    const headers = new Headers(request.headers)
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
    return worker.fetch(new Request(url, { method: request.method, headers, body: request.body }), env)
  },
}
