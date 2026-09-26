import assert from 'node:assert/strict'
import { test } from 'node:test'

// dashboard-fixture.ts uses a local database and provider doubles for OTP and inbox routing.
const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3280'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3281'
for (const value of [base, control]) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const launch = () => chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
})

async function observe(context) {
  await context.addInitScript(() => {
    window.refreshMetrics = { documentId: crypto.randomUUID(), shifts: [], pages: [], focus: [] }
    document.addEventListener('focusin', event => window.refreshMetrics.focus.push({ time: performance.now(),
      target: event.target.id || event.target.className, trusted: event.isTrusted }))
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.refreshMetrics.shifts.push({ value: entry.value,
          sources: entry.sources.map(source => ({ node: source.node?.id || source.node?.className || source.node?.nodeName || '',
            breadcrumb: Boolean(source.node?.closest?.('.breadcrumbs')),
            before: source.previousRect.toJSON(), after: source.currentRect.toJSON() })),
          focused: document.activeElement?.id || document.activeElement?.className || document.activeElement?.nodeName })
      }
    }).observe({ type: 'layout-shift', buffered: true })
    function frame() {
      if (performance.getEntriesByName('first-contentful-paint').length) {
        const pages = [...document.querySelectorAll('.workspace-content > section')]
          .filter(section => section.getBoundingClientRect().width && getComputedStyle(section).visibility !== 'hidden')
          .map(section => section.id)
        if (pages.length) {
          const value = pages.join(',')
          if (!window.refreshMetrics.pages.includes(value)) window.refreshMetrics.pages.push(value)
        }
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}

async function gate(page, pattern) {
  let release, requested
  const pending = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { requested = resolve })
  const handler = async route => { requested(); await pending; await route.continue() }
  await page.route(pattern, handler)
  return { started, release, close: async () => { release(); await page.unroute(pattern, handler) } }
}

async function firstPaint(page) {
  await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0)
  // Keep fonts pending past the short optional-font window before recording the visible layout.
  await page.waitForTimeout(200)
}

async function geometry(page, selectors) {
  return page.evaluate(selectors => Object.fromEntries(selectors.map(selector => {
    const element = document.querySelector(selector)
    if (!element) throw new Error(`Missing geometry target ${selector}`)
    const { x, y, width, height } = element.getBoundingClientRect()
    return [selector, { x, y, width, height }]
  })), selectors)
}

function unchanged(before, after, label) {
  for (const selector of Object.keys(before)) for (const dimension of ['x', 'y', 'width', 'height'])
    assert.ok(Math.abs(before[selector][dimension] - after[selector][dimension]) <= 0.5,
      `${label}: ${selector}.${dimension} changed from ${before[selector][dimension]} to ${after[selector][dimension]}`)
}

async function settledMetrics(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30)))))
  return page.evaluate(() => ({ ...window.refreshMetrics,
    cls: window.refreshMetrics.shifts.reduce((total, shift) => total + shift.value, 0) }))
}

function noShifts(metrics, label, { allowBreadcrumb = false } = {}) {
  // A browser that has never seen the workspace learns the organization name from the session, so
  // on that first visit the breadcrumb may change width. Every later load paints it from the saved workspace.
  const shifts = allowBreadcrumb ? metrics.shifts.filter(shift => !shift.sources.every(source => source.breadcrumb)) : metrics.shifts
  const cls = shifts.reduce((total, shift) => total + shift.value, 0)
  assert.ok(cls <= 0.001, `${label}: CLS ${cls}: ${JSON.stringify(shifts)}; focus: ${JSON.stringify(metrics.focus)}`)
}

async function ready(page) {
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')
    return app && !app.hidden && !app.inert && app.getAttribute('aria-busy') === 'false'
  })
}

