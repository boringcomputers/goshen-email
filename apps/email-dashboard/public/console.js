const $ = selector => document.querySelector(selector)
const element = (tag, text, className) => {
  const item = document.createElement(tag)
  if (text !== undefined) item.textContent = text
  if (className) item.className = className
  return item
}

export function createDashboardConsole({ state, icon, rpc, notify, selectInbox, loadInboxes, closeSetup, openSetup, loadPage, closeNavigation }) {
  let page = 'inboxes', ready = false, pageNumber = 0, routeVersion = 0, deletion = null
  const pageSize = 10
  const { titles, parse } = window.BezalelDashboardRoutes
  const pages = Object.keys(titles)
  const allowed = name => !['api-keys', 'integrations', 'domains', 'settings'].includes(name) || !$(name === 'api-keys' ? '#developers' : `#${name}`).hidden
  const mailRoute = inboxId => `#/inboxes/${encodeURIComponent(inboxId)}`
  function navigate(hash, replace = false) {
    if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash)
    if (ready) return route()
  }
  function closeMenus(restoreFocus = false) {
    for (const menu of document.querySelectorAll('.actions-menu[open]')) {
      menu.open = false
      if (restoreFocus) menu.querySelector('summary').focus()
    }
  }
  document.addEventListener('click', event => {
    for (const menu of document.querySelectorAll('.actions-menu[open]')) if (!menu.contains(event.target)) menu.open = false
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('.actions-menu[open]')) { event.preventDefault(); closeMenus(true) }
  })
  document.addEventListener('focusin', event => {
    for (const menu of document.querySelectorAll('.actions-menu[open]')) if (!menu.contains(event.target)) menu.open = false
  })
  async function route() {
    const version = ++routeVersion
    const route = parse(location.hash), inboxId = route.inboxId
    page = route.page
    if (!pages.includes(page) || !allowed(page)) return navigate('#/inboxes', true)
    if (page === 'mail' && !state.inboxes.some(inbox => inbox.inboxId === inboxId)) { notify('This inbox is no longer available.'); return navigate('#/inboxes', true) }
    closeMenus(); closeNavigation()
    if (page !== 'setup') closeSetup()
    for (const name of pages) $(name === 'setup' ? '#setup' : `#${name}-page`).hidden = name !== page
    for (const link of document.querySelectorAll('[data-page]')) {
      if (link.dataset.page === (page === 'mail' ? 'inboxes' : page)) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    $('#page-title').textContent = titles[page]
    document.title = `${titles[page]} · Bezalel Email`
    delete document.documentElement.dataset.initialPage
    document.documentElement.style.removeProperty('--initial-page-title')
    $('.workspace-content').scrollTop = 0
    const heading = $(page === 'setup' ? '#setup-title' : `#${page}-heading`)
    heading?.focus({ preventScroll: true })
    try {
      if (page === 'mail') { await selectInbox(inboxId); if (version === routeVersion) syncSelection() }
      else if (page === 'setup') await openSetup()
      else if (page === 'inboxes') render()
      else await loadPage(page)
    } catch (error) {
      if (version !== routeVersion) return
      const target = $(`#${page}-error`)
      if (target) target.textContent = error.message
      else notify(error.message)
    }
  }
  function action(label, task, className) {
    const button = element('button', label, className)
    button.type = 'button'
    button.addEventListener('click', async () => {
      closeMenus(); button.disabled = true
      try { await task(button) } catch (error) { notify(error.message) }
      finally { button.disabled = false }
    })
    return button
  }
  function options(inbox) {
    const details = element('details', undefined, 'actions-menu'), summary = element('summary')
    summary.setAttribute('aria-label', `Options for ${inbox.inboxId}`); summary.title = 'Inbox options'; summary.append(icon('more'))
    const popover = element('div', undefined, 'actions-popover')
    const copy = action('Copy email address', () => copyAddress(inbox.address || inbox.inboxId))
    copy.prepend(icon('copy'))
    const remove = action('Delete inbox…', () => confirmDeletion(inbox, summary), 'danger-text')
    remove.prepend(icon('trash')); popover.append(copy, remove); details.append(summary, popover)
    return details
  }
  function render() {
    const group = $('#inbox-group').value
    const groups = [...new Set(state.inboxes.map(inbox => inbox.group).filter(Boolean))].sort()
    const all = element('option', 'All groups'); all.value = ''
    $('#inbox-group').replaceChildren(all, ...groups.map(name => { const option = element('option', name); option.value = name; return option }))
    $('#inbox-group').value = groups.includes(group) ? group : ''
    const query = $('#inbox-search').value.trim().toLowerCase()
    const filtered = state.inboxes.filter(inbox => (!$('#inbox-group').value || inbox.group === $('#inbox-group').value) && [inbox.inboxId, inbox.displayName, inbox.group].filter(Boolean).join(' ').toLowerCase().includes(query))
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)); pageNumber = Math.min(pageNumber, totalPages - 1)
    $('#inbox-rows').replaceChildren(...filtered.slice(pageNumber * pageSize, (pageNumber + 1) * pageSize).map(inbox => {
      const row = element('tr'), identity = element('td'), link = element('a', undefined, 'inbox-link')
      link.href = mailRoute(inbox.inboxId)
      const mark = element('span', undefined, 'inbox-mark'); mark.append(icon('inbox'))
      const copy = element('span'); copy.append(element('strong', inbox.displayName || inbox.inboxId), element('span', inbox.address || inbox.inboxId))
      link.append(mark, copy); identity.append(link)
      const groupCell = element('td', inbox.group || 'Ungrouped', 'inbox-group-cell')
      const status = element('td'), badge = element('span', inbox.deliveryStatus === 'pending' ? 'Setup pending' : 'Ready', 'delivery-badge')
      badge.dataset.status = inbox.deliveryStatus === 'pending' ? 'pending' : 'ready'; status.append(badge)
      const date = new Date(inbox.createdAt)
      const created = element('td', Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), 'inbox-created-cell')
      const actions = element('td'); actions.append(options(inbox)); row.append(identity, groupCell, status, created, actions); return row
    }))
    const inventoryFailed = Boolean($('#inboxes-error').textContent) && !state.inboxes.length
    const empty = $('#inboxes-empty'); empty.hidden = filtered.length !== 0 || inventoryFailed
    empty.replaceChildren(icon('inbox'), element('h2', state.inboxes.length ? 'No inboxes found' : 'Create your first inbox'), element('p', state.inboxes.length ? 'Try a different name, address, or group.' : 'Give your agent an email address to send and receive mail.'))
    if (!state.inboxes.length) empty.append(action('Create inbox', () => $('#new-inbox').click(), 'primary'))
    $('#inbox-count').textContent = inventoryFailed ? '' : `${filtered.length} inbox${filtered.length === 1 ? '' : 'es'}${filtered.length !== state.inboxes.length ? ` of ${state.inboxes.length}` : ''}`
    $('#inbox-page-count').textContent = `Page ${pageNumber + 1} of ${totalPages}`
    $('#inbox-previous').disabled = pageNumber === 0; $('#inbox-next').disabled = pageNumber + 1 === totalPages
  }
  async function copyAddress(address) { await navigator.clipboard.writeText(address); notify('Email address copied') }
  function syncSelection() {
    const inbox = state.inboxes.find(inbox => inbox.inboxId === state.inbox)
    $('#mail-heading').textContent = inbox?.displayName || state.inbox || 'Inbox'
    $('#inboxes').title = state.inbox
    $('#delete-inbox').disabled = !inbox; $('#copy-inbox-address').disabled = !inbox
  }
  function confirmDeletion(inbox, trigger) {
    if (!inbox || deletion?.pending) return
    closeMenus()
    deletion = { inboxId: inbox.inboxId, epoch: state.epoch, trigger, pending: false }
    $('#delete-inbox-name').textContent = inbox.displayName || 'Inbox'
    $('#delete-inbox-address').textContent = inbox.address || inbox.inboxId
    $('#delete-inbox-error').textContent = ''
    $('#delete-inbox-dialog').showModal(); $('#cancel-delete-inbox').focus()
  }
  $('#delete-inbox').addEventListener('click', () => confirmDeletion(state.inboxes.find(inbox => inbox.inboxId === state.inbox), $('#mail-actions summary')))
  $('#delete-inbox-dialog').addEventListener('cancel', event => { if (deletion?.pending) event.preventDefault() })
  $('#delete-inbox-dialog').addEventListener('close', () => {
    const trigger = deletion?.trigger
    deletion = null
    if (trigger?.isConnected && trigger.checkVisibility()) trigger.focus()
    else if (page === 'inboxes') $('#inboxes-heading').focus()
  })
  $('#delete-inbox-form').addEventListener('submit', async event => {
    event.preventDefault()
    const target = deletion
    if (!target || target.pending || target.epoch !== state.epoch) return
    target.pending = true
    $('#confirm-delete-inbox').disabled = true; $('#cancel-delete-inbox').disabled = true
    $('#confirm-delete-inbox').textContent = 'Deleting…'; $('#delete-inbox-error').textContent = ''
    try {
      await rpc('deleteInbox', { inboxId: target.inboxId })
      if (target.epoch !== state.epoch) return
      if (state.draft?.inboxId === target.inboxId) state.draft = null
      // Remove the confirmed deletion locally even if refreshing the inventory fails.
      state.inboxes = state.inboxes.filter(inbox => inbox.inboxId !== target.inboxId)
      if (state.inbox === target.inboxId) state.inbox = ''
      $('#delete-inbox-dialog').close(); render(); navigate('#/inboxes', true)
      notify('Inbox deleted')
      try { await loadInboxes() }
      catch { $('#inboxes-error').textContent = 'Inbox deleted. Refresh to load the latest inbox list.' }
    } catch (error) { if (target.epoch === state.epoch) $('#delete-inbox-error').textContent = error.message }
    finally {
      target.pending = false
      $('#confirm-delete-inbox').disabled = false; $('#cancel-delete-inbox').disabled = false
      $('#confirm-delete-inbox').textContent = 'Delete inbox'
    }
  })
  for (const id of ['inbox-search', 'inbox-group']) $( `#${id}`).addEventListener(id === 'inbox-search' ? 'input' : 'change', () => { pageNumber = 0; render() })
  $('#inbox-previous').addEventListener('click', () => { pageNumber--; render() })
  $('#inbox-next').addEventListener('click', () => { pageNumber++; render() })
  $('#refresh-inboxes').addEventListener('click', async () => {
    $('#refresh-inboxes').disabled = true; $('#inboxes-error').textContent = ''
    try { await loadInboxes() } catch (error) { $('#inboxes-error').textContent = error.message }
    finally { $('#refresh-inboxes').disabled = false }
  })
  $('#copy-inbox-address').addEventListener('click', () => { void copyAddress(state.inboxes.find(inbox => inbox.inboxId === state.inbox)?.address || state.inbox).catch(() => notify('Could not copy the address. Select it to copy manually.')) })
  window.addEventListener('hashchange', () => { if (ready) void route() })
  return {
    render, syncSelection, get page() { return page },
    start() { ready = true; return navigate(location.hash || '#/inboxes', true) },
    openInbox(inboxId) { navigate(mailRoute(inboxId)) },
    showSetup(open) { if (open && page !== 'setup') navigate('#/setup'); else if (!open && page === 'setup') navigate(state.inbox ? mailRoute(state.inbox) : '#/inboxes') },
    reset() { ready = false; routeVersion++; pageNumber = 0; deletion = null; closeMenus(); $('#inbox-search').value = ''; $('#inbox-group').value = ''; render() },
  }
}
