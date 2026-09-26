import { createDesktopNotifications } from "/notifications.js"
import { triageBadges, triageDetails } from "./triage.js"
import { createDeveloperPanel } from "./developer.js"
import { createInboxSetup, connectionCommand } from './setup.js'
import { createDashboardConsole } from './console.js'
import { createSettingsPanel } from './settings.js'
import { createBillingPanel } from './billing.js'
import { createNativeMailPanel } from './native-mail.js'
const $ = (selector) => document.querySelector(selector)
// dashboard-shell.js paints the last saved workspace before this module loads; the same painters render fresh data.
const shell = window.BezalelDashboardShell
const { icon, node, avatar, snapshot } = shell
const accountEvents = new BroadcastChannel('bezalel-account')
accountEvents.addEventListener('message', (event) => { if (event.data === 'signed-out' && state.authMode === 'account') showLogin(state.authMode, '', false) })
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
const state = { session: null, epoch: 0, inboxes: [], inbox: '', folder: 'inbox', query: '', triageFilters: {}, page: undefined, threads: [], selected: '', listVersion: 0, readVersion: 0, draft: null }
const folderNames = { inbox: 'Inbox', sent: 'Sent', all: 'All mail', quarantined: 'Quarantine', trash: 'Trash' }
let noticeTimer
function emptyState(title, description, buttonText, onClick) {
  const wrap = shell.emptyState(title, description, buttonText)
  if (buttonText) action(wrap.querySelector('button'), onClick)
  return wrap
}
// "Name <address>" splits into both parts; a bare address stays the name.
function parseAddress(value = '') {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value)
  return match ? { name: match[1] || match[2], address: match[1] ? match[2] : '' } : { name: value, address: '' }
}
const listOf = (items) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
const heldReasons = (reasons = []) => listOf(reasons.map((reason) => ({
  authentication_failed: 'failed sender authentication', spam: 'scored above the spam threshold',
  malware: 'matched a malware signature', scan_incomplete: 'could not be fully scanned',
})[reason] ?? reason.replaceAll('_', ' ')))
const authNotes = {
  SPF: { pass: 'Sender authorized', fail: 'Sender not authorized', none: 'No SPF record' },
  DKIM: { pass: 'Signature valid', fail: 'Signature invalid', none: 'No signature' },
  DMARC: { pass: 'Passed the domain policy', fail: 'Failed the domain policy', none: 'No DMARC policy' },
}
const authOther = { temperror: 'Temporary lookup error', permerror: 'Record could not be read', unavailable: 'Not checked' }
function protectionChecks(protection) {
  const table = node('div', undefined, 'protection-checks'), heading = node('div', undefined, 'protection-heading')
  heading.append(node('strong', 'Protection checks'))
  if (protection.scannedAt) heading.append(node('span', `Scanned ${new Date(protection.scannedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`))
  table.append(heading)
  const row = (name, detail, text, tone) => {
    const item = node('div', undefined, 'protection-row')
    item.append(node('span', name, 'protection-name'), node('span', detail, 'protection-detail'), shell.pill(text, tone))
    table.append(item)
  }
  const auth = protection.authentication ?? {}
  for (const name of ['SPF', 'DKIM', 'DMARC']) {
    const result = auth[name.toLowerCase()] ?? 'unavailable'
    const detail = name === 'DKIM' && result === 'pass' && auth.signingDomains?.length ? `Signed by ${auth.signingDomains.join(', ')}` : authNotes[name][result] ?? authOther[result] ?? result
    row(name, detail, result === 'pass' ? 'Pass' : ['fail', 'permerror'].includes(result) ? 'Fail' : result === 'none' ? 'None' : 'Unknown',
      result === 'pass' ? 'success' : ['fail', 'permerror'].includes(result) ? 'danger' : 'neutral')
  }
  if (protection.spam) {
    const spam = protection.spam.score >= protection.spam.threshold
    row('Spam score', `${protection.spam.score}, threshold ${protection.spam.threshold}`, spam ? 'Spam' : 'Not spam', spam ? 'warning' : 'success')
  }
  const antivirus = protection.antivirus?.status
  if (antivirus) row('Antivirus', antivirus === 'infected' ? protection.antivirus.signatures.join(', ') || 'Threat found' : antivirus === 'clean' ? 'No signatures found' : 'Could not be scanned',
    antivirus === 'clean' ? 'Clean' : antivirus === 'infected' ? 'Infected' : 'Unscanned', antivirus === 'clean' ? 'success' : antivirus === 'infected' ? 'danger' : 'warning')
  if (protection.releasedAt) table.append(node('p', `Released ${new Date(protection.releasedAt).toLocaleString()}`, 'protection-note'))
  return table
}
function deliverySummary(delivery) {
  const recipients = delivery.recipients, title = (value) => value.charAt(0).toUpperCase() + value.slice(1)
  // A complaint can follow a delivery, so a problem outranks the delivered flag.
  const problem = (recipient) => /bounce|fail|reject|complain/i.test(recipient.status)
  const groups = new Map()
  for (const recipient of recipients) {
    if (recipient.delivered && !problem(recipient)) continue
    const status = recipient.status || 'sent'
    if (!groups.has(status)) groups.set(status, { tone: problem(recipient) ? 'danger' : 'neutral', addresses: [] })
    groups.get(status).addresses.push(recipient.recipient)
  }
  const summary = node('div', undefined, 'delivery-summary')
  // Problems first, then each pending status, each naming its recipients when it doesn't cover all of them.
  for (const [status, { tone, addresses }] of [...groups].sort(([, a], [, b]) => (a.tone === 'danger' ? 0 : 1) - (b.tone === 'danger' ? 0 : 1))) {
    summary.append(shell.pill(title(status), tone))
    if (addresses.length < recipients.length) summary.append(node('span', addresses.join(', ')))
  }
  if (!groups.size) summary.append(shell.pill('Delivered', 'success'))
  const reasons = recipients.filter((recipient) => recipient.reason)
  if (!reasons.length) return summary
  const details = node('details', undefined, 'message-details')
  details.append(node('summary', 'Delivery details'), node('pre', recipients.map((recipient) => `${recipient.recipient}: ${recipient.status}${recipient.reason ? ` · ${recipient.reason}` : ''}`).join('\n')))
  const wrap = node('div'); wrap.append(summary, details)
  return wrap
}
const mobileViewport = matchMedia('(max-width: 767px)')
const compactViewport = matchMedia('(max-width: 1023px)')
function setMenu(open, restoreFocus = true) {
  $('#app').classList.toggle('menu-open', open)
  $('#sidebar-backdrop').hidden = !open
  $('#open-menu').setAttribute('aria-expanded', String(open))
  $('#sidebar').inert = mobileViewport.matches && !open
  $('.workspace').inert = mobileViewport.matches && open
  if (open) $('#close-menu').focus()
  else if (restoreFocus && mobileViewport.matches) $('#open-menu').focus()
}
$('#open-menu').addEventListener('click', () => setMenu(true))
$('#close-menu').addEventListener('click', () => setMenu(false))
$('#sidebar-backdrop').addEventListener('click', () => setMenu(false))
$('#sidebar').addEventListener('click', (event) => {
  if (mobileViewport.matches && event.target.closest('button, a') && event.target.closest('button, a').id !== 'close-menu') setMenu(false, false)
})
$('#sidebar').addEventListener('keydown', (event) => {
  if (!mobileViewport.matches || !$('#app').classList.contains('menu-open') || document.querySelector('dialog[open]')) return
  if (event.key === 'Escape') { event.preventDefault(); setMenu(false) }
  if (event.key !== 'Tab') return
  const controls = [...$('#sidebar').querySelectorAll('button:not(:disabled), a[href], select, summary')].filter((element) => element.checkVisibility())
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
})
mobileViewport.addEventListener('change', () => setMenu(false, false))
setMenu(false, false)
function updateAccount() {
  notifications.start(state.session?.customer)
  shell.paintAccount({ session: state.session, inboxes: state.inboxes, inbox: state.inbox })
}
// Save what the shell needs to paint the next load. Names, flags, and URLs only; never tokens or cursors.
function rememberSession() {
  const session = state.session
  if (!session) return
  const customer = session.customer && Object.fromEntries(['id', 'email', 'displayName', 'organizationName', 'role', 'inboxLimit', 'desktopNotifications', 'emailNotifications'].map(key => [key, session.customer[key]]))
  snapshot.update({ marker: snapshot.marker(), session: { authMode: session.authMode, customer, defaultDomain: session.defaultDomain, apiUrl: session.apiUrl,
    customDomainsEnabled: session.customDomainsEnabled, nativeMailEnabled: session.nativeMailEnabled } })
}