test('public pages keep their first layout when fonts and sign-in JavaScript arrive late', { timeout: 120_000 }, async t => {
  const browser = await launch()
  t.after(() => browser.close())
  for (const width of [390, 1440]) for (const path of ['/', '/sign-in', '/sign-up']) {
    await t.test(`${path} at ${width}px on cold load and reload`, async t => {
      const context = await browser.newContext({ viewport: { width, height: 1000 } })
      t.after(() => context.close())
      await observe(context)
      const page = await context.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      const selectors = path === '/' ? ['.site-header', '.hero-copy', '.hero-actions']
        : ['.site-header', '#main', '#title', '#description', '#auth-form']
      let previousDocument
      for (const phase of ['cold', 'reload']) {
        const font = await gate(page, '**/fonts/*.woff2')
        const script = path === '/' ? null : await gate(page, '**/auth.js')
        try {
          if (phase === 'cold') await page.goto(base + path, { waitUntil: 'commit' })
          else await page.reload({ waitUntil: 'commit' })
          await font.started
          if (script) await script.started
          await firstPaint(page)
          const before = await geometry(page, selectors)
          const documentId = await page.evaluate(() => window.refreshMetrics.documentId)
          assert.notEqual(documentId, previousDocument, 'Reload creates a new document')
          previousDocument = documentId
          if (path !== '/') {
            assert.equal(await page.locator('#title').textContent(), path === '/sign-up' ? 'Make room for your email.' : 'Welcome back.')
            assert.equal(await page.locator('#name-field').isVisible(), path === '/sign-up')
            assert.equal(await page.locator('#email').getAttribute('required'), '')
          }
          font.release(); script?.release()
          await page.waitForLoadState('load')
          await page.evaluate(() => document.fonts.ready)
          unchanged(before, await geometry(page, selectors), `${path} ${width}px ${phase}`)
          const metrics = await settledMetrics(page)
          noShifts(metrics, `${path} ${width}px ${phase}`)
          t.diagnostic(`${phase}: CLS=${metrics.cls}${metrics.cls ? ` ${JSON.stringify(metrics.shifts)}` : ''}`)
        } finally { await font.close(); if (script) await script.close() }
      }
      assert.deepEqual(errors, [])
    })
  }
})

async function signIn(context, { name = 'Refresh regression', organization = 'Refresh Labs' } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8), email = `refresh-${suffix}@example.net`
  const post = (path, data) => context.request.post(base + path, { headers: { origin: base }, data })
  assert.equal((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status(), 200)
  const sends = await (await context.request.get(control + '/sends')).json()
  const otp = sends.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
  assert.equal((await post('/api/auth/sign-in/email-otp', { email, otp, name })).status(), 200)
  assert.equal((await post('/api/rpc/updateSettings', { organizationName: organization })).status(), 200)
  const inbox = await post('/api/rpc/createInbox', { username: `refresh-${suffix}`, displayName: name })
  assert.equal(inbox.status(), 200)
  const { inboxId } = (await inbox.json()).result
  assert.equal((await context.request.post(control + '/receive', { data: { inboxId, subject: `Saved for ${name}` } })).status(), 200)
  return { inboxId, email }
}

// Everything a person can read on the page, so a later comparison proves the network changed nothing.
const visibleText = page => page.evaluate(() => {
  const read = element => element.matches('input, select') ? element.value : element.textContent.replace(/\s+/g, ' ').trim()
  return Object.fromEntries([...document.querySelectorAll('#workspace-breadcrumb, #page-title, #account-name, #account, .resource-nav a, #get-started, #inbox-count, #inbox-page-count, #inbox-rows, #inboxes-empty, #organization-name, #profile-name, #settings-email, #notification-email, #mail-heading, #inboxes, #mailbox-address, #thread-count, #threads, #conversation')]
    .filter(element => element.checkVisibility()).map((element, index) => [`${element.id || element.className}#${index}`, read(element)]))
})
const savedWorkspace = page => page.evaluate(() => JSON.parse(localStorage.getItem('bezalel.dashboard.snapshot')))

