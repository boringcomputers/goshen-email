import { createDesktopNotifications } from "/notifications.js"
import { triageBadges, triageDetails } from "./triage.js"
import { createDeveloperPanel } from "./developer.js"
import { createInboxSetup, connectionCommand } from './setup.js'
import { createDashboardConsole } from './console.js'
import { createSettingsPanel } from './settings.js'
import { createNativeMailPanel } from './native-mail.js'
const $ = (selector) => document.querySelector(selector)
// dashboard-shell.js paints the last saved workspace before this module loads; the same painters render fresh data.
const shell = window.BezalelDashboardShell
const { icon, node, avatar, snapshot } = shell
const accountEvents = new BroadcastChannel('bezalel-account')
accountEvents.addEventListener('message', (event) => { if (event.data === 'signed-out' && state.authMode === 'account') showLogin() })
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
const state = { session: null, epoch: 0, inboxes: [], inbox: '', folder: 'inbox', query: '', triageFilters: {}, page: undefined, threads: [], selected: '', listVersion: 0, readVersion: 0, draft: null }
const folderNames = { inbox: 'Inbox', sent: 'Sent', all: 'All mail', quarantined: 'Quarantine', trash: 'Trash' }
let noticeTimer
function emptyState(title, description, buttonText, onClick) {
  const wrap = shell.emptyState(title, description, buttonText)
  if (buttonText) action(wrap.querySelector('button'), onClick)
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
  snapshot.update({ session: { authMode: session.authMode, customer, defaultDomain: session.defaultDomain, apiUrl: session.apiUrl,
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
    if ([401, 403].includes(response.status) && path !== '/api/login') {
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
const dashboard = createDashboardConsole({ state, rpc, notify, selectInbox, loadInboxes,
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
  } finally {
    if (epoch === state.epoch && !$('#app').hidden) {
      setWorkspaceLoading(false)
      document.querySelector('.workspace-content > section:not([hidden]) [tabindex="-1"]')?.focus({ preventScroll: true })
    }
  }
}
function showLogin(mode = state.authMode, reason = '') {
  if (mode === 'account' && state.redirecting) return
  snapshot.clear()
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
    if (version === state.listVersion) $('#threads').replaceChildren(emptyState('Could not load mail', error.message, 'Try again', () => loadThreads()))
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
  snapshot.update({ domains: result })
  shell.paintDomains(result)
  for (const button of $('#domain-list').querySelectorAll('[data-action]')) {
    const { domainId } = button.closest('[data-domain-id]').dataset
    action(button, async () => {
      if (button.dataset.action === 'remove' && !confirm(`Remove ${domainId}? Active inboxes must be removed first.`)) return
      await rpc(button.dataset.action === 'remove' ? 'deleteDomain' : 'verifyDomain', { domainId })
      await loadDomains()
    })
  }
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
