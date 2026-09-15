import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import worker, { serviceFor, type Env } from '../src/worker.js'
import { MailService } from '../src/mail-service.js'
import { clientEventTarget } from '../src/mail-clients.js'
import { config, fixture, rawMail } from './support.js'

describe('standalone webhook configuration', () => {
  const environment = (): Env => ({
    HYPERDRIVE: { connectionString: 'postgres://test:test@db.example.com/mail' } as Hyperdrive,
    MAIL_API_TOKEN: config.apiToken, MAIL_WEBHOOK_SECRET: config.webhookSecret,
    CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    EMAIL_DOMAINS: JSON.stringify(config.domains), DEFAULT_EMAIL_DOMAIN: config.defaultDomain,
    PUBLIC_EMAIL_URL: config.publicUrl, WORKER_NAME: 'standalone-test', MAIL_OBJECTS: {} as R2Bucket,
  })
  it('starts without a Bezalel server and accepts an arbitrary HTTPS webhook path', () => {
    expect(serviceFor(environment()).config.eventsUrl).toBeUndefined()
    expect(serviceFor({ ...environment(), MAIL_EVENTS_URL: 'https://agent.example.com/mail' }).config.eventsUrl).toBe('https://agent.example.com/mail')
    expect(serviceFor({ ...environment(), BEZALEL_EVENTS_URL: config.eventsUrl }).config.eventsUrl).toBe(config.eventsUrl)
    expect(() => serviceFor({ ...environment(), MAIL_EVENTS_URL: 'http://public.example.com/private' })).toThrow()
  })
  it('requires a Hyperdrive binding and redacts configuration errors', async () => {
    const response = await worker.fetch(new Request('https://mail.example.com/healthz'), {
      ...environment(), HYPERDRIVE: undefined,
      DATABASE_URL: 'postgres://private:secret@db.example.com/mail',
    } as unknown as Env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: {
      message: 'Email Worker is not configured', code: 'not_configured', transient: false,
    } })
  })
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { f = await fixture() })
  afterAll(async () => { await f.pg.close() })
  it('stores incoming mail without queueing retries when the shared webhook is disabled', async () => {
    const service = new MailService({ ...f.service, config: { ...config, eventsUrl: undefined } })
    await service.execute('createInbox', { username: 'standalone' })
    await service.receive('standalone@example.com', rawMail())
    await service.flushEvents()
    expect(f.request).not.toHaveBeenCalled()
    expect(await f.db.query('select * from mail.outbox where delivered_at is null')).toHaveLength(0)
    expect(await service.execute('listMessages', { inboxId: 'standalone@example.com' })).toMatchObject({ messages: [{ subject: 'Invoice question' }] })
    await expect(service.execute('ensureWebhook', { url: 'https://agent.example.com/mail' })).rejects.toMatchObject({ status: 503 })
  })
  it('keeps product mailbox destinations when the shared webhook is disabled', async () => {
    const service = new MailService({ ...f.service, config: { ...config, eventsUrl: undefined } })
    const [inbox] = await f.db.query<{ id: string }>("select id from mail.inboxes where address = 'standalone@example.com'")
    await f.db.query(`insert into mail.clients(client_id, inbox_id, webhook_url, daily_send_limit)
      values ('test-client', $1, 'https://agent.example.com/inbound', 250)`, [inbox!.id])
    expect(await clientEventTarget(service, inbox!.id)).toMatchObject({ url: 'https://agent.example.com/inbound', secret: expect.stringMatching(/^whsec_/) })
  })
})
