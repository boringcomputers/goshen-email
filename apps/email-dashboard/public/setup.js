const $ = (selector) => document.querySelector(selector)
const shell = window.BezalelDashboardShell

export function connectionCommand(apiUrl) {
  const url = new URL('/inbox-rpc/getInbox', apiUrl)
  return `curl --fail-with-body '${url.href}' \\\n  -H "Authorization: Bearer $GOSHENEMAIL_MAILBOX_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{}'`
}

export function createInboxSetup({ state, rpc, createInbox, loadInboxes, openCredentials, notify, onVisibilityChange }) {
  let open = false, initialChecked = false, version = 0, status = null
  const dismissedKey = () => `bezalel.setup.${state.session?.customer.id}`
  const rememberDismissal = () => { try { localStorage.setItem(dismissedKey(), 'dismissed') } catch {} }
  const wasDismissed = () => { try { return localStorage.getItem(dismissedKey()) === 'dismissed' } catch { return false } }
  const current = () => state.inboxes.find((inbox) => inbox.inboxId === state.inbox)
  function setOpen(value, focus = false) {
    open = value
    $('#setup').hidden = !open
    onVisibilityChange(open)
    if (open && focus) $('#setup-title').focus()
  }
  function render() {
    const inbox = current(), ready = status?.deliveryReady ?? inbox?.deliveryStatus === 'ready'
    const complete = Boolean(status?.connectedAt || status?.receivedAt)
    $('#setup-form').hidden = Boolean(inbox)
    $('#setup-created').hidden = !inbox
    $('#setup-dismiss').firstChild.textContent = inbox ? 'Go to inbox ' : 'Set up later '
    $('#setup-footer-note').textContent = complete ? 'Your inbox is ready. Pick up the conversation whenever you like.' : 'You can use your inbox in the browser or through the API.'
    $('#setup-error').textContent = ''
    const steps = [Boolean(inbox), Boolean(inbox && ready), complete]
    const active = steps.findIndex((value) => !value)
    for (const [index, id] of ['address', 'delivery', 'connect'].entries()) {
      const step = $(`#setup-step-${id}`)
      step.dataset.complete = String(steps[index])
      if (index === active) step.setAttribute('aria-current', 'step')
      else step.removeAttribute('aria-current')
      step.querySelector('.step-number').textContent = steps[index] ? '✓' : String(index + 1)
      step.querySelector('.step-state').textContent = steps[index] ? 'Complete' : index === active ? 'Current step' : 'Up next'
    }
    if (!inbox) return
    $('#setup-inbox-name').textContent = inbox.displayName || 'Your inbox'
    $('#setup-address').textContent = inbox.address
    $('#setup-delivery-badge').textContent = ready ? 'Delivery configured' : 'Setup pending'
    $('#setup-delivery-badge').dataset.status = ready ? 'verified' : 'pending'
    $('#setup-delivery-description').textContent = ready
      ? 'Your address is set up. Try it from another email account or connect your agent below.'
      : 'Your address is reserved. Delivery setup has not finished yet. Retry to keep setting up this same inbox.'
    $('#setup-retry').hidden = ready
    $('#setup-try').hidden = !ready
    $('#setup-mail-status').textContent = status?.receivedAt ? 'Email received. Your address is working.' : 'No email received yet.'
    $('#setup-connection-status').textContent = status?.connectedAt ? 'Connection verified with the current API key.' : 'Agent connection is optional.'
  }
  async function refresh() {
    const inboxId = state.inbox, requestVersion = ++version
    status = null
    render()
    if (!inboxId || !current()?.setupAvailable) return
    try {
      const result = await rpc('setupStatus', { inboxId })
      if (requestVersion !== version || inboxId !== state.inbox || !open) return
      status = result
      render()
    } catch (error) {
      if (requestVersion === version && open) $('#setup-error').textContent = error.message
    }
  }
  async function sync() {
    const enabled = ['access', 'account'].includes(state.authMode) && Boolean(state.session?.customer)
    const available = shell.setupAvailable({ authMode: state.authMode, customer: state.session?.customer, inboxes: state.inboxes, inbox: state.inbox })
    $('#get-started').hidden = !available
    const domain = state.session?.defaultDomain
    shell.paintSetupDomain(domain)
    paintPreview()
    if (!initialChecked && enabled) {
      initialChecked = true
      if (!wasDismissed() && available && state.inboxes.length === 0 && !location.hash) setOpen(true)
    }
    if (!available) setOpen(false)
    if (open) {
      await refresh()
      if (!domain && !state.inbox) $('#setup-error').textContent = 'Email addresses are not available yet. Please try again later.'
    }
  }
  function bind(id, task) {
    const button = $(id)
    button.addEventListener('click', async () => {
      button.disabled = true; $('#setup-error').textContent = ''
      try { await task() } catch (error) { $('#setup-error').textContent = error.message }
      finally { button.disabled = false }
    })
  }
  bind('#get-started', () => setOpen(true, true))
  bind('#setup-dismiss', () => { rememberDismissal(); setOpen(false) })
  bind('#setup-copy-address', async () => { await navigator.clipboard.writeText(current().address); notify('Address copied') })
  bind('#setup-check-mail', refresh)
  bind('#setup-connect', openCredentials)
  bind('#setup-retry', async () => {
    try { await rpc('finishInboxSetup', { inboxId: state.inbox }) }
    finally { await loadInboxes() }
  })
  // The preview card beside the form shows the address as it is typed.
  function paintPreview() {
    const form = $('#setup-form'), name = form.elements.username.value.trim().toLowerCase(), domain = state.session?.defaultDomain
    $('#setup-address-preview').textContent = name && domain ? `Your address will be ${name}@${domain}.` : ''
    $('#setup-preview-address').textContent = domain ? `${name || 'name'}@${domain}` : 'Addresses are not available yet'
    $('#setup-preview-name').textContent = form.elements.displayName.value.trim() || name || 'Your inbox'
  }
  $('#setup-form').addEventListener('input', paintPreview)
  $('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget, button = $('#setup-create')
    button.disabled = true; button.firstChild.textContent = 'Creating inbox '; $('#setup-error').textContent = ''
    try {
      await createInbox({ username: form.elements.username.value.trim().toLowerCase(),
        ...(form.elements.displayName.value.trim() ? { displayName: form.elements.displayName.value.trim() } : {}) })
      form.reset(); paintPreview()
    } catch (error) { $('#setup-error').textContent = error.message }
    finally { button.disabled = !state.session?.defaultDomain; button.firstChild.textContent = 'Create inbox ' }
  })
  return {
    open: async () => { if (!open) setOpen(true, true); await refresh() },
    sync,
    refresh: async () => { if (open) await refresh() },
    close: () => setOpen(false),
    reset() { version++; status = null; initialChecked = false; setOpen(false); $('#setup-form').reset(); paintPreview(); $('#setup-error').textContent = ''; $('#setup-inbox-name').textContent = ''; $('#setup-address').textContent = '' },
  }
}
