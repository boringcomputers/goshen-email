export function createSettingsPanel({ rpc, onChange, getAuthMode }) {
  const $ = selector => document.querySelector(selector)
  const forms = [$('#organization-form'), $('#profile-form')]
  let customer = null, version = 0, pending = false, saveTask = null
  const field = form => form.querySelector('input[name]')
  function sync() {
    for (const form of forms) {
      const input = field(form)
      form.querySelector('fieldset').disabled = pending || !customer
      form.querySelector('button[type=submit]').disabled = pending || !customer || input.value.trim() === (customer[input.name] ?? '')
    }
  }
  function render(value, savedField) {
    customer = value
    for (const form of forms) {
      const input = field(form)
      if (!savedField || input.name === savedField) input.value = customer[input.name] ?? ''
    }
    $('#settings-email').value = customer.email
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
    for (const form of forms) { form.querySelector('[role=status]').textContent = ''; form.querySelector('button[type=submit]').textContent = 'Save changes' }
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
      $('#settings-error').textContent = error.message
      $('#settings-retry').hidden = false
    } finally { if (version === requestVersion) $('#settings-loading').hidden = true }
  }
  for (const form of forms) {
    form.addEventListener('input', () => { form.querySelector('[role=status]').textContent = ''; sync() })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (pending || !customer) return
      const requestVersion = version, input = field(form), name = input.name
      const button = form.querySelector('button[type=submit]'), status = form.querySelector('[role=status]')
      const value = input.value.trim()
      if (!value) { input.setCustomValidity('Enter a name.'); input.reportValidity(); input.setCustomValidity(''); return }
      pending = true; sync(); status.textContent = ''; $('#settings-error').textContent = ''
      button.textContent = 'Saving…'
      const task = rpc('updateSettings', { [name]: value })
      saveTask = task
      try {
        const result = await task
        if (version !== requestVersion) return
        render(result.customer, name); onChange(result.customer)
        status.textContent = name === 'organizationName' ? 'Organization name saved.' : 'Profile name saved.'
      } catch (error) {
        if (version === requestVersion) $('#settings-error').textContent = error.message
      } finally {
        if (saveTask === task) saveTask = null
        if (version === requestVersion) { pending = false; sync(); button.textContent = 'Save changes' }
      }
    })
  }
  $('#settings-retry').addEventListener('click', load)
  return {
    load,
    reset() {
      version++; customer = null; pending = false; saveTask = null
      for (const form of forms) { form.reset(); form.querySelector('button[type=submit]').textContent = 'Save changes'; form.querySelector('[role=status]').textContent = '' }
      $('#settings-error').textContent = ''; $('#settings-content').hidden = true
      $('#settings-loading').hidden = true; $('#settings-retry').hidden = true
      sync()
    },
  }
}
