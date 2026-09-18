export const staleApiMessage = 'The email API is running an older version without workspace settings. Deploy the latest API Worker, then try again.'
// The dashboard only sends operations it knows, so a 404 here means the deployed API predates this page.
export const settingsErrorMessage = error => error?.status === 404 ? staleApiMessage : error?.message || 'Settings request failed'

export function createSettingsPanel({ rpc, onChange, getAuthMode }) {
  const $ = selector => document.querySelector(selector)
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
    for (const form of forms) {
      for (const input of fields(form)) {
        if (!savedField || form.id === savedField) {
          if (input.type === 'checkbox') input.checked = customer[input.name] ?? false
          else input.value = customer[input.name] ?? ''
        }
      }
    }
    $('#settings-email').value = customer.email
    $('#notification-email').textContent = customer.email
    permissionStatus()
    $('#settings-sign-in-method').textContent = getAuthMode() === 'access'
      ? 'Sign in with an email code through Cloudflare Access.'
      : 'Sign in with an email link or a one-time code.'
    sync()
  }
  async function load() {
    const requestVersion = ++version
    pending = false; customer = null
    $('#settings-error').textContent = ''
    $('#settings-loading').hidden = false
    $('#settings-content').hidden = true
    $('#settings-retry').hidden = true
    for (const form of forms) { form.querySelector('footer [role=status]').textContent = ''; form.querySelector('button[type=submit]').textContent = 'Save changes' }
    sync()
    try {
      await saveTask?.catch(() => {})
      if (version !== requestVersion) return
      const result = await rpc('getSettings')
      if (version !== requestVersion) return
      render(result.customer); onChange(result.customer)
      $('#settings-content').hidden = false
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
  function permissionStatus() {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported'
    $('#desktop-permission').textContent = {
      granted: 'This browser can show desktop notifications.',
      denied: 'Notifications are blocked. Allow them in your browser’s site settings.',
      default: 'Allow notifications in this browser to receive desktop alerts.',
      unsupported: 'This browser does not support desktop notifications.',
    }[permission]
    $('#allow-notifications').hidden = permission !== 'default'
  }
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
