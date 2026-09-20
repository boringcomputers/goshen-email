export const staleApiMessage = 'The email API is running an older version without workspace settings. Deploy the latest API Worker, then try again.'
// The API Worker rejects an operation it does not know with exactly this 404. Any other 404 keeps its own explanation.
export const staleApiRejection = 'Unknown dashboard operation'
export const settingsErrorMessage = error => error?.status === 404 && error.message === staleApiRejection ? staleApiMessage : error?.message || 'Settings request failed'

export function createSettingsPanel({ rpc, onChange, getAuthMode, getCustomer }) {
  const $ = selector => document.querySelector(selector)
  const shell = window.BezalelDashboardShell
  const forms = [$('#organization-form'), $('#profile-form'), $('#notifications-form')]
  let customer = null, version = 0, pending = false, saveTask = null
  const fields = form => [...form.querySelectorAll('input[name]')]
  const value = input => input.type === 'checkbox' ? input.checked : input.value.trim()
  function sync() {
    for (const form of forms) {
      const inputs = fields(form)
      form.querySelector('fieldset').disabled = pending || !customer
      form.querySelector('button[type=submit]').disabled = pending || !customer || inputs.every(input => value(input) === (customer[input.name] ?? (input.type === 'checkbox' ? false : '')))
    }
  }
  function render(value, savedField) {
    customer = value
    shell.paintSettings(customer, { authMode: getAuthMode(), only: savedField })
    $('#settings-content').hidden = false
    sync()
  }
  async function load() {
    const requestVersion = ++version
    pending = false
    $('#settings-error').textContent = ''
    $('#settings-retry').hidden = true
    for (const form of forms) { form.querySelector('footer [role=status]').textContent = ''; form.querySelector('button[type=submit]').textContent = 'Save changes' }
    // The session already carries this customer, so the page paints at once. A pending save is the
    // one case where the server holds newer values, so wait for it before showing anything.
    const known = saveTask ? null : getCustomer?.()
    if (known) render(known)
    else { customer = null; $('#settings-loading').hidden = false; $('#settings-content').hidden = true; sync() }
    try {
      await saveTask?.catch(() => {})
      if (version !== requestVersion) return
      const result = await rpc('getSettings')
      if (version !== requestVersion) return
      render(result.customer); onChange(result.customer)
    } catch (error) {
      if (version !== requestVersion) return
      $('#settings-error').textContent = settingsErrorMessage(error)
      $('#settings-retry').hidden = false
    } finally { if (version === requestVersion) $('#settings-loading').hidden = true }
  }
  for (const form of forms) {
    form.addEventListener('input', () => { form.querySelector('footer [role=status]').textContent = ''; sync() })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (pending || !customer) return
      const requestVersion = version, inputs = fields(form), name = form.id
      const button = form.querySelector('button[type=submit]'), status = form.querySelector('footer [role=status]')
      const input = inputs.find(input => input.type !== 'checkbox' && !value(input))
      if (input) { input.setCustomValidity('Enter a name.'); input.reportValidity(); input.setCustomValidity(''); return }
      pending = true; sync(); status.textContent = ''; $('#settings-error').textContent = ''
      button.textContent = 'Saving…'
      const task = rpc('updateSettings', Object.fromEntries(inputs.map(input => [input.name, value(input)])))
      saveTask = task
      try {
        const result = await task
        if (version !== requestVersion) return
        render(result.customer, name); onChange(result.customer)
        status.textContent = name === 'organization-form' ? 'Organization name saved.' : name === 'profile-form' ? 'Profile name saved.' : 'Notification preferences saved.'
      } catch (error) {
        if (version === requestVersion) $('#settings-error').textContent = settingsErrorMessage(error)
      } finally {
        if (saveTask === task) saveTask = null
        if (version === requestVersion) { pending = false; sync(); button.textContent = 'Save changes' }
      }
    })
  }
  const permissionStatus = shell.paintNotificationPermission
  $('#allow-notifications').addEventListener('click', async () => {
    try { await Notification.requestPermission(); permissionStatus() }
    catch { $('#desktop-permission').textContent = 'Enable notifications in your browser’s site settings.' }
  })
  window.addEventListener('focus', permissionStatus)
  $('#settings-retry').addEventListener('click', load)
  return {
    load,
    reset() {
      version++; customer = null; pending = false; saveTask = null
      for (const form of forms) { form.reset(); form.querySelector('button[type=submit]').textContent = 'Save changes'; form.querySelector('footer [role=status]').textContent = '' }
      $('#settings-error').textContent = ''; $('#settings-content').hidden = true
      $('#settings-loading').hidden = true; $('#settings-retry').hidden = true
      sync()
    },
  }
}
