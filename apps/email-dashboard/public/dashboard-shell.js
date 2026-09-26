// Paints the workspace from data. This script runs at the end of the body, before the application
// module loads, and paints the workspace saved on the last load. The module renders fresh data
// through the same painters, so a refresh changes nothing on screen unless the data changed.
(() => {
  const $ = selector => document.querySelector(selector)
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
    shield: '<path d="M8 2l5.6 2.4v3.8c0 3.2-2.3 5.6-5.6 6.6-3.3-1-5.6-3.4-5.6-6.6V4.4zM8 5.2v3.6M8 10.8v.2"/>',
    trash: '<path d="M2 4h12M6 4V2h4v2M4 4l.7 10h6.6L12 4M6.5 7v4M9.5 7v4"/>',
    key: '<circle cx="5.6" cy="9.6" r="2.8"/><path d="M7.8 7.7L12.8 2.8M10.8 4.8l1.6 1.6"/>',
    settings: '<path d="M6 2l.5-1h3l.5 1 1.5 1 1.2-.1 1.5 2.6-.7 1.1v1.8l.7 1.1-1.5 2.6-1.2-.1-1.5 1-.5 1h-3l-.5-1-1.5-1-1.2.1-1.5-2.6.7-1.1V6.6l-.7-1.1 1.5-2.6 1.2.1z"/><circle cx="8" cy="7.5" r="2"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.6 1.6 2.4 3.6 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.2z"/>',
    logout: '<path d="M6 2H2v12h4M6 8h8M11 5l3 3-3 3"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    refresh: '<path d="M13.5 6a5.5 5.5 0 00-9.7-2L2 6M2 2v4h4M2.5 10a5.5 5.5 0 009.7 2l1.8-2M14 14v-4h-4"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    menu: '<path d="M2 4h12M2 8h12M2 12h12"/>',
    'chevron-updown': '<path d="M5.5 6L8 3.5 10.5 6M5.5 10L8 12.5 10.5 10"/>',
    'chevron-right': '<path d="M6.5 4.5L10 8l-3.5 3.5"/>',
    more: '<circle cx="3" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="13" cy="8" r=".8"/>',
    copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5a1 1 0 011-1h7"/>',
    code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
    terminal: '<rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4 5l3 3-3 3M9 11h3"/>',
    filter: '<path d="M2 4h12M4 8h8M6 12h4"/>',
    'arrow-right': '<path d="M2 8h12M9 3l5 5-5 5"/>',
    'arrow-left': '<path d="M14 8H2M7 3L2 8l5 5"/>',
    paperclip: '<path d="M10.5 4.5L5.8 9.2a1.5 1.5 0 002.1 2.1l5-5a3 3 0 00-4.2-4.2l-5 5a4.5 4.5 0 006.4 6.4l4.2-4.2"/>',
    archive: '<rect x="2" y="2" width="12" height="3" rx="1"/><path d="M3 5v9h10V5M6 8h4"/>',
    reply: '<path d="M6 3L1 7l5 4M1 7h7a6 6 0 016 6"/>',
    mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 4.5L8 8.5l5.5-4"/>',
    pencil: '<path d="M11.2 2.3l2.5 2.5L6 12.5H3.5V10z"/>',
    book: '<path d="M3.2 3.6h4.4v8.8H3.2zM8.4 3.6h4.4v8.8H8.4z"/>',
    file: '<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9 1.5v4h4"/>',
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    bubble: '<path d="M8 1.8C4.5 1.8 1.6 4.3 1.6 7.4c0 1.7.9 3.2 2.2 4.2l-.6 2.6 3.2-1.6c.5.1 1 .2 1.6.2 3.5 0 6.4-2.5 6.4-5.6S11.5 1.8 8 1.8z" fill="currentColor" stroke="none"/>',
    card: '<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M1.5 6.5h13M4 10h3"/>',
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

  const initials = value => value.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'B'
  const avatar = value => { const element = node('span', initials(value), 'avatar'); element.setAttribute('aria-hidden', 'true'); return element }
  const shortDate = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }
  const customerMode = authMode => ['access', 'account'].includes(authMode)
  function emptyState(title, description, buttonText) {
    const wrap = node('div', undefined, 'empty-wrap'), empty = node('div', undefined, 'empty')
    empty.append(icon('mail'), node('h2', title), node('p', description))
    if (buttonText) empty.append(node('button', buttonText, 'primary'))
    wrap.append(empty)
    return wrap
  }
  function statusBadge(status) {
    const badge = node('span', status, 'badge')
    badge.dataset.status = String(status).toLowerCase()
    return badge
  }
  function menuButton(label, iconName, action, className) {
    const button = node('button', label, className)
    button.type = 'button'; button.dataset.action = action; button.prepend(icon(iconName))
    return button
  }
  // A status pill with a leading dot; tone is success, warning, danger, or neutral.
  function pill(text, tone) {
    const element = node('span', text, 'status-pill')
    element.dataset.tone = tone
    return element
  }
  const number = new Intl.NumberFormat('en-US')
  const localPart = address => String(address).split('@')[0]
  const dayLabel = value => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })
  }
  const threadTime = value => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : dayLabel(value)
  }
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

  // The saved workspace never holds secrets: names, addresses, list rows, and key prefixes only.
  // It is saved with the session's workspace marker cookie and painted only while that marker is
  // still the browser's, so an ended session or another account never sees it.
  const storageKey = 'bezalel.dashboard.snapshot', snapshotVersion = 1
  const marker = () => document.cookie.split('; ').find(part => /^(__Host-)?workspace=/.test(part))?.split('=')[1] || ''
  const snapshot = {
    read() {
      try {
        const value = JSON.parse(localStorage.getItem(storageKey))
        return value && value.version === snapshotVersion ? value : null
      } catch { return null }
    },
    update(changes) {
      try { localStorage.setItem(storageKey, JSON.stringify({ ...(snapshot.read() ?? {}), ...changes, version: snapshotVersion })) } catch {}
    },
    clear() { try { localStorage.removeItem(storageKey) } catch {} },
    marker,
  }

  const threadView = ({ inbox, folder, query, triageFilters }) => JSON.stringify([inbox, folder, query, triageFilters ?? {}])
  const setupAvailable = ({ authMode, customer, inboxes, inbox }) => customerMode(authMode) && Boolean(customer) &&
    (!inbox || inboxes.find(item => item.inboxId === inbox)?.setupAvailable === true)
  const accountDetail = customer => customer
    ? `${customer.email} · ${customer.role === 'admin' ? 'Owner' : customer.inboxLimit === null ? 'No inbox limit' : `${customer.inboxLimit} inboxes`}`
    : 'Owner'

  function paintNavigation(session) {
    const customer = customerMode(session.authMode)
    $('#native-mail').hidden = session.nativeMailEnabled !== true
    for (const id of ['#developers', '#settings', '#account-settings', '#integrations', '#billing']) $(id).hidden = !customer
    $('#credentials').hidden = !customer
    $('#domains').hidden = customer && !session.customDomainsEnabled
  }
  function paintCurrentPage(page) {
    const { titles } = window.BezalelDashboardRoutes
    for (const link of document.querySelectorAll('[data-page]')) {
      if (link.dataset.page === (page === 'mail' ? 'inboxes' : page)) link.setAttribute('aria-current', page === 'mail' ? 'true' : 'page')
      else link.removeAttribute('aria-current')
    }
    markSidebarInbox()
    $('#page-title').textContent = titles[page]
    document.title = `${titles[page]} · Goshen Email`
    delete document.documentElement.dataset.initialTitle
    document.documentElement.style.removeProperty('--initial-page-title')
  }
  function paintAccount({ session, inboxes, inbox }) {
    const customer = session?.customer
    const organization = customer?.organizationName || 'Your workspace'
    $('#workspace-breadcrumb').textContent = organization; $('#workspace-breadcrumb').title = organization
    const current = inboxes.find(item => item.inboxId === inbox)
    const name = customer ? (customer.displayName || customer.email) : (current?.displayName || 'Your workspace')
    $('#account-name').textContent = name; $('#account-name').title = name
    $('#account-avatar').textContent = initials(name)
    $('#account').textContent = accountDetail(customer); $('#account').title = $('#account').textContent
    $('#account-menu-name').textContent = name
    $('#account-menu-detail').textContent = $('#account').textContent
    $('#get-started').hidden = !setupAvailable({ authMode: session?.authMode, customer, inboxes, inbox })
  }
  function markSidebarInbox() {
    const { page, inboxId } = window.BezalelDashboardRoutes.parse(location.hash)
    for (const link of document.querySelectorAll('#sidebar-inboxes a')) {
      if (page === 'mail' && link.dataset.inboxId === inboxId) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
  }
  // The sidebar lists the inventory the dashboard already loaded, so it adds no requests.
  let sidebar = null, usageInboxLimit = null
  function paintSidebarInboxes({ session, inboxes }) {
    sidebar = { session, inboxes }
    // The plan's inbox allowance, when billing reports one, is the limit people hit first.
    const limit = usageInboxLimit ?? session?.customer?.inboxLimit
    $('#sidebar-inbox-count').textContent = limit ? `${number.format(inboxes.length)} of ${number.format(limit)}` : number.format(inboxes.length)
    $('#sidebar-inboxes').replaceChildren(...inboxes.map(inbox => {
      const item = node('li'), link = node('a', undefined, 'sidebar-inbox'), dot = node('span', undefined, 'sidebar-inbox-dot')
      link.href = `#/inboxes/${encodeURIComponent(inbox.inboxId)}`
      link.dataset.inboxId = inbox.inboxId; link.title = inbox.address || inbox.inboxId
      dot.setAttribute('aria-hidden', 'true')
      link.append(dot, node('span', localPart(inbox.address || inbox.inboxId), 'sidebar-inbox-name'))
      if (inbox.deliveryStatus === 'pending') { dot.dataset.status = 'pending'; link.append(node('span', 'Setting up', 'sidebar-inbox-note')) }
      item.append(link)
      return item
    }))
    $('#sidebar-inboxes-empty').hidden = inboxes.length > 0
    $('#sidebar-new-inbox').hidden = inboxes.length === 0
    markSidebarInbox()
  }
  // Sends this month from the plan meters. Without metered billing the link reads Plan and usage.
  function paintUsage(summary) {
    const usage = summary && typeof summary.used === 'number' ? summary : null
    usageInboxLimit = summary?.inboxLimit ?? null
    if (sidebar) paintSidebarInboxes(sidebar)
    const card = $('#billing'), bar = $('#usage-bar')
    if (usage) card.dataset.usage = ''
    else delete card.dataset.usage
    $('#usage-label').textContent = usage ? 'Sends this month' : 'Plan and usage'
    $('#usage-amount').textContent = !usage ? '' : usage.unlimited || !usage.granted ? `${number.format(usage.used)} sent` : `${number.format(usage.used)} of ${number.format(usage.granted)}`
    bar.hidden = !usage || usage.unlimited || !usage.granted
    if (!bar.hidden) {
      bar.max = usage.granted; bar.value = Math.min(usage.used, usage.granted)
      const share = usage.used / usage.granted
      bar.dataset.level = share >= 1 ? 'spent' : share >= 0.8 ? 'high' : 'ok'
    }
  }
  function paintSetupDomain(domain) {
    $('#setup-domain').textContent = domain ? `@${domain}` : ''
    $('#setup-create').disabled = !domain
  }
  function paintIntegrations(apiUrl) {
    $('#developer-base-url').textContent = apiUrl || 'API URL is not configured'
    $('#developer-mcp-url').textContent = apiUrl ? `${apiUrl}/mcp` : 'MCP URL is not configured'
    $('#developer-mcp-command').textContent = apiUrl
      ? `claude mcp add --transport http goshenemail ${apiUrl}/mcp \\\n  --header "Authorization: Bearer $` + '{GOSHENEMAIL_API_KEY}"'
      : 'Configure the API URL to see the command.'
    for (const button of document.querySelectorAll('#integrations-page [data-copy]')) button.disabled = !apiUrl
    if (apiUrl) $('#developer-api-docs').href = `${apiUrl}/openapi.json`
    else $('#developer-api-docs').removeAttribute('href')
  }
  // Rows carry data-inbox-id and data-action so the console can attach behavior after painting.
  function paintInboxes({ inboxes, query, group, pageNumber, pageSize = 10, inventoryFailed = false }) {
    const groups = [...new Set(inboxes.map(inbox => inbox.group).filter(Boolean))].sort()
    const all = node('option', 'All groups'); all.value = ''
    $('#inbox-group').replaceChildren(all, ...groups.map(name => { const option = node('option', name); option.value = name; return option }))
    $('#inbox-group').value = groups.includes(group) ? group : ''
    const selectedGroup = $('#inbox-group').value, search = query.trim().toLowerCase()
    const filtered = inboxes.filter(inbox => (!selectedGroup || inbox.group === selectedGroup) && [inbox.inboxId, inbox.displayName, inbox.group].filter(Boolean).join(' ').toLowerCase().includes(search))
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)), current = Math.min(pageNumber, totalPages - 1)
    $('#inbox-rows').replaceChildren(...filtered.slice(current * pageSize, (current + 1) * pageSize).map(inbox => {
      const row = node('tr'), identity = node('td'), link = node('a', undefined, 'inbox-link')
      row.dataset.inboxId = inbox.inboxId; row.dataset.address = inbox.address || inbox.inboxId; row.dataset.displayName = inbox.displayName || ''
      link.href = `#/inboxes/${encodeURIComponent(inbox.inboxId)}`
      const mark = node('span', undefined, 'inbox-mark'); mark.append(icon('mail'))
      const copy = node('span'); copy.append(node('strong', inbox.displayName || localPart(inbox.inboxId)), node('span', inbox.address || inbox.inboxId, 'mono'))
      link.append(mark, copy); identity.append(link)
      const status = node('td'), pending = inbox.deliveryStatus === 'pending'
      status.append(pill(pending ? 'Setting up' : 'Receiving', pending ? 'neutral' : 'success'))
      const group = node('td', undefined, 'inbox-group-cell')
      group.append(inbox.group ? node('span', inbox.group, 'group-chip') : node('span', 'Ungrouped', 'muted'))
      const menu = node('details', undefined, 'actions-menu'), summary = node('summary'), popover = node('div', undefined, 'actions-popover')
      summary.setAttribute('aria-label', `Options for ${inbox.inboxId}`); summary.title = 'Inbox options'; summary.append(icon('more'))
      popover.append(menuButton('Copy email address', 'copy', 'copy'), menuButton('Delete inbox…', 'trash', 'delete', 'danger-text'))
      menu.append(summary, popover)
      const actions = node('td'); actions.append(menu)
      row.append(identity, group, status, node('td', shortDate(inbox.createdAt), 'inbox-created-cell'), actions)
      return row
    }))
    const empty = $('#inboxes-empty'); empty.hidden = filtered.length !== 0 || inventoryFailed
    empty.replaceChildren(icon('mail'), node('h2', inboxes.length ? 'No inboxes found' : 'Create your first inbox'), node('p', inboxes.length ? 'Try a different name, address, or group.' : 'Give your agent an email address to send and receive mail.'))
    if (!inboxes.length) { const create = node('button', 'Create inbox', 'primary'); create.type = 'button'; create.dataset.action = 'create'; empty.append(create) }
    $('#inbox-count').textContent = inventoryFailed ? '' : `${filtered.length} inbox${filtered.length === 1 ? '' : 'es'}${filtered.length !== inboxes.length ? ` of ${inboxes.length}` : ''}`
    $('#inbox-page-count').textContent = `Page ${current + 1} of ${totalPages}`
    $('#inbox-previous').disabled = current === 0; $('#inbox-next').disabled = current + 1 === totalPages
    return { filtered, totalPages, pageNumber: current }
  }
  function paintMailbox({ inboxes, inbox }) {
    const current = inboxes.find(item => item.inboxId === inbox)
    $('#inboxes').replaceChildren(...inboxes.map(item => {
      const option = node('option', `${item.group ? `[${item.group}] ` : ''}${item.inboxId}${item.deliveryStatus === 'pending' ? ' (setup pending)' : ''}`)
      option.value = item.inboxId
      return option
    }))
    $('#inboxes').value = inbox; $('#inboxes').title = inbox
    $('#mail-heading').textContent = current?.displayName || inbox || 'Inbox'
    $('#mailbox-address').textContent = inbox || 'Choose a mailbox to get started'; $('#mailbox-address').title = inbox
    $('#compose').disabled = !inbox; $('#sidebar-compose').disabled = !inbox
    $('#delete-inbox').disabled = !current; $('#copy-inbox-address').disabled = !current
    const status = $('#mail-status'), pending = current?.deliveryStatus === 'pending'
    status.hidden = !current
    status.textContent = pending ? 'Setting up' : 'Receiving'; status.dataset.tone = pending ? 'neutral' : 'success'
    $('#finish-inbox').hidden = current?.deliveryStatus !== 'pending'
  }
  function triageBadges(triage) {
    const title = value => value.charAt(0).toUpperCase() + value.slice(1), percent = value => `${Math.round(value * 100)}%`
    const group = node('div', '', 'triage-badges')
    if (!triage) return group
    group.setAttribute('aria-label', 'Email triage')
    if (triage.status !== 'complete') {
      group.append(node('span', triage.status === 'pending' ? 'Analysis pending' : 'Analysis unavailable', 'triage-badge muted'))
      return group
    }
    const category = node('span', `${triage.category.confidence < 0.5 ? 'Maybe ' : ''}${title(triage.category.value)}`, 'triage-badge')
    category.title = `Category confidence: ${percent(triage.category.confidence)}`
    group.append(category)
    const reply = triage.needsReply.value
    group.append(node('span', reply === null ? 'Reply unclear' : reply ? 'Needs reply' : 'No reply needed', `triage-badge${reply ? ' triage-reply' : ''}`))
    const urgency = triage.urgency.value
    group.append(node('span', urgency ? `${title(urgency)} urgency` : 'Urgency unclear', `triage-badge triage-${urgency ?? 'uncertain'}`))
    return group
  }
  // Thread buttons carry data-thread-id; the list remembers which view it shows in data-view.
  function paintThreads({ threads, selected, view, folder, query, filtered, more }) {
    const seen = new Set()
    const buttons = threads.filter(thread => {
      if (seen.has(thread.threadId)) return false
      seen.add(thread.threadId); return true
    }).map(thread => {
      const unread = thread.labels?.includes('unread'), senders = thread.senders ?? [thread.from]
      const button = node('button', undefined, `thread${selected === thread.threadId ? ' selected' : ''}${unread ? ' unread' : ''}`)
      button.dataset.threadId = thread.threadId
      button.setAttribute('aria-pressed', String(selected === thread.threadId))
      const marker = node('span', undefined, 'thread-marker')
      if (unread) { const dot = node('span', undefined, 'unread-dot'); dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Unread'); marker.append(dot) }
      const copy = node('div', undefined, 'thread-copy'), meta = node('div', undefined, 'thread-meta')
      meta.append(node('span', senders.join(', '), 'sender'), node('span', threadTime(thread.timestamp), 'time'))
      copy.append(meta, node('div', thread.subject || '(No subject)', 'subject'), node('div', thread.preview || (folder === 'quarantined' ? 'Held for your review' : 'No preview'), 'preview'))
      const tags = node('div', undefined, 'thread-tags'), facts = []
      if (folder === 'quarantined') tags.append(node('span', 'Quarantined', 'triage-badge triage-held'))
      tags.append(triageBadges(thread.triage))
      if (thread.messageCount) facts.push(plural(thread.messageCount, 'message'))
      if (thread.attachmentCount) facts.push(plural(thread.attachmentCount, 'attachment'))
      if (facts.length) tags.append(node('span', facts.join(' · '), 'thread-facts'))
      copy.append(tags)
      button.append(marker, copy)
      return button
    })
    $('#thread-count').textContent = `${buttons.length}${more ? '+' : ''}`
    $('#thread-count').hidden = !buttons.length
    // The open folder's tab shows the same count; searches and filters count a different list.
    for (const tab of document.querySelectorAll('[data-folder]')) {
      if (tab.dataset.folder === folder && !query && !filtered && buttons.length) tab.dataset.count = $('#thread-count').textContent
      else delete tab.dataset.count
    }
    $('#threads').replaceChildren(...(buttons.length ? buttons : [emptyState(query || filtered ? 'No matching messages' : 'No conversations yet',
      filtered ? 'Try different triage filters or clear them to see all conversations.' : query ? 'Try a different search in this mailbox.' : 'Messages in this folder will appear here.')]))
    $('#threads').dataset.view = view
    $('#load-more').hidden = !more
  }
  function paintReaderEmpty() {
    $('.mail-workspace').classList.remove('reading')
    $('#conversation').replaceChildren(emptyState('A little room to focus.', 'Select a conversation to read your mail.'))
  }
  function paintSettings(customer, { authMode, only } = {}) {
    for (const form of [$('#organization-form'), $('#profile-form'), $('#notifications-form')]) {
      if (only && form.id !== only) continue
      for (const input of form.querySelectorAll('input[name]')) {
        if (input.type === 'checkbox') input.checked = customer[input.name] ?? false
        else input.value = customer[input.name] ?? ''
      }
    }
    $('#settings-email').value = customer.email
    $('#notification-email').textContent = customer.email
    $('#settings-sign-in-method').textContent = authMode === 'access'
      ? 'Sign in with an email code through Cloudflare Access.'
      : 'Sign in with an email link or a one-time code.'
    paintNotificationPermission()
  }
  function paintNotificationPermission() {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported'
    $('#desktop-permission').textContent = {
      granted: 'This browser can show desktop notifications.',
      denied: 'Notifications are blocked. Allow them in your browser’s site settings.',
      default: 'Allow notifications in this browser to receive desktop alerts.',
      unsupported: 'This browser does not support desktop notifications.',
    }[permission]
    $('#allow-notifications').hidden = permission !== 'default'
  }
  // Revoke buttons carry data-key-id and data-key-name.
  function paintApiKeys(keys) {
    const wrap = node('div', undefined, 'resource-table-wrap'), table = node('table', undefined, 'resource-table keys-table'), head = node('thead'), headings = node('tr'), body = node('tbody')
    for (const label of ['Name', 'Key', 'Scopes', 'Expires', 'Status', 'Actions']) {
      const heading = node('th'); heading.scope = 'col'
      if (label === 'Actions') heading.append(node('span', label, 'sr-only')); else heading.textContent = label
      headings.append(heading)
    }
    head.append(headings)
    const expiry = value => {
      const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000)
      return days > 0 ? `${dayLabel(value)} · in ${plural(days, 'day')}` : dayLabel(value)
    }
    for (const key of keys) {
      const row = node('tr'), copy = node('td'), prefix = node('td', undefined, 'key-prefix-cell'), scopes = node('td', undefined, 'key-scopes-cell'), status = node('td'), actions = node('td')
      const expired = key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()
      if (key.revokedAt || expired) row.className = 'inactive'
      copy.append(node('strong', key.name, 'mono'), node('small', key.createdAt ? `Created ${dayLabel(key.createdAt)}` : ''))
      prefix.append(node('code', `${key.prefix}…`, 'chip mono'))
      const chips = node('span', undefined, 'chips'); chips.append(...key.scopes.map(scope => node('span', scope, 'chip')))
      scopes.append(chips)
      status.append(pill(key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active', key.revokedAt ? 'danger' : expired ? 'neutral' : 'success'))
      if (!key.revokedAt && !expired) {
        const revoke = node('button', 'Revoke', 'text-button danger-text')
        revoke.type = 'button'; revoke.dataset.keyId = key.keyId; revoke.dataset.keyName = key.name
        revoke.setAttribute('aria-label', `Revoke ${key.name}`)
        actions.append(revoke)
      }
      const expires = node('td', key.revokedAt ? `Revoked ${dayLabel(key.revokedAt)}` : key.expiresAt ? expiry(key.expiresAt) : 'Never', 'key-expires-cell')
      row.append(copy, prefix, scopes, expires, status, actions)
      body.append(row)
    }
    table.append(head, body); wrap.append(table)
    if (!keys.length) {
      const empty = node('div', undefined, 'resource-empty')
      empty.append(node('h2', 'No account API keys yet.'), node('p', 'Create a key to connect your first agent.'))
      wrap.append(empty)
    }
    $('#developer-key-list').replaceChildren(wrap)
  }
  // Cards carry data-domain-id; their buttons carry data-action verify or remove.
  // What each record does, read from the record itself. The Worker issues these five kinds.
  const recordPurpose = record => record.type === 'MX' ? 'Incoming mail' : record.name.startsWith('_bezalel.') ? 'Ownership'
    : record.name.includes('._domainkey.') ? 'Signing' : record.name.startsWith('_dmarc.') ? 'Policy' : /^v=spf1/i.test(record.value) ? 'Sending' : ''
  function paintDomains(domains) {
    $('#domain-list').replaceChildren(...domains.map(domain => {
      const card = node('section', undefined, 'domain-card'), header = node('header'), title = node('div', undefined, 'domain-title'), actions = node('div', undefined, 'domain-actions')
      card.dataset.domainId = domain.domainId
      const status = String(domain.status).toLowerCase(), found = domain.records.filter(record => record.status === 'verified').length
      const label = status.charAt(0).toUpperCase() + status.slice(1)
      title.append(node('h2', domain.domain ?? domain.domainId),
        pill(status === 'verified' ? 'Verified' : `${label}${domain.records.length ? ` · ${found} of ${domain.records.length} records found` : ''}`, status === 'verified' ? 'success' : status === 'pending' ? 'warning' : 'danger'))
      for (const [text, action, className] of [['Remove', 'remove', ''], ['Verify DNS', 'verify', 'primary']]) {
        const button = node('button', text, className); button.type = 'button'; button.dataset.action = action
        actions.append(button)
      }
      header.append(title, actions)
      card.append(header)
      if (domain.records.length) {
        const table = node('table', undefined, 'records-table'), head = node('thead'), headings = node('tr'), body = node('tbody')
        for (const text of ['Type', 'Name', 'Value', 'Purpose', 'Status']) { const heading = node('th', text); heading.scope = 'col'; headings.append(heading) }
        head.append(headings)
        for (const record of domain.records) {
          const row = node('tr'), type = node('td'), value = node('td', undefined, 'record-value'), state = node('td')
          const text = `${record.priority === undefined ? '' : `${record.priority} `}${record.value}`
          type.append(node('span', record.type, 'record-type'))
          const copy = node('button', undefined, 'icon-button copy-value'); copy.type = 'button'; copy.dataset.copyValue = record.value
          copy.setAttribute('aria-label', `Copy ${record.type} value for ${record.name}`); copy.title = 'Copy value'; copy.append(icon('copy'))
          value.append(node('span', text, 'mono'), copy)
          state.append(pill(record.status === 'verified' ? 'Found' : 'Pending', record.status === 'verified' ? 'success' : 'warning'))
          row.append(type, node('td', record.name, 'mono record-name'), value, node('td', recordPurpose(record), 'record-purpose'), state)
          body.append(row)
        }
        table.append(head, body)
        const scroll = node('div', undefined, 'table-scroll'); scroll.append(table); card.append(scroll)
      }
      return card
    }))
    if (!domains.length) $('#domain-list').append(node('p', 'No domains have been connected yet.', 'resource-note'))
  }
  // Rows carry data-inbox-id; their Open buttons are wired by the native mail panel.
  function paintNativeInboxes(inboxes, query) {
    const search = query.trim().toLowerCase()
    const filtered = inboxes.filter(item => `${item.inboxId} ${item.displayName || ''}`.toLowerCase().includes(search))
    $('#native-inbox-rows').replaceChildren(...filtered.map(item => {
      const row = node('tr'), name = node('td'), open = node('td'), button = node('button', 'Open')
      row.dataset.inboxId = item.inboxId; button.type = 'button'
      name.append(node('strong', item.displayName || item.inboxId)); open.append(button)
      row.append(name, node('td', item.address || item.inboxId), open)
      return row
    }))
    $('#native-inbox-count').textContent = `${filtered.length} inbox${filtered.length === 1 ? '' : 'es'}`
    $('#native-inboxes-empty').hidden = filtered.length !== 0
    $('#native-inboxes-empty').textContent = inboxes.length ? 'No inboxes match this search.' : 'No active Bezalel inboxes.'
    return filtered
  }

  function restore() {
    const { titles, parse } = window.BezalelDashboardRoutes
    const route = parse(location.hash)
    if (!Object.hasOwn(titles, route.page)) route.page = 'inboxes'
    const saved = snapshot.read(), current = marker()
    if (!saved?.session || !current || saved.marker !== current) { paintCurrentPage(route.page); return }
    const { session, inboxes = [] } = saved
    const inbox = route.page === 'mail' && inboxes.some(item => item.inboxId === route.inboxId) ? route.inboxId : ''
    paintNavigation(session)
    paintCurrentPage(route.page)
    paintAccount({ session, inboxes, inbox })
    paintSidebarInboxes({ session, inboxes })
    if (saved.usage !== undefined) paintUsage(saved.usage)
    // The browser may have restored the search field; paint what the console will show for it.
    paintInboxes({ inboxes, query: $('#inbox-search').value, group: '', pageNumber: 0 })
    paintSetupDomain(session.defaultDomain)
    paintIntegrations(session.apiUrl)
    if (inbox) {
      paintMailbox({ inboxes, inbox })
      const threads = saved.threads?.[inbox]
      if (threads) paintThreads({ threads: threads.items, selected: '', view: threadView({ inbox, folder: 'inbox', query: '', triageFilters: {} }), folder: 'inbox', query: '', filtered: false, more: threads.more })
      paintReaderEmpty()
    }
    if (route.page === 'settings' && session.customer) {
      paintSettings(session.customer, { authMode: session.authMode })
      $('#settings-content').hidden = false
    }
    if (route.page === 'api-keys' && saved.apiKeys) paintApiKeys(saved.apiKeys)
    if (route.page === 'domains' && saved.domains) paintDomains(saved.domains)
    if (route.page === 'native-mail' && session.nativeMailEnabled && saved.nativeInboxes) paintNativeInboxes(saved.nativeInboxes, '')
    $('#app').dataset.restored = ''
  }
  restore()

  window.BezalelDashboardShell = Object.freeze({
    icon, node, avatar, pill, emptyState, statusBadge, snapshot, threadView, setupAvailable, triageBadges,
    paintNavigation, paintCurrentPage, paintAccount, paintSidebarInboxes, paintUsage, paintSetupDomain, paintIntegrations, paintInboxes, paintMailbox, paintThreads, paintReaderEmpty,
    paintSettings, paintNotificationPermission, paintApiKeys, paintDomains, paintNativeInboxes,
  })
})()
