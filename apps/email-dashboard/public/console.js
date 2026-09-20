const $ = selector => document.querySelector(selector)
const shell = window.BezalelDashboardShell

export function createDashboardConsole({ state, rpc, notify, selectInbox, loadInboxes, closeSetup, openSetup, loadPage, closeNavigation }) {
  let page = 'inboxes', ready = false, pageNumber = 0, routeVersion = 0, deletion = null
  const pageSize = 10
  const { titles, parse } = window.BezalelDashboardRoutes
  const pages = Object.keys(titles)
  const allowed = name => !['api-keys', 'integrations', 'domains', 'settings', 'native-mail'].includes(name) || !$(name === 'api-keys' ? '#developers' : `#${name}`).hidden
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
    shell.paintCurrentPage(page)
    delete document.documentElement.dataset.initialPage
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
  function wire(button, task) {
    button.addEventListener('click', async () => {
      closeMenus(); button.disabled = true
      try { await task(button) } catch (error) { notify(error.message) }
      finally { button.disabled = false }
    })
  }
  // Attaches behavior to the rows the shell painted. Saved rows painted before the inventory
  // loads carry their own address and name, so they work even if that load fails.
  function wireRows() {
    for (const row of $('#inbox-rows').children) {
      const { inboxId, address, displayName } = row.dataset
      const inbox = () => state.inboxes.find(inbox => inbox.inboxId === inboxId) ?? { inboxId, address, displayName }
      wire(row.querySelector('[data-action=copy]'), () => copyAddress(inbox().address))
      wire(row.querySelector('[data-action=delete]'), () => confirmDeletion(inbox(), row.querySelector('summary')))
    }
    const create = $('#inboxes-empty [data-action=create]')
    if (create) wire(create, () => $('#new-inbox').click())
  }
  wireRows()
  function render() {
    const painted = shell.paintInboxes({ inboxes: state.inboxes, query: $('#inbox-search').value, group: $('#inbox-group').value, pageNumber, pageSize,
      inventoryFailed: Boolean($('#inboxes-error').textContent) && !state.inboxes.length })
    pageNumber = painted.pageNumber
    wireRows()
  }
  async function copyAddress(address) { await navigator.clipboard.writeText(address); notify('Email address copied') }
  function syncSelection() { shell.paintMailbox({ inboxes: state.inboxes, inbox: state.inbox }) }
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