test('dashboard refresh paints the saved workspace before session and inventory requests finish', { timeout: 180_000 }, async t => {
  const browser = await launch()
  t.after(() => browser.close())
  const account = await browser.newContext()
  const { inboxId, email } = await signIn(account), storageState = await account.storageState()
  await account.close()
  for (const width of [390, 1440]) for (const [hash, section] of [
    ['#/inboxes', 'inboxes-page'], ['#/settings', 'settings-page'], [`#/inboxes/${encodeURIComponent(inboxId)}`, 'mail-page'],
  ]) {
    await t.test(`${section} at ${width}px on cold load and reload`, async t => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, storageState })
      t.after(() => context.close())
      await observe(context)
      const page = await context.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      const shellSelectors = ['#app', '.workspace', '.topbar', '.workspace-content', `#${section} > header`]
      if (width >= 768) shellSelectors.push('#sidebar')
      if (section === 'inboxes-page') shellSelectors.push(...[1, 3, 5].map(index => `#inboxes-page th:nth-child(${index})`))
      // Content painted from the saved workspace must also hold still once the network answers.
      const contentSelectors = [...shellSelectors, ...(width >= 768 ? ['#account-button'] : []),
        ...({ 'inboxes-page': ['#inbox-count', '.resource-table-wrap'], 'settings-page': ['#organization-form', '#profile-form'], 'mail-page': ['#threads', '.list-header'] })[section]]
      let previousDocument
      for (const phase of ['cold', 'reload']) {
        const selectors = phase === 'cold' ? shellSelectors : contentSelectors
        const session = await gate(page, '**/api/session'), inventory = await gate(page, '**/api/rpc/listInboxes')
        try {
          if (phase === 'cold') await page.goto(base + '/app' + hash, { waitUntil: 'commit' })
          else await page.reload({ waitUntil: 'commit' })
          await session.started
          await firstPaint(page)
          const documentId = await page.evaluate(() => window.refreshMetrics.documentId)
          assert.notEqual(documentId, previousDocument, 'Reload creates a new document')
          previousDocument = documentId
          assert.equal(await page.locator('#app').isVisible(), true)
          assert.equal(await page.locator('#app').evaluate(app => app.inert), true)
          assert.equal(await page.locator('#app').getAttribute('aria-busy'), 'true')
          assert.equal(await page.locator('#workspace-loading').evaluate(status => Boolean(status.closest('[inert]'))), false,
            'The loading status remains available to assistive technology')
          assert.equal(await page.locator(`#${section}`).isVisible(), true)
          assert.equal(await page.locator('#triage-filters').isVisible(), false)
          assert.equal(await page.locator('#page-title').textContent(), section === 'settings-page' ? 'Settings' : 'Inboxes')
          if (phase === 'cold') {
            // A browser that has never shown this workspace has nothing to paint yet.
            assert.equal(await page.locator('#workspace-breadcrumb').textContent(), 'Your workspace')
            assert.equal(await page.locator('#inbox-rows tr').count(), 0, 'No saved account rows appear before authentication')
            assert.equal(await savedWorkspace(page), null)
          } else {
            // The saved workspace is on screen before any response arrives.
            assert.equal(await page.locator('#workspace-breadcrumb').textContent(), 'Refresh Labs')
            assert.equal(await page.locator('#account-name').textContent(), 'Refresh regression')
            assert.equal(await page.locator('#account').textContent(), `${email} · No inbox limit`)
            if (width >= 768) {
              assert.equal(await page.locator('#settings').isVisible(), true)
              assert.equal(await page.locator('.resource-nav').first().evaluate(nav => getComputedStyle(nav).visibility), 'visible')
            }
            if (section === 'inboxes-page') {
              assert.equal(await page.locator('#inbox-rows tr').count(), 1)
              assert.equal(await page.locator('#inbox-rows strong').textContent(), 'Refresh regression')
              assert.equal(await page.locator('#inbox-count').textContent(), '1 inbox')
              assert.equal(await page.locator('#inbox-count').evaluate(count => getComputedStyle(count).visibility), 'visible')
            }
            if (section === 'settings-page') {
              assert.equal(await page.locator('#settings-loading').isVisible(), false)
              assert.equal(await page.locator('#organization-name').inputValue(), 'Refresh Labs')
              assert.equal(await page.locator('#profile-name').inputValue(), 'Refresh regression')
              assert.equal(await page.locator('#settings-email').inputValue(), email)
            }
            if (section === 'mail-page') {
              assert.equal(await page.locator('#mail-heading').textContent(), 'Refresh regression')
              assert.equal(await page.locator('#inboxes').inputValue(), inboxId)
              assert.equal(await page.locator('#threads .thread').count(), 1)
              assert.equal(await page.locator('#threads .subject').textContent(), 'Saved for Refresh regression')
              assert.equal(await page.locator('#thread-count').textContent(), '1')
              assert.equal(await page.getByText('Loading mail').count(), 0)
            }
          }
          const before = await geometry(page, selectors), text = await visibleText(page)
          session.release()
          await inventory.started
          assert.equal(await page.locator('#app').evaluate(app => app.inert), true)
          unchanged(before, await geometry(page, selectors), `${section} ${phase} before inventory`)
          inventory.release()
          await ready(page)
          assert.equal(await page.locator(`#${section} h1`).evaluate(heading => heading === document.activeElement), true,
            'The page heading receives focus after the workspace becomes interactive')
          unchanged(before, await geometry(page, selectors), `${section} ${width}px ${phase}`)
          if (phase === 'reload') assert.deepEqual(await visibleText(page), text, 'Fresh data changes nothing the saved workspace already showed')
          if (section === 'mail-page') assert.equal(await page.locator('#threads .thread').count(), 1)
          const metrics = await settledMetrics(page)
          assert.deepEqual(metrics.pages, [section], 'No other dashboard view flashes during startup')
          noShifts(metrics, `${section} ${width}px ${phase}`, { allowBreadcrumb: phase === 'cold' })
          assert.equal(await page.locator('#workspace-loading').isVisible(), false)
          const saved = await savedWorkspace(page)
          assert.equal(saved.session.customer.email, email, 'The workspace is saved for the next load')
          assert.equal(saved.inboxes.length, 1)
          const markerCookie = (await context.cookies(base)).find(cookie => cookie.name === 'workspace')
          assert.equal(markerCookie.httpOnly, false)
          assert.equal(saved.marker, markerCookie.value, 'The saved workspace is bound to the session marker')
          assert.equal(JSON.stringify(saved).includes('token'), false, 'The saved workspace holds no credentials')
          t.diagnostic(`${phase}: CLS=${metrics.cls}${metrics.cls ? ` ${JSON.stringify(metrics.shifts)}` : ''}`)
        } finally { await session.close(); await inventory.close() }
      }
      assert.deepEqual(errors, [])
    })
  }
})