const notify = (message) => {
  clearTimeout(noticeTimer)
  $('#notice').textContent = message
  $('#notice').hidden = false
  noticeTimer = setTimeout(() => { $('#notice').hidden = true }, 7000)
}
async function request(path, value) {
  const epoch = state.epoch
  const response = await fetch(path, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  })
  let body
  try { body = await response.json() } catch {
    showLogin(state.authMode ?? 'access')
    throw new Error('Your session ended. Reload this page to sign in.')
  }
  if (epoch !== state.epoch) throw new Error('Session changed. Sign in again.')
  if (body.authMode) state.authMode = body.authMode
  if (!response.ok) {
    // Other 403s refuse one operation; the session is still valid.
    const ended = response.status === 401 || (response.status === 403 && body.code === 'access_denied')
    if (ended && path !== '/api/login') {
      showLogin(state.authMode, response.status === 403 ? 'access_denied' : '')
      $('#login-error').textContent = body.error ?? 'Sign in to continue'
    }
    throw Object.assign(new Error(body.error ?? 'Email request failed'), { status: response.status })
  }
  return body
}
const rpc = async (operation, value = {}) => (await request(`/api/rpc/${operation}`, value)).result
const nativeMail = createNativeMailPanel({ rpc: async (operation, value) => (await request(`/api/native-rpc/${operation}`, value)).result,
  remember: inboxes => snapshot.update({ nativeInboxes: inboxes }) })
