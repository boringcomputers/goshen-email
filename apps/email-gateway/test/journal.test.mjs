import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DeliveryJournal, parseDeliveryLine } from '../src/journal.mjs'

const now = Date.UTC(2026, 8, 9, 12)
const mail = { trackingId: 'bbcf8ea3-701d-4311-9bb1-8e628ab528b9', from: 'agent@customer.test',
  recipients: ['reader@outside.test'], dkim: { domainName: 'customer.test' } }
const line = (queue = 'ABC123', recipient = 'reader@outside.test', status = 'sent', dsn = '2.0.0') =>
  `Sep  9 12:00:00 mx postfix/smtp[123]: ${queue}: to=<${recipient}>, relay=mx.outside.test[1.2.3.4]:25, delay=1.2, delays=0/0/0/1.2, dsn=${dsn}, status=${status} (250 2.0.0 accepted)\n`
async function setup(t) {
  const directory = await mkdtemp(tmpdir() + '/bezalel-journal-test-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
function accepted(journal) {
  const { messageId } = journal.reserve(mail)
  journal.accepted(mail.trackingId, '250 2.0.0 Ok: queued as ABC123',
    { messageId, queued: mail.recipients, delivered: [], bounced: [], suppressed: [] })
}

test('replays reports after a Worker outage and journal restart without redispatching SMTP', async (t) => {
  const directory = await setup(t)
  let clock = now
  let journal = new DeliveryJournal(directory, () => clock)
  accepted(journal)
  await writeFile(directory + '/postfix.log', line())
  await journal.readLogs()
  await journal.flush({ delivery: async () => { throw new Error('Worker down') } })
  journal.close()
  clock += 2000
  journal = new DeliveryJournal(directory, () => clock)
  const events = []
  await journal.readLogs()
  await journal.flush({ delivery: async (event) => events.push(event) })
  await journal.flush({ delivery: async () => assert.fail('duplicate report') })
  assert.equal(events.length, 1)
  assert.equal(events[0].trackingId, mail.trackingId)
  assert.equal(events[0].status, 'delivered')
  assert.equal(events[0].deliveryTimeMs, 1200)
  assert.equal(journal.reserve(mail).receipt.queued[0], mail.recipients[0])
  journal.close()
})

test('keeps early delivery logs until the authenticated submission receipt maps their queue ID', async (t) => {
  const directory = await setup(t)
  const journal = new DeliveryJournal(directory, () => now)
  await writeFile(directory + '/postfix.log', line())
  await journal.readLogs()
  await journal.flush({ delivery: async () => assert.fail('unmapped queue') })
  accepted(journal)
  const events = []
  await journal.flush({ delivery: async (event) => events.push(event) })
  assert.equal(events.length, 1)
  journal.close()
})

test('does not attribute another queue or an unsubmitted recipient to a tracked message', async (t) => {
  const directory = await setup(t)
  const journal = new DeliveryJournal(directory, () => now)
  accepted(journal)
  await writeFile(directory + '/postfix.log', line('FORGED') + line('ABC123', 'someone-else@outside.test'))
  await journal.readLogs()
  await journal.flush({ delivery: async () => assert.fail('unowned delivery') })
  journal.close()
})

test('handles partial lines and rotated logs with byte offsets, including invalid UTF-8', async (t) => {
  const directory = await setup(t)
  const journal = new DeliveryJournal(directory, () => now)
  accepted(journal)
  const path = directory + '/postfix.log'
  await writeFile(path, Buffer.concat([Buffer.from('invalid '), Buffer.from([255]), Buffer.from('\n'), Buffer.from(line().slice(0, 20))]))
  await journal.readLogs()
  await appendFile(path, line().slice(20))
  await rename(path, path + '.20260909-120001')
  await writeFile(path, line('ABC123', 'reader@outside.test', 'deferred', '4.4.1'))
  await journal.readLogs()
  await journal.readLogs()
  const events = []
  await journal.flush({ delivery: async (event) => events.push(event) })
  assert.equal(events.length, 2)
  assert.equal(new Set(events.map((event) => event.eventId)).size, 2)
  journal.close()
})

test('rejects changed or uncertain submissions and requires a real Postfix queue receipt', async (t) => {
  const directory = await setup(t)
  const journal = new DeliveryJournal(directory, () => now)
  journal.reserve(mail)
  assert.throws(() => journal.reserve(mail), /uncertain/)
  assert.throws(() => journal.reserve({ ...mail, from: 'another@customer.test' }), /another message/)
  assert.throws(() => journal.accepted(mail.trackingId, '250 message accepted', {}), /queue identifier/)
  journal.close()
})

test('parses hard bounces and year rollover, and ignores unrelated or incomplete log lines', () => {
  const bounce = parseDeliveryLine(line('ABC123', 'reader@outside.test', 'bounced', '5.1.1').trim(), now)
  assert.equal(bounce.status, 'bounced')
  assert.equal(bounce.smtpEnhancedStatusCode, '5.1.1')
  const rollover = parseDeliveryLine(line().trim().replace('Sep  9', 'Dec 31'), Date.UTC(2027, 0, 1))
  assert.equal(rollover.occurredAt, '2026-12-31T12:00:00.000Z')
  assert.equal(parseDeliveryLine('SMTP response: ' + line(), now), null)
})