test('anonymous sessions redirect and loading errors leave a usable recovery path', { timeout: 60_000 }, async t => {
  const browser = await launch()
  t.after(() => browser.close())
  const anonymous = await browser.newContext(), page = await anonymous.newPage()
  await page.goto(base + '/app#/settings')
  await page.waitForURL('**/sign-in#/settings')
  assert.equal(await page.locator('#auth-form').isVisible(), true)
  await anonymous.close()

  const account = await browser.newContext()
  await signIn(account)
  const authenticated = await account.newPage()
  await authenticated.route('**/api/rpc/listInboxes', route => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ error: 'Fixture inventory unavailable' }) }))
  await authenticated.goto(base + '/app#/inboxes')
  await ready(authenticated)
  assert.equal(await authenticated.locator('#inboxes-error').textContent(), 'Fixture inventory unavailable')
  assert.equal(await authenticated.locator('#inboxes-empty').isVisible(), false)
  await authenticated.unroute('**/api/rpc/listInboxes')
  await authenticated.locator('#refresh-inboxes').click()
  await authenticated.waitForFunction(() => document.querySelectorAll('#inbox-rows tr').length === 1)
  await account.close()

  // Password mode is represented only at the browser boundary; no private credentials are used.
  const password = await browser.newContext(), login = await password.newPage()
  await login.route('**/api/session', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ authenticated: false }) }))
  await login.route('**/api/login', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ authenticated: true }) }))
  await login.route('**/api/rpc/listInboxes', route => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ error: 'Fixture password inventory unavailable' }) }))
  await login.goto(base + '/app')
  await login.locator('#login-form input').fill('browser-fixture-password')
  await login.locator('#login-form button').click()
  await ready(login)
  assert.equal(await login.locator('#inboxes-error').textContent(), 'Fixture password inventory unavailable')
  assert.equal(await login.locator('#refresh-inboxes').isEnabled(), true)
  await password.close()
})