const setup = createInboxSetup({ state, rpc, createInbox, loadInboxes, notify,
  openCredentials: () => $('#credentials').click(),
  onVisibilityChange(open) {
    dashboard.showSetup(open)
    if (open) $('#get-started').setAttribute('aria-current', 'page')
    else $('#get-started').removeAttribute('aria-current')
    for (const button of document.querySelectorAll('[data-folder]')) {
      if (!open && !state.query && button.dataset.folder === state.folder) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
  },
})
async function createInbox(input) {
  try {
    const result = await rpc('createInbox', input)
    await loadInboxes(result.inboxId)
    return result
  } catch (error) {
    await loadInboxes().catch(() => {})
    throw error
  }
}
const action = (element, task) => element.addEventListener('click', async () => {
  element.disabled = true
  try { await task() } catch (error) { notify(error.message) } finally { element.disabled = false }
})
const developers = createDeveloperPanel({ rpc, notify, getSession: () => state.session, remember: keys => snapshot.update({ apiKeys: keys }) })
const notifications = createDesktopNotifications({ rpc, async openInbox(inboxId) {
  const epoch = state.epoch
  try {
    if (!state.inboxes.some(inbox => inbox.inboxId === inboxId)) await loadInboxes()
    if (epoch === state.epoch) dashboard.openInbox(inboxId)
  } catch (error) { if (epoch === state.epoch) notify(error.message) }
} })
const settings = createSettingsPanel({ rpc, getAuthMode: () => state.authMode, getCustomer: () => state.session?.customer, onChange(customer) {
  if (state.session?.customer?.id !== customer.id) return
  state.session.customer = customer
  updateAccount(); rememberSession()
} })
const billing = createBillingPanel({ rpc, notify, getCustomer: () => state.session?.customer, onUsage: rememberUsage })
// The sidebar card shows sends this month from the plan meters, saved with the workspace for the next load.
function rememberUsage(usage) {
  const metered = usage?.billing === 'metered', sends = metered ? usage.features.find((feature) => feature.feature === 'sends') : null
  const inboxLimit = (metered ? usage.features.find((feature) => feature.feature === 'inboxes')?.granted : usage?.inboxes?.limit) ?? null
  const summary = sends || inboxLimit ? { ...(sends ? { used: sends.used, granted: sends.granted, unlimited: sends.unlimited } : {}), inboxLimit } : null
  shell.paintUsage(summary)
  snapshot.update({ usage: summary })
}
async function loadUsage() {
  const epoch = state.epoch
  try {
    const usage = await rpc('getUsage')
    if (epoch === state.epoch) rememberUsage(usage)
  } catch {}
}
const dashboard = createDashboardConsole({ state, rpc, notify, selectInbox, loadInboxes,
  closeSetup: () => setup.close(), openSetup: () => setup.open(), closeNavigation: () => setMenu(false, false),
  loadPage: async page => {
    if (page === 'api-keys') await developers.load()
    if (page === 'domains') { $('#domains-error').textContent = ''; await loadDomains() }
    if (page === 'settings') await settings.load()
    if (page === 'billing') await billing.load()
    if (page === 'native-mail') await nativeMail.load()
  },
})
function setWorkspaceLoading(loading) {
  $('#app').inert = loading
  $('#app').setAttribute('aria-busy', String(loading))
  $('#workspace-loading').hidden = !loading
  if (!loading) {
    delete $('#app').dataset.restored
    delete document.documentElement.dataset.initialPage
  }
}
async function startWorkspace() {
  const epoch = state.epoch
  setWorkspaceLoading(true)
  $('#login').hidden = true; $('#app').hidden = false
  try {
    try { await loadInboxes(window.BezalelDashboardRoutes.parse(location.hash).inboxId) } catch (error) { if (epoch === state.epoch) $('#inboxes-error').textContent = error.message }
    if (epoch !== state.epoch || $('#app').hidden) return
    developers.configure()
    await dashboard.start()
    if (epoch === state.epoch && !$('#billing').hidden && dashboard.page !== 'billing') void loadUsage()
  } finally {
    if (epoch === state.epoch && !$('#app').hidden) {
      setWorkspaceLoading(false)
      document.querySelector('.workspace-content > section:not([hidden]) [tabindex="-1"]')?.focus({ preventScroll: true })
    }
  }
}
function showLogin(mode = state.authMode, reason = '', keepRoute = true) {
  if (mode === 'account' && state.redirecting) return
  snapshot.clear()
  state.listVersion++; state.readVersion++; state.epoch++
  state.draft = null; state.inbox = ''; state.inboxes = []; state.threads = []; state.session = null
  dashboard.reset(); setup.reset(); developers.reset(); settings.reset(); billing.reset(); notifications.reset(); nativeMail.reset(); resetTriageFilters()
  $('#native-mail').hidden = true
  $('#compose-form').reset(); $('#threads').replaceChildren(); $('#inboxes').replaceChildren(); emptyReader()
  $('#domain-list').replaceChildren(); $('#api-key').value = ''
  setMenu(false, false)
  $('#account-menu').open = false
  $('#account-name').textContent = 'Your workspace'; $('#account-avatar').textContent = 'B'
  $('#account-menu-name').textContent = 'Your workspace'; $('#account-menu-detail').textContent = ''
  $('#workspace-breadcrumb').textContent = 'Your workspace'; $('#workspace-breadcrumb').removeAttribute('title')
  $('#account').textContent = ''; $('#query').value = ''; $('#compose-from').textContent = ''
  shell.paintUsage(null); renderComposeFiles()
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
  setWorkspaceLoading(false)
  if (mode === 'account') {
    // Keep the requested page through sign-in so a pricing link to #/billing lands on the plans, not the inbox list.
    // An explicit sign-out drops it: the next person to sign in starts from the inbox list.
    const route = keepRoute && /^#\/[a-z][a-z0-9-]*(\/[^\s#]*)?$/.test(location.hash) && location.hash !== '#/inboxes' ? location.hash : ''
    if (!keepRoute) sessionStorage.removeItem('bezalel-return')
    state.redirecting = true; $('#app').hidden = true; location.replace(`${reason ? `/sign-in?reason=${encodeURIComponent(reason)}` : '/sign-in'}${route}`); return
  }
  $('#password-login').hidden = mode === 'access'
  $('#access-login').hidden = mode !== 'access'
  $('#login-form').elements.password.required = mode !== 'access'
  $('#app').hidden = true
  $('#login').hidden = false
}
const emptyReader = () => shell.paintReaderEmpty()
async function loadInboxes(preferred = state.inbox) {
  const epoch = state.epoch
  const inboxes = [], seen = new Set()
  let pageToken
  do {
    const page = await rpc('listInboxes', pageToken ? { pageToken } : {})
    if (epoch !== state.epoch) return
    inboxes.push(...page.inboxes)
    pageToken = page.nextPageToken
    if (pageToken && seen.has(pageToken)) throw new Error('The inbox list could not finish loading. Try again.')
    if (pageToken) seen.add(pageToken)
  } while (pageToken)
  if (epoch !== state.epoch) return
  state.inboxes = inboxes
  snapshot.update({ inboxes })
  dashboard.render()
  await selectInbox(inboxes.some((inbox) => inbox.inboxId === preferred) ? preferred : inboxes[0]?.inboxId ?? '')
}
async function selectInbox(inboxId) {
  if (state.inbox !== inboxId) resetTriageFilters()
  state.inbox = inboxId
  dashboard.syncSelection()
  // Update the guide immediately, even when message loading is slow or fails.
  await Promise.all([setup.sync(), dashboard.page === 'mail' ? loadThreads() : Promise.resolve()])
}
function resetTriageFilters() {
  state.triageFilters = {}
  for (const select of document.querySelectorAll('#triage-filters select')) select.value = ''
  $('#clear-triage').hidden = true
}
async function loadThreads(append = false) {
  updateAccount()
  $('#triage-filters').hidden = !state.inbox || state.folder === 'quarantined' || $('#toggle-triage').getAttribute('aria-expanded') !== 'true'
  $('#toggle-triage').hidden = !state.inbox || state.folder === 'quarantined'
  const version = ++state.listVersion
  const view = shell.threadView(state)
  // Reloading the view already on screen keeps that list until fresh results replace it.
  const keep = !append && $('#threads').dataset.view === view
  if (!append) {
    state.readVersion++; state.selected = ''; emptyReader()
    if (keep) for (const button of $('#threads').querySelectorAll('.thread.selected')) { button.classList.remove('selected'); button.setAttribute('aria-pressed', 'false') }
    else { state.threads = []; state.page = undefined; $('#thread-count').hidden = true; $('#load-more').hidden = true }
  } else $('#load-more').hidden = true
  if (!state.inbox) {
    $('#threads').replaceChildren(emptyState('Your first inbox', 'Create an address to start sending and receiving mail.', 'Create inbox', () => $('#new-inbox').click()))
    $('#threads').dataset.view = view
    return
  }
  if (!append && !keep) $('#threads').replaceChildren(emptyState('Loading mail', 'Your conversations will appear here.'))
  try {
    const result = await rpc(state.query ? 'searchMessages' : 'listThreads', {
      ...state.triageFilters, inboxId: state.inbox, limit: 30, ...(append && state.page ? { pageToken: state.page } : {}),
      ...(state.query ? { query: state.query } : { ...(state.folder === 'all' ? {} : { labels: [state.folder === 'inbox' ? 'received' : state.folder] }), includeTrash: state.folder === 'trash' }),
    })
    if (version !== state.listVersion) return
    const items = (result.threads ?? result.messages ?? []).map((item) => ({ ...item, senders: item.senders ?? [item.from] }))
    state.threads = append ? [...state.threads, ...items] : items
    state.page = result.nextPageToken
    renderThreads()
  } catch (error) {
    if (version === state.listVersion) {
      // The kept list is gone now, so nothing may page or count it.
      if (!append) { state.threads = []; state.page = undefined; $('#thread-count').hidden = true; $('#load-more').hidden = true }
      $('#threads').replaceChildren(emptyState('Could not load mail', error.message, 'Try again', () => loadThreads()))
      $('#threads').dataset.view = view
    }
    throw error
  }
}
function renderThreads() {
  const filtered = Object.keys(state.triageFilters).length > 0
  shell.paintThreads({ threads: state.threads, selected: state.selected, view: shell.threadView(state), folder: state.folder, query: state.query, filtered, more: Boolean(state.page) })
  for (const button of $('#threads').querySelectorAll('.thread')) action(button, () => readThread(button.dataset.threadId))
  if (state.folder === 'inbox' && !state.query && !filtered) rememberThreads()
}
// Keep the default inbox view of the five most recently opened inboxes for the next load.
function rememberThreads() {
  const saved = snapshot.read()?.threads ?? {}
  delete saved[state.inbox]
  snapshot.update({ threads: Object.fromEntries([...Object.entries(saved).slice(-4), [state.inbox, { items: state.threads.slice(0, 30), more: Boolean(state.page) }]]) })
}
async function readThread(threadId) {
  const version = ++state.readVersion
  const inboxId = state.inbox
  state.selected = threadId
  $('.mail-workspace').classList.add('reading')
  renderThreads()
  $('#conversation').replaceChildren(emptyState('Opening conversation', 'Getting your messages ready.'))
  let thread
  try {
    thread = await rpc(state.folder === 'quarantined' ? 'reviewThread' : 'getThread', { inboxId, threadId, includeBodies: true })
  } catch (error) {
    if (version === state.readVersion) $('#conversation').replaceChildren(emptyState('Could not open conversation', error.message, 'Back to conversations', () => loadThreads()))
    throw error
  }
  if (version !== state.readVersion) return
  const container = $('#conversation')
  container.replaceChildren()
  const header = node('header', undefined, 'reader-header')
  const heading = node('div', undefined, 'reader-heading')
  const back = node('button', undefined, 'icon-button reader-back')
  back.setAttribute('aria-label', 'Back to conversations'); back.append(icon('arrow-left'))
  action(back, () => { emptyReader(); $('#threads .selected')?.focus() })
  const controls = node('div', undefined, 'reader-tools')
  for (const [label, changes] of [['Archive', { removeLabels: ['received'] }], ['Move to trash', { addLabels: ['trash'] }], ['Move to inbox', { addLabels: ['received'], removeLabels: ['trash'] }]]) {
    const button = node('button', label)
    button.prepend(icon(label === 'Archive' ? 'archive' : label === 'Move to trash' ? 'trash' : 'inbox'))
    action(button, async () => {
      await rpc('updateThreadLabels', { inboxId, threadId, ...changes })
      notify('Conversation updated')
      if (state.inbox === inboxId) await loadThreads()
    })
    controls.append(button)
  }
  heading.append(back, node('h2', thread.subject || '(No subject)'), controls)
  const held = thread.messages.some((message) => message.protection?.status === 'quarantined')
  const people = [...new Set(thread.messages.filter((message) => !message.labels?.includes('sent')).map((message) => parseAddress(message.from).address || message.from))]
  const meta = node('div', undefined, 'reader-meta')
  if (held) meta.append(node('span', 'Quarantined', 'triage-badge triage-held'))
  if (thread.triage) meta.append(triageBadges(thread.triage))
  meta.append(node('span', `${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}${people.length ? ` · ${held ? 'from' : 'with'} ${people.join(', ')}` : ''}`, 'eyebrow'))
  header.append(heading, meta)
  container.append(header)
  for (const message of thread.messages) {
    const sent = message.labels?.includes('sent') && !message.labels?.includes('received')
    const article = node('article', undefined, `message${sent ? ' message-sent' : ''}`)
    const from = parseAddress(message.from)
    const mark = sent ? node('span', undefined, 'avatar avatar-agent') : avatar(from.name || message.from)
    if (sent) { mark.setAttribute('aria-hidden', 'true'); mark.append(icon('bubble')) }
    const body = node('div', undefined, 'message-content')
    const head = node('div', undefined, 'message-head'), sender = node('div', undefined, 'message-sender')
    sender.append(node('strong', from.name || message.from))
    if (from.address) sender.append(node('span', from.address, 'message-address'))
    head.append(sender, node('time', new Date(message.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })))
    body.append(head)
    // Recipients show unless the mail went to this inbox alone.
    const onlyThisInbox = message.to.length === 1 && message.to[0] === inboxId && !message.cc?.length && !message.bcc?.length
    if (!onlyThisInbox) body.append(node('p', [['To', message.to], ['Cc', message.cc], ['Bcc', message.bcc]].filter(([, list]) => list?.length).map(([role, list]) => `${role}: ${list.join(', ')}`).join(' · '), 'message-recipients'))
    const quarantined = message.protection?.status === 'quarantined'
    if (quarantined) {
      const banner = node('div', undefined, 'quarantine-banner'), copy = node('div', undefined, 'quarantine-copy')
      const reasons = heldReasons(message.protection.reasons)
      const canRelease = message.protection.antivirus?.status === 'clean'
      copy.append(node('strong', 'Held before it reached your agent'),
        node('p', `${reasons ? `This message ${reasons}. ` : ''}No API key can release it.${canRelease ? ' Release it only if you trust the sender.' : ''}`))
      banner.append(icon('shield'), copy)
      if (canRelease) {
        const release = node('button', 'Release message', 'primary')
        action(release, async () => {
          await rpc('releaseQuarantine', { inboxId, messageId: message.messageId })
          notify('Message released')
          if (state.inbox === inboxId) { await loadThreads(); await readThread(threadId) }
        })
        banner.append(release)
      }
      body.append(banner, protectionChecks(message.protection))
      const label = node('div', undefined, 'message-text-label')
      label.append(node('span', 'Message text'), node('span', 'Links are shown as plain text'))
      body.append(label, node('div', message.text ?? 'Message body is held for owner review.', 'message-text message-text-held'))
    } else body.append(node('div', message.text ?? 'Message body is held for owner review.', 'message-text'))
    if (message.attachments?.length && !quarantined) {
      const attachments = node('div', undefined, 'attachments')
      for (const attachment of message.attachments) {
        const size = `${Math.ceil(attachment.size / 1024)} KB`
        const button = node('button', undefined, 'file-chip')
        button.append(icon('file'), node('span', attachment.filename), node('span', size, 'file-size'))
        button.setAttribute('aria-label', `Download ${attachment.filename}, ${size}`)
        action(button, async () => {
          const result = await rpc('getAttachment', { inboxId, messageId: message.messageId, attachmentId: attachment.attachmentId })
          const url = new URL(result.downloadUrl)
          if (url.protocol !== 'https:') throw new Error('Invalid attachment URL')
          const link = node('a')
          link.href = url.href; link.rel = 'noreferrer noopener'; link.target = '_blank'; link.click()
        })
        attachments.append(button)
      }
      body.append(attachments)
    }
    if (message.delivery?.recipients?.length) body.append(deliverySummary(message.delivery))
    if (message.triage) body.append(triageDetails(message.triage))
    if (message.protection && !quarantined) {
      const details = node('details', undefined, 'message-details')
      details.append(node('summary', 'Protection checks'), protectionChecks(message.protection))
      body.append(details)
    }
    article.append(mark, body)
    container.append(article)
  }
  const replyTarget = thread.messages.findLast((message) => message.labels?.includes('received')) ?? thread.messages.at(-1)
  if (replyTarget && replyTarget.protection?.status !== 'quarantined') {
    const counterpart = parseAddress(replyTarget.labels?.includes('received') ? replyTarget.from : replyTarget.to?.[0] ?? replyTarget.from)
    const name = !counterpart.name || counterpart.name.includes('@') ? counterpart.address || counterpart.name : counterpart.name.split(' ')[0]
    const reply = node('button', undefined, 'reply-button'), footer = node('span', undefined, 'reply-footer'), hint = node('span', undefined, 'reply-hint')
    reply.setAttribute('aria-label', 'Reply')
    hint.append(icon('paperclip'), node('span', 'Up to 10 files, 2 MiB total'))
    footer.append(hint, node('span', 'Reply', 'reply-send'))
    reply.append(node('span', `Reply to ${name} as ${inboxId}`, 'reply-prompt'), footer)
    action(reply, () => openCompose({ inboxId, message: replyTarget }))
    const dock = node('div', undefined, 'reply-dock')
    dock.append(reply)
    container.append(dock)
  }
  if (compactViewport.matches) $('.reader').focus()
  if (thread.labels.includes('unread')) {
    const selected = state.threads.find((item) => item.threadId === threadId)
    if (selected?.labels) selected.labels = selected.labels.filter((label) => label !== 'unread')
    renderThreads()
    void rpc('updateThreadLabels', { inboxId, threadId, removeLabels: ['unread'] }).catch((error) => notify(error.message))
  }
}
function openCompose(reply) {
  const form = $('#compose-form')
  if (state.draft?.sending) return
  if (reply && state.draft && (form.elements.text.value || state.draft.payload) && !confirm('Discard the open draft? A send without a confirmed receipt may already have been accepted.')) return
  if (reply || !state.draft) {
    state.draft = { inboxId: reply?.inboxId ?? state.inbox, message: reply?.message, id: crypto.randomUUID() }
    form.reset()
    for (const field of form.querySelectorAll('input, textarea')) field.disabled = false
    $('#compose-error').textContent = ''
    form.querySelector('[type=submit]').textContent = 'Send'
    $('#compose-title').textContent = reply ? 'Reply' : 'New message'
    $('#compose-from').textContent = `Sent from ${state.draft.inboxId}`
    $('#to-label').hidden = Boolean(reply)
    $('#subject-label').hidden = Boolean(reply)
    form.elements.to.required = !reply
  }
  $('#compose-dialog').showModal()
}
$('#compose-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget, button = form.querySelector('[type=submit]'), draft = state.draft
  if (!draft || draft.sending) return
  draft.sending = true
  button.disabled = true
  for (const control of form.querySelectorAll('button[type=button]')) control.disabled = true
  $('#compose-error').textContent = ''
  try {
    if (!draft.payload) {
      const files = [...form.elements.attachments.files]
      if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) throw new Error('Choose up to 10 files, with a combined size of 2 MiB or less.')
      const attachments = await Promise.all(files.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let text = ''
        for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192))
        return { filename: file.name, contentType: file.type || 'application/octet-stream', content: btoa(text) }
      }))
      draft.payload = {
        inboxId: draft.inboxId, idempotencyKey: draft.id, text: form.elements.text.value,
        ...(attachments.length ? { attachments } : {}),
        ...(draft.message ? { messageId: draft.message.messageId } : { to: form.elements.to.value.split(',').map((address) => address.trim()).filter(Boolean), subject: form.elements.subject.value }),
      }
    }
    // Keep the exact request available after an uncertain send.
    for (const field of form.querySelectorAll('input, textarea')) field.disabled = true
    await rpc(draft.message ? 'reply' : 'send', draft.payload)
    $('#compose-dialog').close()
    state.draft = null
    notify('Message accepted for sending')
    if (!$('#billing').hidden) void loadUsage()
    await loadThreads()
  } catch (error) {
    $('#compose-error').textContent = error.message
    if (draft.payload) button.textContent = 'Retry same request'
  } finally {
    draft.sending = false; button.disabled = false
    for (const control of form.querySelectorAll('button[type=button]')) control.disabled = false
  }
})
$('#compose-dialog').addEventListener('cancel', (event) => { if (state.draft?.sending) event.preventDefault() })
async function loadDomains() {
  const result = await rpc('listDomains')
  snapshot.update({ domains: result })
  shell.paintDomains(result)
  wireDomains()
}
// Attaches handlers to whatever the shell painted, including the saved cards on load.
function wireDomains() {
  for (const button of $('#domain-list').querySelectorAll('[data-action]')) {
    const { domainId } = button.closest('[data-domain-id]').dataset
    action(button, async () => {
      if (button.dataset.action === 'remove' && !confirm(`Remove ${domainId}? Active inboxes must be removed first.`)) return
      await rpc(button.dataset.action === 'remove' ? 'deleteDomain' : 'verifyDomain', { domainId })
      await loadDomains()
    })
  }
}
wireDomains()
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close())
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => {
  if (mobileViewport.matches && (document.activeElement === document.body || $('#sidebar').contains(document.activeElement))) $('#open-menu').focus()
})
action($('#compose'), () => openCompose())
action($('#sidebar-compose'), () => openCompose())
$('#sidebar-new-inbox').addEventListener('click', () => $('#new-inbox').click())
// Copy buttons name their source with data-copy (a selector) or carry the text in data-copy-value.
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-copy], [data-copy-value]')
  if (!button || button.disabled) return
  const value = button.dataset.copyValue ?? document.querySelector(button.dataset.copy)?.textContent ?? ''
  if (value) navigator.clipboard.writeText(value).then(() => notify('Copied'), () => notify('Could not copy. Select the text to copy it manually.'))
})
// Chosen attachments show as chips; the file input itself stays the source of truth.
function renderComposeFiles() {
  const files = [...($('#compose-form').elements.attachments.files ?? [])]
  $('#compose-files').replaceChildren(...files.map((file) => {
    const chip = node('li', undefined, 'file-chip')
    chip.append(icon('file'), node('span', file.name), node('span', `${Math.ceil(file.size / 1024)} KB`, 'file-size'))
    return chip
  }))
  $('#compose-files').hidden = !files.length
}
$('#compose-form').elements.attachments.addEventListener('change', renderComposeFiles)
$('#compose-form').addEventListener('reset', () => setTimeout(renderComposeFiles))
$('#toggle-triage').addEventListener('click', () => {
  const open = $('#toggle-triage').getAttribute('aria-expanded') !== 'true'
  $('#toggle-triage').setAttribute('aria-expanded', String(open)); $('#triage-filters').hidden = !open
})
action($('#discard-draft'), () => {
  if (state.draft?.payload && !confirm('Discard this request? A send without a confirmed receipt may already have been accepted.')) return
  state.draft = null; $('#compose-form').reset(); $('#compose-dialog').close()
})
for (const [id, field] of [['triage-category', 'category'], ['triage-needs-reply', 'needsReply'], ['triage-urgency', 'urgency']]) {
  document.getElementById(id).addEventListener('change', () => {
    const value = document.getElementById(id).value
    if (value) state.triageFilters[field] = value
    else delete state.triageFilters[field]
    $('#clear-triage').hidden = !Object.keys(state.triageFilters).length
    void loadThreads().catch(error => notify(error.message))
  })
}
action($('#clear-triage'), async () => { resetTriageFilters(); await loadThreads() })
action($('#refresh'), () => loadThreads())
action($('#load-more'), () => loadThreads(true))
action($('#finish-inbox'), async () => {
  await rpc('finishInboxSetup', { inboxId: state.inbox })
  await loadInboxes(); notify('Inbox delivery is ready')
})
action($('#new-inbox'), () => {
  const domain = $('#inbox-form').elements.domain
  domain.readOnly = ['access', 'account'].includes(state.authMode)
  if (domain.readOnly) domain.value = state.session.defaultDomain
  $('#inbox-error').textContent = ''; $('#inbox-dialog').showModal() })
