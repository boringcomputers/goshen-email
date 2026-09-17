import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = (await readFile(new URL('../public/notifications.js', import.meta.url), 'utf8')).replace('export function', 'function')
const owner = { id: 'owner', desktopNotifications: true }
const message = id => ({ id, inboxId: 'support@example.com' })
function sharedBrowser() {
  const storage = new Map()
  let last = Promise.resolve()
  return {
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    locks: { request: (_key, callback) => { const task = last.then(callback); last = task.catch(() => {}); return task } },
  }
}
function tab(shared = sharedBrowser()) {
  let timer, rows = [], focused = true, request = async () => ({ notifications: rows })
  const alerts = [], opened = []
  class Notification {
    static permission = 'granted'
    constructor(title, options) {
      assert.equal(Notification.permission, 'granted')
      this.title = title; this.options = options; alerts.push(this)
    }
    close() { this.closed = true; this.onclose?.() }
  }
  const create = runInNewContext(`${source}\ncreateDesktopNotifications`, {
    window: { Notification, focus() {} }, Notification,
    navigator: { locks: shared.locks }, localStorage: shared.storage,
    document: { hasFocus: () => focused },
    setInterval: callback => { timer = callback; return 1 }, clearInterval: () => { timer = null },
  })
  const panel = create({ rpc: () => request(), openInbox: inbox => opened.push(inbox) })
  return { panel, alerts, opened, Notification, setRows: value => { rows = value }, setRequest: value => { request = value },
    setFocused: value => { focused = value }, tick: async () => { await timer?.() },
    settle: () => new Promise(resolve => setImmediate(resolve)) }
}

test('granting permission after enabling desktop alerts does not discard the first new message', async () => {
  const t = tab()
  t.Notification.permission = 'default'
  t.setRows([message('historical')])
  t.panel.start(owner); await t.settle()
  t.Notification.permission = 'granted'
  t.setRows([message('new'), message('historical')])
  await t.tick()
  assert.equal(t.alerts.length, 1)
  assert.equal(t.alerts[0].options.body, 'New mail in support@example.com')
  await t.tick()
  assert.equal(t.alerts.length, 1)
  t.alerts[0].onclick()
  assert.deepEqual(t.opened, ['support@example.com'])
  t.panel.reset()
})

test('two tabs show only one alert for the same new arrival', async () => {
  const shared = sharedBrowser(), a = tab(shared), b = tab(shared)
  a.panel.start(owner); b.panel.start(owner)
  await Promise.all([a.settle(), b.settle()])
  a.setRows([message('new')]); b.setRows([message('new')])
  await Promise.all([a.tick(), b.tick()])
  assert.equal(a.alerts.length + b.alerts.length, 1)
  a.panel.reset(); b.panel.reset()
})

test('sign-out and opt-out close visible alerts and discard outstanding responses', async () => {
  const t = tab()
  t.panel.start(owner); await t.settle()
  t.setRows([message('new')]); await t.tick()
  let release
  t.setRequest(() => new Promise(resolve => { release = resolve }))
  const pending = t.tick()
  t.panel.reset()
  release({ notifications: [message('late')] }); await pending
  assert.equal(t.alerts.length, 1)
  assert.equal(t.alerts[0].closed, true)
  t.alerts[0].onclick()
  assert.deepEqual(t.opened, [])
  t.setRequest(async () => ({ notifications: [] }))
  t.panel.start(owner); await t.settle()
  t.setRequest(async () => ({ notifications: [message('next')] }))
  await t.tick()
  t.panel.start({ ...owner, desktopNotifications: false })
  assert.equal(t.alerts[1].closed, true)
  await t.tick(); assert.equal(t.alerts.length, 2)
  t.panel.reset()
})

test('denied permission stays quiet and the next successful poll recovers from a failed request', async () => {
  const t = tab()
  t.Notification.permission = 'denied'
  t.panel.start(owner); await t.settle()
  t.setRows([message('blocked')]); await t.tick()
  assert.equal(t.alerts.length, 0)
  t.Notification.permission = 'granted'
  t.setRequest(async () => { throw new Error('Temporary network failure') })
  await t.tick(); assert.equal(t.alerts.length, 0)
  t.setRequest(async () => ({ notifications: [message('new'), message('blocked')] }))
  await t.tick()
  assert.equal(t.alerts.length, 1)
  assert.equal(t.alerts[0].options.body, 'New mail in support@example.com')
  t.panel.reset()
})
