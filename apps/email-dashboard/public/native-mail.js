const $ = selector => document.querySelector(selector)
const node = (tag, text, className) => {
  const item = document.createElement(tag)
  if (text !== undefined) item.textContent = text
  if (className) item.className = className
  return item
}

export function createNativeMailPanel({ rpc }) {
  let inboxes = [], inbox = '', threads = [], nextPage, selected = ''
  let inventoryVersion = 0, listVersion = 0, readVersion = 0
  const button = (label, task, className) => {
    const item = node('button', label, className)
    item.type = 'button'
    item.addEventListener('click', async () => {
      item.disabled = true
      try { await task() } catch (error) { $('#native-mail-error').textContent = error.message }
      finally { item.disabled = false }
    })
    return item
  }
  function renderInboxes() {
    const query = $('#native-inbox-search').value.trim().toLowerCase()
    const filtered = inboxes.filter(item => `${item.inboxId} ${item.displayName || ''}`.toLowerCase().includes(query))
    $('#native-inbox-rows').replaceChildren(...filtered.map(item => {
      const row = node('tr'), name = node('td'), address = node('td'), action = node('td')
      name.append(node('strong', item.displayName || item.inboxId))
      address.textContent = item.address || item.inboxId
      action.append(button('Open', () => openInbox(item.inboxId)))
      row.append(name, address, action)
      return row
    }))
    $('#native-inbox-count').textContent = `${filtered.length} inbox${filtered.length === 1 ? '' : 'es'}`
    $('#native-inboxes-empty').hidden = filtered.length !== 0
    $('#native-inboxes-empty').textContent = inboxes.length ? 'No inboxes match this search.' : 'No active Bezalel inboxes.'
  }
  function clearReader() {
    readVersion++; selected = ''
    $('#native-conversation').replaceChildren(node('p', 'Choose a conversation to read its messages.', 'muted'))
  }
  async function openInbox(address) {
    listVersion++; clearReader(); inbox = address
    $('#native-inventory').hidden = true; $('#native-reader').hidden = false
    $('#native-inbox-address').textContent = address
    $('#native-message-query').value = ''; $('#native-folder').value = 'all'
    await loadThreads()
  }
  function renderThreads() {
    const seen = new Set()
    const items = threads.filter(thread => { if (seen.has(thread.threadId)) return false; seen.add(thread.threadId); return true })
    $('#native-threads').replaceChildren(...items.map(thread => {
      const item = button('', () => readThread(thread.threadId), 'native-thread')
      item.setAttribute('aria-pressed', String(selected === thread.threadId))
      item.append(node('strong', thread.subject || '(No subject)'), node('span', (thread.senders || [thread.from]).join(', ')),
        node('span', thread.preview || 'No preview'), node('time', new Date(thread.timestamp).toLocaleString()))
      return item
    }))
    if (!items.length) $('#native-threads').append(node('p', 'No conversations found.', 'muted'))
  }
  async function loadThreads(append = false) {
    const version = ++listVersion, target = inbox
    if (!target) return
    $('#native-mail-error').textContent = ''; $('#native-more').hidden = true
    if (!append) { threads = []; nextPage = undefined; clearReader(); $('#native-threads').replaceChildren(node('p', 'Loading conversations…', 'muted')) }
    const query = $('#native-message-query').value.trim(), folder = $('#native-folder').value
    const result = await rpc(query ? 'searchMessages' : 'listThreads', { inboxId: target, limit: 30,
      ...(append && nextPage ? { pageToken: nextPage } : {}),
      ...(query ? { query } : { includeTrash: folder === 'trash', ...(folder === 'all' ? {} : { labels: [folder] }) }),
    })
    if (version !== listVersion || target !== inbox) return
    threads.push(...(result.threads || result.messages || [])); nextPage = result.nextPageToken
    renderThreads(); $('#native-more').hidden = !nextPage
  }
  async function readThread(threadId) {
    const version = ++readVersion, target = inbox
    selected = threadId; renderThreads(); $('#native-mail-error').textContent = ''
    $('#native-conversation').replaceChildren(node('p', 'Loading conversation…', 'muted'))
    try {
      const thread = await rpc('getThread', { inboxId: target, threadId, includeBodies: true })
      if (version !== readVersion || target !== inbox) return
      $('#native-conversation').replaceChildren(node('h3', thread.subject || '(No subject)'),
        ...thread.messages.map(message => renderMessage(message, version, target)))
    } catch (error) {
      if (version !== readVersion || target !== inbox) return
      if (error.status === 413) {
        try { await readLargeThread(threadId, version, target); return }
        catch (failure) { error = failure }
      }
      if (version !== readVersion || target !== inbox) return
      $('#native-conversation').replaceChildren(node('p', 'Could not open this conversation. Select it to try again.', 'muted'))
      throw error
    }
  }
  function renderMessage(message, version, target, summaryOnly = false) {
    const article = node('article', undefined, 'native-message')
    article.append(node('strong', message.from), node('p', `To: ${message.to.join(', ')}`),
      node('time', new Date(message.timestamp).toLocaleString()))
    if (summaryOnly) {
      article.append(node('p', message.preview || 'No preview'), button('Read message', async () => {
        const body = await rpc('getMessage', { inboxId: target, messageId: message.messageId })
        if (version === readVersion && target === inbox) article.replaceWith(renderMessage(body, version, target))
      }))
      return article
    }
    article.append(node('div', message.text ?? 'Message body is held for owner review.', 'native-message-body'))
    if (message.protection?.status !== 'quarantined') for (const attachment of message.attachments || []) {
      article.append(button(`Download ${attachment.filename}`, async () => {
        const result = await rpc('getAttachment', { inboxId: target, messageId: message.messageId, attachmentId: attachment.attachmentId })
        if (version !== readVersion || target !== inbox) return
        const url = new URL(result.downloadUrl)
        if (url.origin !== 'https://bezalel-email.michaelwasihun96.workers.dev' || !url.pathname.startsWith('/attachments/') || url.username || url.password)
          throw new Error('Invalid attachment URL')
        const link = node('a'); link.href = url.href; link.rel = 'noreferrer noopener'; link.target = '_blank'; link.click()
      }))
    }
    return article
  }
  async function readLargeThread(threadId, version, target) {
    const content = $('#native-conversation'), messages = node('div'), seen = new Set()
    let pageToken
    const more = button('Load more messages', loadPage)
    content.replaceChildren(node('h3', threads.find(thread => thread.threadId === threadId)?.subject || '(No subject)'),
      node('p', 'This conversation is large. Open individual messages below.', 'muted'), messages, more)
    async function loadPage() {
      let added = 0
      do {
        // The existing list API pages the inbox; select this thread without fetching unrelated bodies.
        const page = await rpc('listMessages', { inboxId: target, limit: 100, ...(pageToken ? { pageToken } : {}) })
        if (version !== readVersion || target !== inbox) return
        for (const message of page.messages) if (message.threadId === threadId && !seen.has(message.messageId)) {
          seen.add(message.messageId); added++
          messages.append(renderMessage(message, version, target, true))
        }
        pageToken = page.nextPageToken
      } while (!added && pageToken)
      if (!pageToken) more.remove()
      if (!seen.size) messages.replaceChildren(node('p', 'No messages found in this conversation.', 'muted'))
    }
    more.disabled = true
    try { await loadPage() } finally { more.disabled = false }
  }
  async function load() {
    const version = ++inventoryVersion
    listVersion++; clearReader(); inbox = ''; inboxes = []
    $('#native-mail-error').textContent = ''; $('#native-inventory').hidden = false; $('#native-reader').hidden = true
    $('#native-inbox-rows').replaceChildren(); $('#native-inboxes-empty').hidden = true; $('#native-inbox-count').textContent = 'Loading inboxes…'
    const result = await rpc('listInboxes', {})
    if (version !== inventoryVersion) return
    inboxes = result.inboxes; renderInboxes()
  }
  function listen(id, task, event = 'click') {
    $(id).addEventListener(event, async e => {
      e.preventDefault(); const element = e.currentTarget
      element.disabled = true
      try { await task() } catch (error) { $('#native-mail-error').textContent = error.message }
      finally { element.disabled = false }
    })
  }
  $('#native-inbox-search').addEventListener('input', renderInboxes)
  listen('#native-refresh', load)
  listen('#native-back', load)
  listen('#native-message-search', () => loadThreads(), 'submit')
  listen('#native-folder', () => { $('#native-message-query').value = ''; return loadThreads() }, 'change')
  listen('#native-more', () => loadThreads(true))
  return { load, reset() {
    inventoryVersion++; listVersion++; clearReader(); inboxes = []; inbox = ''; threads = []; nextPage = undefined
    $('#native-inbox-search').value = ''; $('#native-message-query').value = ''
    $('#native-inbox-rows').replaceChildren(); $('#native-threads').replaceChildren(); $('#native-inbox-address').textContent = ''
    $('#native-inbox-count').textContent = ''; $('#native-mail-error').textContent = ''
  } }
}
