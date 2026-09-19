import { createDesktopNotifications } from "/notifications.js"
import { triageBadges, triageDetails } from "./triage.js"
import { createDeveloperPanel } from "./developer.js"
import { createInboxSetup, connectionCommand } from './setup.js'
import { createDashboardConsole } from './console.js'
import { createSettingsPanel } from './settings.js'
import { createNativeMailPanel } from './native-mail.js'
const $ = (selector) => document.querySelector(selector)
const accountEvents = new BroadcastChannel('bezalel-account')
accountEvents.addEventListener('message', (event) => { if (event.data === 'signed-out' && state.authMode === 'account') showLogin() })
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
const state = { session: null, epoch: 0, inboxes: [], inbox: '', folder: 'inbox', query: '', triageFilters: {}, page: undefined, threads: [], selected: '', listVersion: 0, readVersion: 0, draft: null }
const folderNames = { inbox: 'Inbox', sent: 'Sent', all: 'All mail', quarantined: 'Quarantine', trash: 'Trash' }
let noticeTimer
const node = (tag, text, className) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}
const iconPaths = {
  brand: '<path d="M14 2C7.4 2 2 6.7 2 12.5c0 3.2 1.6 6 4.2 7.9L5 26l6.1-3.1c.9.2 1.9.3 2.9.3 6.6 0 12-4.7 12-10.5S20.6 2 14 2z" fill="currentColor" stroke="none"/><g fill="white" stroke="none"><circle cx="9.5" cy="12.5" r="1.8"/><circle cx="14" cy="12.5" r="1.8"/><circle cx="18.5" cy="12.5" r="1.8"/></g>',
  inbox: '<path d="M2 9l2-6h8l2 6v4H2zM2 9h3l1 2h4l1-2h3"/>',
  send: '<path d="M14 2L7 9M14 2l-4 12-3-5-5-3z"/>',
  stack: '<rect x="3" y="2" width="10" height="10" rx="2"/><path d="M1 6v8h9M6 5h4M6 8h3"/>',
  shield: '<path d="M8 1.5l5.5 2v4c0 3-3 5.5-5.5 7-2.5-1.5-5.5-4-5.5-7v-4zM8 5v3M8 10.5h.01"/>',
  trash: '<path d="M2 4h12M6 4V2h4v2M4 4l.7 10h6.6L12 4M6.5 7v4M9.5 7v4"/>',
  key: '<circle cx="5" cy="6" r="3.5"/><path d="M8 8l5.5 5.5M11 11l2-2M12.5 12.5l2-2"/>',
  settings: '<path d="M6 2l.5-1h3l.5 1 1.5 1 1.2-.1 1.5 2.6-.7 1.1v1.8l.7 1.1-1.5 2.6-1.2-.1-1.5 1-.5 1h-3l-.5-1-1.5-1-1.2.1-1.5-2.6.7-1.1V6.6l-.7-1.1 1.5-2.6 1.2.1z"/><circle cx="8" cy="7.5" r="2"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  globe: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.5" ry="6"/><path d="M2 8h12"/>',
  logout: '<path d="M6 2H2v12h4M6 8h8M11 5l3 3-3 3"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  refresh: '<path d="M13.5 6a5.5 5.5 0 00-9.7-2L2 6M2 2v4h4M2.5 10a5.5 5.5 0 009.7 2l1.8-2M14 14v-4h-4"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  menu: '<path d="M2 4h12M2 8h12M2 12h12"/>',
  'chevron-updown': '<path d="M5 6l3-3 3 3M5 10l3 3 3-3"/>',
  more: '<circle cx="3" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="13" cy="8" r=".8"/>',
  copy: '<rect x="5" y="5" width="9" height="9" rx="2"/><path d="M10 2H4a2 2 0 00-2 2v6"/>',
  code: '<path d="M5 4L1 8l4 4M11 4l4 4-4 4M9 2L7 14"/>',
  terminal: '<rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4 5l3 3-3 3M9 11h3"/>',
  filter: '<path d="M2 4h12M4 8h8M6 12h4"/>',
  'arrow-right': '<path d="M2 8h12M9 3l5 5-5 5"/>',
  'arrow-left': '<path d="M14 8H2M7 3L2 8l5 5"/>',
  paperclip: '<path d="M6 9.5l4.5-4.5a2 2 0 012.8 2.8L7 14a3.5 3.5 0 01-5-5l6.5-6.5a2 2 0 012.8 2.8L5 11"/>',
  archive: '<rect x="2" y="2" width="12" height="3" rx="1"/><path d="M3 5v9h10V5M6 8h4"/>',
  reply: '<path d="M6 3L1 7l5 4M1 7h7a6 6 0 016 6"/>',
  mail: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 4l6 5 6-5"/>',
  alert: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5v4M8 11.5h.01"/>',
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({ viewBox: name === 'brand' ? '0 0 28 28' : '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(key, value)
  // Only static icon markup enters this SVG; mail content always uses textContent.
  svg.innerHTML = iconPaths[name] ?? iconPaths.mail
  return svg
}
for (const element of document.querySelectorAll('[data-icon]')) element.append(icon(element.dataset.icon))
const initials = (value) => value.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'B'
const avatar = (value) => { const element = node('span', initials(value), 'avatar'); element.setAttribute('aria-hidden', 'true'); return element }
function emptyState(title, description, buttonText, onClick) {
  const wrap = node('div', undefined, 'empty-wrap'), empty = node('div', undefined, 'empty')
  empty.append(icon('mail'), node('h2', title), node('p', description))
  if (buttonText) { const button = node('button', buttonText, 'primary'); action(button, onClick); empty.append(button) }
  wrap.append(empty)
  return wrap
}
function statusBadge(status) {
  const badge = node('span', status, 'badge')
  badge.dataset.status = String(status).toLowerCase()
  return badge
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
  const customer = state.session?.customer
  const organization = customer?.organizationName || 'Your workspace'
  $('#workspace-name').textContent = organization; $('#workspace-name').title = organization
  $('#workspace-avatar').textContent = initials(organization)
  $('#workspace-breadcrumb').textContent = organization; $('#workspace-breadcrumb').title = organization
  const inbox = state.inboxes.find((item) => item.inboxId === state.inbox)
  const name = customer ? (customer.displayName || customer.email) : (inbox?.displayName || 'Your workspace')
  $('#account-name').textContent = name
  $('#account-name').title = name
  $('#account-avatar').textContent = initials(name)
  $('#account').textContent = customer ? `${customer.email} · ${customer.role === 'admin' ? 'Owner' : customer.inboxLimit === null ? 'No inbox limit' : `${customer.inboxLimit} inboxes`}` : 'Owner'
  $('#account').title = $('#account').textContent
  $('#account-menu-name').textContent = name
  $('#account-menu-detail').textContent = $('#account').textContent
  $('#mailbox-address').textContent = state.inbox || 'Choose a mailbox to get started'
  $('#mailbox-address').title = state.inbox
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
    if ([401, 403].includes(response.status) && path !== '/api/login') {
      showLogin(state.authMode, response.status === 403 ? 'access_denied' : '')
      $('#login-error').textContent = body.error ?? 'Sign in to continue'
    }
    throw Object.assign(new Error(body.error ?? 'Email request failed'), { status: response.status })
  }
  return body
}
const rpc = async (operation, value = {}) => (await request(`/api/rpc/${operation}`, value)).result
const nativeMail = createNativeMailPanel({ rpc: async (operation, value) => (await request(`/api/native-rpc/${operation}`, value)).result })
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
const developers = createDeveloperPanel({ rpc, notify, getSession: () => state.session })
const notifications = createDesktopNotifications({ rpc, async openInbox(inboxId) {
  const epoch = state.epoch
  try {
    if (!state.inboxes.some(inbox => inbox.inboxId === inboxId)) await loadInboxes()
    if (epoch === state.epoch) dashboard.openInbox(inboxId)
  } catch (error) { if (epoch === state.epoch) notify(error.message) }
} })
const settings = createSettingsPanel({ rpc, getAuthMode: () => state.authMode, onChange(customer) {
  if (state.session?.customer?.id !== customer.id) return
  state.session.customer = customer
  updateAccount()
} })
const dashboard = createDashboardConsole({ state, icon, rpc, notify, selectInbox, loadInboxes,
  closeSetup: () => setup.close(), openSetup: () => setup.open(), closeNavigation: () => setMenu(false, false),
  loadPage: async page => {
    if (page === 'api-keys') await developers.load()
    if (page === 'domains') { $('#domains-error').textContent = ''; await loadDomains() }
    if (page === 'settings') await settings.load()
    if (page === 'native-mail') await nativeMail.load()
  },
})
function setWorkspaceLoading(loading) {
  $('#app').inert = loading
  $('#app').setAttribute('aria-busy', String(loading))
  $('#workspace-loading').hidden = !loading
  if (!loading) {
    delete document.documentElement.dataset.initialPage
    document.documentElement.style.removeProperty('--initial-page-title')
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
  } finally {
    if (epoch === state.epoch && !$('#app').hidden) {
      setWorkspaceLoading(false)
      document.querySelector('.workspace-content > section:not([hidden]) [tabindex="-1"]')?.focus({ preventScroll: true })
    }
  }
}
function showLogin(mode = state.authMode, reason = '') {
  if (mode === 'account' && state.redirecting) return
  state.listVersion++; state.readVersion++; state.epoch++
  state.draft = null; state.inbox = ''; state.inboxes = []; state.threads = []; state.session = null
  dashboard.reset(); setup.reset(); developers.reset(); settings.reset(); notifications.reset(); nativeMail.reset(); resetTriageFilters()
  $('#native-mail').hidden = true
  $('#compose-form').reset(); $('#threads').replaceChildren(); $('#inboxes').replaceChildren(); emptyReader()
  $('#domain-list').replaceChildren(); $('#api-key').value = ''
  setMenu(false, false)
  $('#account-menu').open = false
  $('#account-name').textContent = 'Your workspace'; $('#account-avatar').textContent = 'B'
  $('#account-menu-name').textContent = 'Your workspace'; $('#account-menu-detail').textContent = ''
  $('#workspace-name').textContent = 'Your workspace'; $('#workspace-name').removeAttribute('title'); $('#workspace-avatar').textContent = 'B'
  $('#workspace-breadcrumb').textContent = 'Your workspace'; $('#workspace-breadcrumb').removeAttribute('title')
  $('#account').textContent = ''; $('#query').value = ''; $('#compose-from').textContent = ''
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
  setWorkspaceLoading(false)
  if (mode === 'account') { state.redirecting = true; $('#app').hidden = true; location.replace(reason ? `/sign-in?reason=${encodeURIComponent(reason)}` : '/sign-in'); return }
  $('#password-login').hidden = mode === 'access'
  $('#access-login').hidden = mode !== 'access'
  $('#login-form').elements.password.required = mode !== 'access'
  $('#app').hidden = true
  $('#login').hidden = false
}
function emptyReader() {
  $('.mail-workspace').classList.remove('reading')
  $('#conversation').replaceChildren(emptyState('A little room to focus.', 'Select a conversation to read your mail.'))
}
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
  dashboard.render()
  $('#inboxes').replaceChildren(...inboxes.map((inbox) => {
    const option = node('option', `${inbox.group ? `[${inbox.group}] ` : ''}${inbox.inboxId}${inbox.deliveryStatus === 'pending' ? ' (setup pending)' : ''}`)
    option.value = inbox.inboxId
    return option
  }))
  await selectInbox(inboxes.some((inbox) => inbox.inboxId === preferred) ? preferred : inboxes[0]?.inboxId ?? '')
}
async function selectInbox(inboxId) {
  if (state.inbox !== inboxId) resetTriageFilters()
  state.inbox = inboxId
  $('#inboxes').value = state.inbox
  $('#inboxes').title = state.inbox
  $('#compose').disabled = !state.inbox
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
  $('#thread-count').hidden = true
  $('#finish-inbox').hidden = !state.inboxes.some((i) => i.inboxId === state.inbox && i.deliveryStatus === 'pending')
  const version = ++state.listVersion
  if (!append) { state.readVersion++; state.selected = ''; state.threads = []; state.page = undefined; emptyReader() }
  $('#load-more').hidden = true
  if (!state.inbox) {
    $('#threads').replaceChildren(emptyState('Your first inbox', 'Create an address to start sending and receiving mail.', 'Create inbox', () => $('#new-inbox').click()))
    return
  }
  if (!append) $('#threads').replaceChildren(emptyState('Loading mail', 'Your conversations will appear here.'))
  try {
    const result = await rpc(state.query ? 'searchMessages' : 'listThreads', {
      ...state.triageFilters, inboxId: state.inbox, limit: 30, ...(append && state.page ? { pageToken: state.page } : {}),
      ...(state.query ? { query: state.query } : { ...(state.folder === 'all' ? {} : { labels: [state.folder === 'inbox' ? 'received' : state.folder] }), includeTrash: state.folder === 'trash' }),
    })
    if (version !== state.listVersion) return
    state.threads.push(...(result.threads ?? result.messages ?? []).map((item) => ({ ...item, senders: item.senders ?? [item.from] })))
    state.page = result.nextPageToken
    renderThreads()
    $('#load-more').hidden = !state.page
  } catch (error) {
    if (version === state.listVersion) $('#threads').replaceChildren(emptyState('Could not load mail', error.message, 'Try again', () => loadThreads()))
    throw error
  }
}
function renderThreads() {
  const seen = new Set()
  const buttons = state.threads.filter((thread) => {
    if (seen.has(thread.threadId)) return false
    seen.add(thread.threadId); return true
  }).map((thread) => {
    const unread = thread.labels?.includes('unread')
    const button = node('button', undefined, `thread${state.selected === thread.threadId ? ' selected' : ''}${unread ? ' unread' : ''}`)
    button.setAttribute('aria-pressed', String(state.selected === thread.threadId))
    const copy = node('div', undefined, 'thread-copy'), meta = node('div', undefined, 'thread-meta')
    const time = node('span', new Date(thread.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), 'time')
    if (unread) { const dot = node('span', undefined, 'unread-dot'); dot.setAttribute('aria-label', 'Unread'); time.prepend(dot) }
    meta.append(node('span', thread.senders.join(', '), 'sender'), time)
    copy.append(meta, node('div', thread.subject || '(No subject)', 'subject'), node('div', thread.preview || (state.folder === 'quarantined' ? 'Held for your review' : 'No preview'), 'preview'))
    copy.append(triageBadges(thread.triage))
    button.append(avatar(thread.senders[0] || 'Mail'), copy)
    action(button, () => readThread(thread.threadId))
    return button
  })
  $('#thread-count').textContent = `${buttons.length}${state.page ? '+' : ''}`
  $('#thread-count').hidden = !buttons.length
  $('#threads').replaceChildren(...(buttons.length ? buttons : [emptyState(state.query || Object.keys(state.triageFilters).length ? 'No matching messages' : 'No conversations yet', Object.keys(state.triageFilters).length ? 'Try different triage filters or clear them to see all conversations.' : state.query ? 'Try a different search in this mailbox.' : 'Messages in this folder will appear here.')]))
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
  heading.append(back, node('span', `${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}`, 'eyebrow'))
  header.append(heading, node('h2', thread.subject || '(No subject)'))
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
  header.append(controls)
  container.append(header)
  for (const message of thread.messages) {
    const article = node('article', undefined, 'message')
    const head = node('div', undefined, 'message-head'), sender = node('div', undefined, 'message-sender')
    sender.append(node('strong', message.from), node('p', `To: ${message.to.join(', ')}${message.cc?.length ? ` · Cc: ${message.cc.join(', ')}` : ''}`))
    head.append(avatar(message.from), sender, node('time', new Date(message.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })))
    article.append(head)
    if (message.triage) article.append(triageBadges(message.triage), triageDetails(message.triage))
    if (message.protection?.status === 'quarantined') {
      article.append(node('p', 'This message is quarantined. Review its checks before releasing it.', 'warning'))
      if (message.protection.antivirus?.status === 'clean') {
        const release = node('button', 'Release message')
        action(release, async () => {
          await rpc('releaseQuarantine', { inboxId, messageId: message.messageId })
          notify('Message released')
          if (state.inbox === inboxId) { await loadThreads(); await readThread(threadId) }
        })
        article.append(release)
      }
    }
    article.append(node('div', message.text ?? 'Message body is held for owner review.', 'message-text'))
    if (message.attachments?.length && message.protection?.status !== 'quarantined') {
      const attachments = node('div', undefined, 'attachments')
      for (const attachment of message.attachments) {
        const button = node('button', `↓ ${attachment.filename} · ${Math.ceil(attachment.size / 1024)} KB`)
        action(button, async () => {
          const result = await rpc('getAttachment', { inboxId, messageId: message.messageId, attachmentId: attachment.attachmentId })
          const url = new URL(result.downloadUrl)
          if (url.protocol !== 'https:') throw new Error('Invalid attachment URL')
          const link = node('a')
          link.href = url.href; link.rel = 'noreferrer noopener'; link.target = '_blank'; link.click()
        })
        attachments.append(button)
      }
      article.append(attachments)
    }
    for (const [label, value] of [['Delivery details', message.delivery], ['Protection checks', message.protection]]) {
      if (!value) continue
      const details = node('details', undefined, 'message-details')
      const lines = label === 'Delivery details'
        ? value.recipients.map((recipient) => `${recipient.recipient}: ${recipient.status}${recipient.reason ? ` · ${recipient.reason}` : ''}`)
        : [`Attachment scan: ${value.antivirus.status}`, `SPF: ${value.authentication.spf} · DKIM: ${value.authentication.dkim} · DMARC: ${value.authentication.dmarc}`, `Spam score: ${value.spam.score} / ${value.spam.threshold}`, ...value.reasons.map((reason) => reason.replaceAll('_', ' ')), ...(value.releasedAt ? [`Released: ${new Date(value.releasedAt).toLocaleString()}`] : [])]
      details.append(node('summary', label), node('pre', lines.join('\n')))
      article.append(details)
    }
    container.append(article)
  }
  const replyTarget = thread.messages.findLast((message) => message.labels?.includes('received')) ?? thread.messages.at(-1)
  if (replyTarget && replyTarget.protection?.status !== 'quarantined') {
    const reply = node('button', 'Reply', 'reply-button')
    reply.prepend(icon('reply'))
    action(reply, () => openCompose({ inboxId, message: replyTarget }))
    container.append(reply)
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
    form.querySelector('[type=submit]').textContent = 'Send message'
    $('#compose-title').textContent = reply ? 'Reply' : 'New message'
    $('#compose-from').textContent = `From: ${state.draft.inboxId}`
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
  $('#domain-list').replaceChildren()
  for (const domain of result) {
    const card = node('section', undefined, 'domain-card'), header = node('header')
    header.append(node('strong', domain.domain ?? domain.domainId), statusBadge(domain.status))
    for (const [label, operation] of [['Verify DNS', 'verifyDomain'], ['Remove', 'deleteDomain']]) {
      const button = node('button', label)
      action(button, async () => {
        if (operation === 'deleteDomain' && !confirm(`Remove ${domain.domainId}? Active inboxes must be removed first.`)) return
        await rpc(operation, { domainId: domain.domainId })
        await loadDomains()
      })
      header.append(button)
    }
    card.append(header)
    if (domain.records.length) {
      const table = node('table'), headings = node('tr')
      for (const label of ['Type', 'Name', 'Value', 'Status']) headings.append(node('th', label))
      table.append(headings)
      for (const record of domain.records) {
        const row = node('tr')
        for (const value of [record.type, record.name, `${record.priority === undefined ? '' : `${record.priority} `}${record.value}`, record.status ?? 'Pending']) row.append(node('td', value))
        table.append(row)
      }
      const scroll = node('div', undefined, 'table-scroll'); scroll.append(table); card.append(scroll)
    }
    $('#domain-list').append(card)
  }
  if (!$('#domain-list').children.length) $('#domain-list').append(node('p', 'No domains have been connected yet.'))
}
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close())
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => {
  if (mobileViewport.matches && (document.activeElement === document.body || $('#sidebar').contains(document.activeElement))) $('#open-menu').focus()
})
action($('#compose'), () => openCompose())
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
  showLogin()
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
  $('#native-mail').hidden = session.nativeMailEnabled !== true
  updateAccount()
  $('#developers').hidden = !['access', 'account'].includes(session.authMode)
  $('#settings').hidden = $('#developers').hidden
  $('#account-settings').hidden = $('#developers').hidden
  $('#integrations').hidden = $('#developers').hidden
  $('#credentials').hidden = !['access', 'account'].includes(session.authMode)
  $('#domains').hidden = ['access', 'account'].includes(session.authMode) && !session.customDomainsEnabled
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
