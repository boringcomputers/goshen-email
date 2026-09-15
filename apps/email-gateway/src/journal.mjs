import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const safe = (value) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2000)
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function parseDeliveryLine(line, now = Date.now()) {
  const match = /^([A-Z][a-z]{2}) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) \S+ postfix\/(?:smtp|pipe|error)\[[0-9]+\]: ([A-Za-z0-9]+): to=<([^>\s]+)>, .*?\bdsn=([245]\.[0-9]{1,3}\.[0-9]{1,3}), status=(sent|deferred|bounced) \((.*)\)$/.exec(line)
  if (!match || !months.includes(match[1])) return null
  const [month, day, hour, minute, second] = match.slice(1, 6)
  const year = new Date(now).getUTCFullYear()
  let at = Date.UTC(year, months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second))
  if (at > now + 86400_000) at = Date.UTC(year - 1, months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second))
  const delay = /\bdelay=([0-9.]+),/.exec(line)
  const duration = delay ? Math.round(Number(delay[1]) * 1000) : NaN
  const smtp = /\b([245][0-9]{2})[ -]/.exec(match[10])
  return {
    queueId: match[6], recipient: match[7].toLowerCase(),
    status: match[9] === 'sent' ? 'delivered' : match[9],
    occurredAt: new Date(at).toISOString(), smtpEnhancedStatusCode: match[8],
    reason: safe(match[10]),
    ...(smtp ? { smtpStatusCode: smtp[1] } : {}),
    ...(Number.isFinite(duration) && duration >= 0 && duration <= 30 * 86400_000 ? { deliveryTimeMs: duration } : {}),
  }
}

export class DeliveryJournal {
  constructor(directory, clock = Date.now) {
    this.directory = directory
    this.clock = clock
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    this.db = new DatabaseSync(directory + '/journal.sqlite')
    chmodSync(directory + '/journal.sqlite', 0o600)
    this.db.exec(`
      pragma journal_mode=WAL;
      pragma synchronous=FULL;
      pragma busy_timeout=5000;
      create table if not exists submissions (
        tracking_id text primary key, fingerprint text not null, sender text not null,
        message_id text not null, recipients text not null, queue_id text unique, receipt text,
        created_at integer not null
      );
      create table if not exists cursors (id text primary key, offset integer not null);
      create table if not exists events (
        id text primary key, queue_id text not null, recipient text not null, payload text not null,
        created_at integer not null, available_at integer not null, attempts integer not null default 0,
        acknowledged integer not null default 0
      );
      create index if not exists due_events on events(acknowledged, available_at);
    `)
  }

  reserve(mail) {
    const fingerprint = hash(JSON.stringify(mail))
    const sender = typeof mail.from === 'string' ? mail.from : mail.from.address
    const messageId = '<' + mail.trackingId + '@' + mail.dkim.domainName + '>'
    const row = this.db.prepare('select * from submissions where tracking_id = ?').get(mail.trackingId)
    if (row) {
      if (row.fingerprint !== fingerprint) throw new Error('Tracking ID belongs to another message')
      if (!row.receipt) throw new Error('SMTP submission has an uncertain outcome')
      return { messageId, receipt: JSON.parse(row.receipt) }
    }
    this.db.prepare('insert into submissions(tracking_id, fingerprint, sender, message_id, recipients, created_at) values(?,?,?,?,?,?)')
      .run(mail.trackingId, fingerprint, sender, messageId, JSON.stringify(mail.recipients), this.clock())
    return { messageId }
  }

  accepted(trackingId, response, receipt) {
    const queue = /^250[ -]2\.0\.0 Ok: queued as ([A-Za-z0-9]+)$/.exec(response ?? '')
    if (!queue) throw new Error('Postfix did not return its queue identifier')
    this.db.prepare('update submissions set queue_id = ?, receipt = ? where tracking_id = ? and queue_id is null')
      .run(queue[1], JSON.stringify(receipt), trackingId)
  }

