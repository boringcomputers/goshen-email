import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest'
import { fixture, rawMail } from './support.js'
import { CustomerStore, updateSettingsInput, type Customer } from '../src/customer-store.js'
import { desktopNotifications, sendNotifications } from '../src/notifications.js'

let f: Awaited<ReturnType<typeof fixture>>, store: CustomerStore, owner: Customer, other: Customer
beforeAll(async () => { f = await fixture(); store = new CustomerStore(f.db, []) })
afterAll(async () => { await f.pg.close() })
beforeEach(async () => {
  await f.pg.exec('truncate mail.customers, mail.inboxes cascade')
  f.send.mockClear()
  for (const email of ['owner@example.net', 'other@example.net']) {
    await store.invite({ email, inboxLimit: 5 })
    const customer = await store.resolve({ email, subject: email })
    if (email.startsWith('owner')) owner = customer; else other = customer
  }
  await f.service.execute('createInbox', { username: 'agent' })
  await f.db.query(`insert into mail.customer_inboxes(customer_id, inbox_id) select $1, id from mail.inboxes where address = 'agent@example.com'`, [owner.id])
})
const enable = () => store.updateSettings(owner, { desktopNotifications: true, emailNotifications: true })
const receive = (id: string) => f.service.receive('agent@example.com', rawMail({ id: `<${id}@example.net>` }))
const deliver = () => sendNotifications(f.db, f.service.transport, 'notify@example.com', 'https://app.example.com')

it('defaults off, validates booleans, persists independent preferences and never queues old or duplicate mail', async () => {
  expect(owner).toMatchObject({ desktopNotifications: false, emailNotifications: false })
  expect(updateSettingsInput.safeParse({ emailNotifications: 'true' }).success).toBe(false)
  expect(updateSettingsInput.safeParse({ emailNotifications: true, email: 'victim@example.net' }).success).toBe(false)
  await receive('old'); await enable(); await receive('new'); await receive('new')
  expect((await desktopNotifications(f.db, owner.id)).notifications).toHaveLength(1)
  expect((await desktopNotifications(f.db, other.id)).notifications).toEqual([])
  await store.updateSettings(owner, { organizationName: 'Studio' })
  expect(await store.resolve({ email: owner.email, subject: owner.email })).toMatchObject({ desktopNotifications: true, emailNotifications: true })
  await Promise.all([deliver(), deliver()])
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(f.send.mock.calls[0]![0]).toMatchObject({ to: ['owner@example.net'], subject: 'New mail in Bezalel Email', headers: { 'Auto-Submitted': 'auto-generated' } })
  expect(f.send.mock.calls[0]![0].text).not.toContain('Invoice question')
  await deliver(); expect(f.send).toHaveBeenCalledTimes(1)
})

it('groups arrivals, stops queued alerts on opt-out and does not replay them after re-enabling', async () => {
  await enable(); await receive('a'); await receive('b')
  await deliver()
  expect(f.send.mock.calls[0]![0].text).toContain('2 new messages')
  await receive('c')
  await store.updateSettings(owner, { emailNotifications: false, desktopNotifications: false })
  await enable(); await deliver()
  expect(f.send).toHaveBeenCalledTimes(1)
  expect((await desktopNotifications(f.db, owner.id)).notifications).toEqual([])
  await receive('d'); await deliver()
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('excludes quarantined, trashed, deleted and disabled inbox ownership at delivery', async () => {
  await enable(); await receive('a')
  await f.db.query(`update mail.messages set labels = array['quarantined']`)
  await deliver(); expect(f.send).not.toHaveBeenCalled()
  expect((await desktopNotifications(f.db, owner.id)).notifications).toEqual([])
  await f.db.query(`update mail.messages set labels = array['trash']`)
  await deliver(); expect(f.send).not.toHaveBeenCalled()
  await f.pg.exec(`update mail.messages set labels = array['received']; update mail.inboxes set deleted_at = now()`)
  await deliver(); expect(f.send).not.toHaveBeenCalled()
  await f.db.query(`update mail.inboxes set deleted_at = null`)
  await store.setAccess(owner.id, false)
  await deliver(); expect(f.send).not.toHaveBeenCalled()
  expect((await desktopNotifications(f.db, owner.id)).notifications).toEqual([])
})

it('suppresses automatic-mail loops and never retries uncertain notification sends', async () => {
  await enable()
  const automatic = new TextEncoder().encode('Auto-Submitted: auto-generated\r\n' + new TextDecoder().decode(rawMail()))
  await f.service.receive('agent@example.com', automatic)
  await deliver(); expect(f.send).not.toHaveBeenCalled()
  expect((await desktopNotifications(f.db, owner.id)).notifications).toHaveLength(1)
  await receive('normal')
  f.send.mockRejectedValueOnce(new Error('connection lost after acceptance'))
  await deliver(); await deliver()
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(await f.db.query(`select email_state from mail.notifications where email_requested`)).toEqual([{ email_state: 'failed' }])
})