action($('#new-domain'), () => { $('#domain-error').textContent = ''; $('#domains-dialog').showModal() })
$('#account-settings').addEventListener('click', () => { $('#account-menu').open = false })
action($('#logout'), async () => {
  const { logoutUrl } = await request('/api/logout', {})
  if (state.authMode === 'account') accountEvents.postMessage('signed-out')
  showLogin(state.authMode, '', false)
  if (logoutUrl === '/cdn-cgi/access/logout') location.assign(logoutUrl)
})
$('#inboxes').addEventListener('change', () => {
  dashboard.openInbox($('#inboxes').value)
})
for (const button of document.querySelectorAll('[data-folder]')) action(button, async () => {
  setup.close()
  resetTriageFilters()
  state.folder = button.dataset.folder; state.query = ''; $('#query').value = ''
  $('#folder-title').textContent = folderNames[state.folder]
  for (const other of document.querySelectorAll('[data-folder]')) other.removeAttribute('aria-current')
  button.setAttribute('aria-current', 'page')
  await loadThreads()
})
$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault(); state.query = $('#query').value.trim()
  $('#folder-title').textContent = state.query ? 'Search results' : folderNames[state.folder]
  void loadThreads().catch((error) => notify(error.message))
})
for (const [formId, errorId, operation, after] of [
  ['inbox-form', 'inbox-error', 'createInbox', async result => { $('#inbox-dialog').close(); $('#inbox-form').reset(); dashboard.openInbox(result.inboxId); notify('Inbox created') }],
  ['domain-form', 'domain-error', 'createDomain', async () => { $('#domains-dialog').close(); $('#domain-form').reset(); await loadDomains() }],
]) $(`#${formId}`).addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget, button = form.querySelector('[type=submit]')
  button.disabled = true; $(`#${errorId}`).textContent = ''
  try {
    const input = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]).filter(([, value]) => value))
    await after(await (operation === 'createInbox' ? createInbox(input) : rpc(operation, input)))
  } catch (error) {
    $(`#${errorId}`).textContent = error.message
  } finally { button.disabled = false }
})
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget, button = form.querySelector('button')
  button.disabled = true; $('#login-error').textContent = ''
  try {
    await request('/api/login', { password: form.elements.password.value })
    form.reset()
    await startWorkspace()
  } catch (error) { $('#login-error').textContent = error.message; notify(error.message) } finally { button.disabled = false }
})
void request('/api/session').then(async (session) => {
  if (!session.authenticated) return showLogin()
  state.session = session
  // A saved workspace from another account must not survive into this one.
  if (snapshot.read()?.session?.customer?.id !== session.customer?.id) snapshot.clear()
  rememberSession()
  shell.paintNavigation(session)
  updateAccount()
  await startWorkspace()
}).catch((error) => { notify(error.message); if (!state.session) showLogin(); else setWorkspaceLoading(false) })