  async readLogs() {
    const files = (await readdir(this.directory)).filter((name) => /^postfix\.log(?:\.[0-9-]+)?$/.test(name))
      .sort((a, b) => a === 'postfix.log' ? 1 : b === 'postfix.log' ? -1 : a.localeCompare(b))
    for (const name of files) {
      const file = await open(this.directory + '/' + name, 'r')
      try {
        const info = await file.stat()
        const id = info.dev + ':' + info.ino + ':' + info.birthtimeMs
        const cursor = this.db.prepare('select offset from cursors where id = ?').get(id)?.offset ?? 0
        if (info.size < cursor) throw new Error('Postfix log was truncated before tracking could finish')
        const buffer = Buffer.alloc(1024 * 1024)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor)
        const end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1
        if (!end && bytesRead === buffer.length) throw new Error('Postfix log record exceeds the limit')
        if (!end) continue
        this.db.exec('begin immediate')
        try {
          for (let start = 0; start < end;) {
            const finish = buffer.indexOf(10, start)
            const raw = buffer.subarray(start, finish).toString('utf8')
            const offset = cursor + finish + 1
            start = finish + 1
            const parsed = parseDeliveryLine(raw, this.clock())
            if (!parsed) continue
            this.db.prepare('insert or ignore into events(id,queue_id,recipient,payload,created_at,available_at) values(?,?,?,?,?,?)')
              .run(hash(id + ':' + offset), parsed.queueId, parsed.recipient, JSON.stringify(parsed), this.clock(), this.clock())
          }
          this.db.prepare('insert into cursors(id,offset) values(?,?) on conflict(id) do update set offset=excluded.offset').run(id, cursor + end)
          this.db.exec('commit')
        } catch (error) { this.db.exec('rollback'); throw error }
      } finally { await file.close() }
    }
  }

  async flush(client) {
    const rows = this.db.prepare(`
      select e.*, s.tracking_id, s.sender, s.message_id, s.recipients
      from events e join submissions s on s.queue_id = e.queue_id
      where e.acknowledged = 0 and e.available_at <= ? order by e.created_at, e.rowid limit 20
    `).all(this.clock())
    for (const row of rows) {
      if (!JSON.parse(row.recipients).includes(row.recipient)) {
        this.db.prepare('update events set acknowledged=1 where id=?').run(row.id)
        continue
      }
      const { queueId: _, ...event } = JSON.parse(row.payload)
      try {
        await client.delivery({ ...event, eventId: row.id, trackingId: row.tracking_id,
          sender: row.sender, messageId: row.message_id })
        this.db.prepare('update events set acknowledged=1 where id=?').run(row.id)
      } catch {
        this.db.prepare('update events set attempts=attempts+1, available_at=? where id=?')
          .run(this.clock() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 9)), row.id)
      }
    }
  }

  async collect() {
    const old = this.clock() - 30 * 86400_000
    this.db.prepare('delete from events where acknowledged=1 and created_at < ?').run(old)
    this.db.prepare('delete from events where created_at < ? and queue_id not in (select queue_id from submissions where queue_id is not null)')
      .run(this.clock() - 3600_000)
    this.db.prepare('delete from submissions where created_at < ? and queue_id not in (select queue_id from events where acknowledged=0)').run(old)
    for (const name of (await readdir(this.directory)).filter((name) => /^postfix\.log\.[0-9-]+$/.test(name))) {
      const path = this.directory + '/' + name
      const info = await stat(path)
      const id = info.dev + ':' + info.ino + ':' + info.birthtimeMs
      const cursor = this.db.prepare('select offset from cursors where id=?').get(id)?.offset ?? 0
      if (cursor === info.size && info.mtimeMs < this.clock() - 86400_000) {
        await unlink(path)
        this.db.prepare('delete from cursors where id=?').run(id)
      }
    }
  }
  close() { this.db.close() }
}
