export function createDeveloperPanel({ rpc, notify, getSession }) {
  const $ = selector => document.querySelector(selector)
  const dialog = $('#developer-dialog')
  let version = 0
  const element = (tag, text) => { const item = document.createElement(tag); item.textContent = text; return item }
  const current = value => dialog.open && version === value
  async function load(value) {
    const { keys } = await rpc('listApiKeys')
    if (!current(value)) return
    $('#developer-key-list').replaceChildren(...keys.map(key => {
      const row = element('section', ''), copy = element('div', '')
      row.className = 'domain-card developer-key-row'
      const expired = key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()
      copy.append(element('strong', key.name), element('p', `${key.prefix}… · ${key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active'}`), element('small', key.scopes.join(', ')))
      row.append(copy)
      if (!key.revokedAt && !expired) {
        const revoke = element('button', 'Revoke')
        revoke.setAttribute('aria-label', `Revoke ${key.name}`)
        revoke.addEventListener('click', async () => {
          if (!confirm(`Revoke ${key.name}? Any agent using it will lose access immediately.`)) return
          revoke.disabled = true
          try { await rpc('revokeApiKey', { keyId: key.keyId }); if (current(value)) { await load(value); notify('API key revoked') } }
          catch (error) { if (current(value)) $('#developer-error').textContent = error.message }
          finally { revoke.disabled = false }
        })
        row.append(revoke)
      }
      return row
    }))
    if (!keys.length) $('#developer-key-list').append(element('p', 'No account API keys yet.'))
  }
  $('#developers').addEventListener('click', async () => {
    const value = ++version, base = getSession()?.apiUrl
    $('#developer-error').textContent = ''; $('#developer-key-list').replaceChildren(); $('#developer-created').hidden = true
    $('#developer-token').value = ''
    $('#developer-base-url').textContent = base || 'API URL is not configured'
    if (base) { $('#developer-api-docs').href = `${base}/openapi.json`; $('#developer-mcp-url').textContent = `${base}/mcp` }
    dialog.showModal()
    try { await load(value) } catch (error) { if (current(value)) $('#developer-error').textContent = error.message }
  })
  $('#developer-form').addEventListener('submit', async event => {
    event.preventDefault()
    const value = version, button = $('#developer-create'), form = event.currentTarget
    button.disabled = true; $('#developer-error').textContent = ''; $('#developer-token').value = ''; $('#developer-created').hidden = true
    try {
      const data = new FormData(form)
      const result = await rpc('createApiKey', { name: data.get('name'), scopes: data.getAll('scope'), expiresInDays: Number(data.get('expiresInDays')) })
      if (!current(value)) return
      $('#developer-token').value = result.apiKey; $('#developer-created').hidden = false
      await load(value)
    } catch (error) { if (current(value)) $('#developer-error').textContent = error.message }
    finally { button.disabled = false }
  })
  $('#developer-copy').addEventListener('click', async () => {
    try { if ($('#developer-token').value) { await navigator.clipboard.writeText($('#developer-token').value); notify('API key copied') } }
    catch { $('#developer-error').textContent = 'Clipboard access failed. Select and copy the key manually.' }
  })
  const reset = () => { version++; $('#developer-token').value = ''; $('#developer-created').hidden = true; $('#developer-key-list').replaceChildren(); $('#developer-form').reset() }
  dialog.addEventListener('close', reset)
  return { reset }
}
