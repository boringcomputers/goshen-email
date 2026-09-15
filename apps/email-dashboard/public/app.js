const $ = (selector) => document.querySelector(selector)
const state = { inbox: '', folder: 'inbox', query: '', page: undefined, threads: [], selected: '', listVersion: 0, readVersion: 0, draft: null }
const folderNames = { inbox: 'Inbox', sent: 'Sent', all: 'All mail', quarantined: 'Quarantine', trash: 'Trash' }
let noticeTimer
const node = (tag, text, className) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}
const notify = (message) => {
  clearTimeout(noticeTimer)
  $('#notice').textContent = message
  $('#notice').hidden = false
  noticeTimer = setTimeout(() => { $('#notice').hidden = true }, 7000)
}
async function request(path, value) {
  const response = await fetch(path, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  })
  const body = await response.json()
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin()
    throw new Error(body.error ?? 'Email request failed')
  }
  return body
}
const rpc = async (operation, value = {}) => (await request(`/api/rpc/${operation}`, value)).result
const action = (element, task) => element.addEventListener('click', async () => {
  element.disabled = true
  try { await task() } catch (error) { notify(error.message) } finally { element.disabled = false }
})
function showLogin() {
  state.listVersion++; state.readVersion++
  $('#app').hidden = true
  $('#login').hidden = false
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
}
function emptyReader() {
  const empty = node('div', undefined, 'empty')
  empty.append(node('span', '✉', 'empty-icon'), node('h2', 'A little room to focus.'), node('p', 'Select a conversation to read your mail.'))
  $('#conversation').replaceChildren(empty)
}
async function loadInboxes(preferred = state.inbox) {
  const { inboxes } = await rpc('listInboxes')
  $('#inboxes').replaceChildren(...inboxes.map((inbox) => {
    const option = node('option', inbox.inboxId)
    option.value = inbox.inboxId
    return option
  }))
  state.inbox = inboxes.some((inbox) => inbox.inboxId === preferred) ? preferred : inboxes[0]?.inboxId ?? ''
  $('#inboxes').value = state.inbox
  $('#compose').disabled = !state.inbox
  await loadThreads()
}
async function loadThreads(append = false) {
  const version = ++state.listVersion
  if (!append) { state.readVersion++; state.selected = ''; state.threads = []; state.page = undefined; emptyReader() }
  $('#load-more').hidden = true
  if (!state.inbox) {
    $('#threads').replaceChildren(node('div', 'Create your first inbox to start sending and receiving mail.', 'empty'))
    return
  }
  if (!append) $('#threads').replaceChildren(node('div', 'Loading mail…', 'empty'))
  try {
    const result = await rpc(state.query ? 'searchMessages' : 'listThreads', {
      inboxId: state.inbox, limit: 30, ...(append && state.page ? { pageToken: state.page } : {}),
      ...(state.query ? { query: state.query } : { ...(state.folder === 'all' ? {} : { labels: [state.folder === 'inbox' ? 'received' : state.folder] }), includeTrash: state.folder === 'trash' }),
    })
    if (version !== state.listVersion) return
    state.threads.push(...(result.threads ?? result.messages ?? []).map((item) => ({ ...item, senders: item.senders ?? [item.from] })))
    state.page = result.nextPageToken
    renderThreads()
    $('#load-more').hidden = !state.page
  } catch (error) {
    if (version === state.listVersion) $('#threads').replaceChildren(node('div', error.message, 'empty error'))
    throw error
  }
}
function renderThreads() {
  const seen = new Set()
  const buttons = state.threads.filter((thread) => {
    if (seen.has(thread.threadId)) return false
    seen.add(thread.threadId); return true
  }).map((thread) => {
    const button = node('button', undefined, `thread${state.selected === thread.threadId ? ' selected' : ''}`)
    const meta = node('div', undefined, 'thread-meta')
    meta.append(node('span', thread.senders.join(', '), 'sender'), node('span', new Date(thread.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), 'time'))
    button.append(meta, node('div', thread.subject || '(No subject)', 'subject'), node('div', thread.preview || (state.folder === 'quarantined' ? 'Held for your review' : 'No preview'), 'preview'))
    action(button, () => readThread(thread.threadId))
    return button
  })
  $('#threads').replaceChildren(...(buttons.length ? buttons : [node('div', state.query ? 'No matching messages.' : 'No messages here yet.', 'empty')]))
}
async function readThread(threadId) {
  const version = ++state.readVersion
  const inboxId = state.inbox
  state.selected = threadId
  renderThreads()
  $('#conversation').replaceChildren(node('div', 'Opening conversation…', 'empty'))
  let thread
  try {
    thread = await rpc(state.folder === 'quarantined' ? 'reviewThread' : 'getThread', { inboxId, threadId, includeBodies: true })
  } catch (error) {
    if (version === state.readVersion) $('#conversation').replaceChildren(node('div', error.message, 'empty error'))
    throw error
  }
  if (version !== state.readVersion) return
  const container = $('#conversation')
  container.replaceChildren()
  const header = node('header', undefined, 'reader-header')
  header.append(node('span', `${thread.messageCount} MESSAGE${thread.messageCount === 1 ? '' : 'S'}`, 'eyebrow'), node('h2', thread.subject || '(No subject)'))
  const controls = node('div', undefined, 'reader-tools')
  for (const [label, changes] of [['Archive', { removeLabels: ['received'] }], ['Move to trash', { addLabels: ['trash'] }], ['Move to inbox', { addLabels: ['received'], removeLabels: ['trash'] }]]) {
    const button = node('button', label)
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
    const head = node('div', undefined, 'message-head'), sender = node('div')
    sender.append(node('strong', message.from), node('p', `To: ${message.to.join(', ')}${message.cc?.length ? ` · Cc: ${message.cc.join(', ')}` : ''}`))
    head.append(sender, node('time', new Date(message.timestamp).toLocaleString()))
    article.append(head)
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
    const reply = node('button', '↩ Reply', 'reply-button')
    action(reply, () => openCompose({ inboxId, message: replyTarget }))
    container.append(reply)
  }
  if (thread.labels.includes('unread')) {
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
    header.append(node('strong', domain.domain ?? domain.domainId), node('span', domain.status, 'badge'))
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
      card.append(table)
    }
    $('#domain-list').append(card)
  }
  if (!$('#domain-list').children.length) $('#domain-list').append(node('p', 'No domains have been connected yet.'))
}
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close())
action($('#compose'), () => openCompose())
action($('#discard-draft'), () => {
  if (state.draft?.payload && !confirm('Discard this request? A send without a confirmed receipt may already have been accepted.')) return
  state.draft = null; $('#compose-form').reset(); $('#compose-dialog').close()
})
action($('#refresh'), () => loadThreads())
action($('#load-more'), () => loadThreads(true))
action($('#new-inbox'), () => { $('#inbox-error').textContent = ''; $('#inbox-dialog').showModal() })
action($('#domains'), async () => { $('#domains-dialog').showModal(); await loadDomains() })
action($('#delete-inbox'), async () => {
  const inboxId = state.inbox
  if (!inboxId || !confirm(`Delete ${inboxId} and all its mail? This address cannot be reused.`)) return
  await rpc('deleteInbox', { inboxId })
  if (state.draft?.inboxId === inboxId) state.draft = null
  await loadInboxes(); notify('Inbox deleted')
})
action($('#logout'), async () => {
  await request('/api/logout', {})
  state.draft = null; state.inbox = ''; state.threads = []
  $('#compose-form').reset(); $('#threads').replaceChildren(); emptyReader(); showLogin()
})
$('#inboxes').addEventListener('change', () => { state.inbox = $('#inboxes').value; void loadThreads().catch((error) => notify(error.message)) })
for (const button of document.querySelectorAll('[data-folder]')) action(button, async () => {
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
  ['inbox-form', 'inbox-error', 'createInbox', async (result) => { $('#inbox-dialog').close(); $('#inbox-form').reset(); await loadInboxes(result.inboxId); notify('Inbox created') }],
  ['domain-form', 'domain-error', 'createDomain', async () => { $('#domain-form').reset(); await loadDomains() }],
]) $(`#${formId}`).addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget, button = form.querySelector('[type=submit]')
  button.disabled = true; $(`#${errorId}`).textContent = ''
  try {
    const input = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]).filter(([, value]) => value))
    await after(await rpc(operation, input))
  } catch (error) { $(`#${errorId}`).textContent = error.message } finally { button.disabled = false }
})
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget, button = form.querySelector('button')
  button.disabled = true; $('#login-error').textContent = ''
  try {
    await request('/api/login', { password: form.elements.password.value })
    form.reset(); $('#login').hidden = true; $('#app').hidden = false
    await loadInboxes()
  } catch (error) { $('#login-error').textContent = error.message; notify(error.message) } finally { button.disabled = false }
})
void request('/api/session').then(async ({ authenticated }) => {
  if (!authenticated) return showLogin()
  $('#app').hidden = false
  await loadInboxes()
}).catch((error) => { notify(error.message); if ($('#app').hidden) showLogin() })