let credentialsInbox = ''
async function loadCredentials(operation) {
  const result = await rpc(operation, { inboxId: credentialsInbox })
  if ($('#credentials-dialog').open && credentialsInbox === result.inboxId) $('#api-key').value = result.apiKey
}
action($('#credentials'), async () => {
  if (!state.inbox) return notify('Create or choose an inbox first.')
  credentialsInbox = state.inbox
  $('#api-key').value = ''; $('#credentials-inbox').textContent = credentialsInbox
  $('#connection-guide').hidden = !state.session?.apiUrl
  $('#connection-command').textContent = state.session?.apiUrl ? connectionCommand(state.session.apiUrl) : ''
  $('#connection-status').textContent = 'Run the command, then check the connection.'
  $('#credentials-dialog').showModal()
  await loadCredentials('getCredentials')
})
$('#credentials-dialog').addEventListener('close', () => { $('#api-key').value = ''; credentialsInbox = ''; $('#connection-command').textContent = ''; $('#connection-status').textContent = '' })
action($('#copy-command'), async () => {
  await navigator.clipboard.writeText($('#connection-command').textContent); notify('Command copied')
})
action($('#check-connection'), async () => {
  const inboxId = credentialsInbox
  const status = await rpc('setupStatus', { inboxId })
  if (!$('#credentials-dialog').open || inboxId !== credentialsInbox) return
  $('#connection-status').textContent = status.connectedAt ? 'Connected. This API key can access your inbox.' : 'No connection yet. Run the command with the current API key, then check again.'
  await setup.refresh()
})
action($('#copy-key'), async () => { if ($('#api-key').value) { await navigator.clipboard.writeText($('#api-key').value); notify('Key copied') } })
action($('#rotate-key'), async () => {
  if (!confirm('Replace this mailbox key? Agents using the old key will lose access.')) return
  await loadCredentials('rotateCredentials')
  $('#connection-status').textContent = 'Key replaced. Update your agent and run the command again.'
  await setup.refresh(); notify('Mailbox key replaced')
})
