export function createDeveloperPanel({ rpc, notify, getSession }) {
  const $ = selector => document.querySelector(selector)
  const dialog = $('#developer-dialog')
  let version = 0, listVersion = 0
  const element = (tag, text) => { const item = document.createElement(tag); item.textContent = text; return item }
  const current = value => dialog.open && version === value
  async function load() {
    const value = ++listVersion
    $('#api-keys-error').textContent = ''
    const { keys } = await rpc('listApiKeys')
    if (listVersion !== value) return
    const wrap = element('div', ''), table = element('table', ''), head = element('thead', ''), headings = element('tr', ''), body = element('tbody', '')
    wrap.className = 'resource-table-wrap'; table.className = 'resource-table'
    for (const label of ['Name', 'Key', 'Status', 'Expires', 'Actions']) headings.append(element('th', label))
    head.append(headings)
    for (const key of keys) {
      const row = element('tr', ''), copy = element('td', ''), prefix = element('td', ''), status = element('td', ''), expires = element('td', ''), actions = element('td', '')
      const expired = key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()
      copy.append(element('strong', key.name), element('small', key.scopes.join(', ')))
      prefix.append(element('code', `${key.prefix}…`))
      status.textContent = key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active'
      expires.textContent = key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'Never'
      if (!key.revokedAt && !expired) {
        const revoke = element('button', 'Revoke')
        revoke.setAttribute('aria-label', `Revoke ${key.name}`)
        revoke.addEventListener('click', async () => {
          if (!confirm(`Revoke ${key.name}? Any agent using it will lose access immediately.`)) return
          revoke.disabled = true
          try { await rpc('revokeApiKey', { keyId: key.keyId }); if (listVersion === value) { await load(); notify('API key revoked') } }
          catch (error) { if (listVersion === value) $('#api-keys-error').textContent = error.message }
          finally { revoke.disabled = false }
        })
        actions.append(revoke)
      }
      row.append(copy, prefix, status, expires, actions); body.append(row)
    }
    table.append(head, body); wrap.append(table)
    if (!keys.length) {
      const empty = element('div', ''); empty.className = 'resource-empty'
      empty.append(element('h2', 'No account API keys yet.'), element('p', 'Create a key to connect your first agent.'))
      wrap.append(empty)
    }
    $('#developer-key-list').replaceChildren(wrap)
  }
  function configure() {
    const base = getSession()?.apiUrl
    $('#developer-base-url').textContent = base || 'API URL is not configured'
    $('#developer-mcp-url').textContent = base ? `${base}/mcp` : 'MCP URL is not configured'
    if (base) $('#developer-api-docs').href = `${base}/openapi.json`
    else $('#developer-api-docs').removeAttribute('href')
  }
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
