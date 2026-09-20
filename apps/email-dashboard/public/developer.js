export function createDeveloperPanel({ rpc, notify, getSession, remember }) {
  const $ = selector => document.querySelector(selector)
  const shell = window.BezalelDashboardShell
  const dialog = $('#developer-dialog')
  let version = 0, listVersion = 0
  const current = value => dialog.open && version === value
  async function load() {
    const value = ++listVersion
    $('#api-keys-error').textContent = ''
    const { keys } = await rpc('listApiKeys')
    if (listVersion !== value) return
    remember?.(keys)
    shell.paintApiKeys(keys)
    for (const revoke of $('#developer-key-list').querySelectorAll('[data-key-id]')) {
      revoke.addEventListener('click', async () => {
        if (!confirm(`Revoke ${revoke.dataset.keyName}? Any agent using it will lose access immediately.`)) return
        revoke.disabled = true
        try { await rpc('revokeApiKey', { keyId: revoke.dataset.keyId }); if (listVersion === value) { await load(); notify('API key revoked') } }
        catch (error) { if (listVersion === value) $('#api-keys-error').textContent = error.message }
        finally { revoke.disabled = false }
      })
    }
  }
  const configure = () => shell.paintIntegrations(getSession()?.apiUrl)
  $('#new-api-key').addEventListener('click', () => {
    version++
    $('#developer-error').textContent = ''; $('#developer-created').hidden = true
    $('#developer-token').value = ''
    $('#developer-form').hidden = false; $('#developer-form').reset()
    dialog.showModal()
  })
  $('#developer-form').addEventListener('submit', async event => {
    event.preventDefault()
    const value = version, button = $('#developer-create'), form = event.currentTarget
    button.disabled = true; $('#developer-error').textContent = ''; $('#developer-token').value = ''; $('#developer-created').hidden = true
    try {
      const data = new FormData(form)
      const result = await rpc('createApiKey', { name: data.get('name'), scopes: data.getAll('scope'), expiresInDays: Number(data.get('expiresInDays')) })
      if (!current(value)) return
      $('#developer-token').value = result.apiKey; $('#developer-created').hidden = false; form.hidden = true
      $('#developer-copy').focus()
      try { await load() } catch { $('#api-keys-error').textContent = 'Key created. Reopen API keys to refresh the list.' }
    } catch (error) { if (current(value)) $('#developer-error').textContent = error.message }
    finally { button.disabled = false }
  })
  $('#developer-copy').addEventListener('click', async () => {
    try { if ($('#developer-token').value) { await navigator.clipboard.writeText($('#developer-token').value); notify('API key copied') } }
    catch { $('#developer-error').textContent = 'Clipboard access failed. Select and copy the key manually.' }
  })
  const clearSecret = () => { version++; $('#developer-token').value = ''; $('#developer-created').hidden = true; $('#developer-form').reset(); $('#developer-form').hidden = false }
  dialog.addEventListener('close', clearSecret)
  return { load, configure, reset() { listVersion++; clearSecret(); $('#developer-key-list').replaceChildren() } }
}
