// Site header on the landing and docs pages: a signed-in visitor sees their account menu and a
// dashboard link where "Log in" and "Get started" sit for everyone else.
//
// The session cookie is HttpOnly, so this script relies on the workspace marker cookie the server
// issues with every authenticated session read (see workspaceCookie in src/handler.mjs). Without
// the marker the links stay and nothing is requested, so anonymous visits cost no backend call.
// With it, the account saved by the dashboard paints at once and /api/session confirms it; an ended
// session removes the menu again. The marker and the saved account grant nothing on their own.
(() => {
  const actions = document.querySelector('.nav-actions')
  const links = actions ? [...actions.querySelectorAll('a')] : []
  if (!actions || !links.length) return
  const storageKey = 'bezalel.dashboard.snapshot'
  const hasMarker = () => document.cookie.split('; ').some(part => /^(__Host-)?workspace=./.test(part))
  const savedSession = () => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey))
      return value && value.version === 1 && value.session ? value.session : null
    } catch { return null }
  }
  const forgetSaved = () => { try { localStorage.removeItem(storageKey) } catch {} }
  const node = (tag, text, className) => {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    if (className) element.className = className
    return element
  }
  const initials = value => value.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'B'
  const chevron = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'site-account-chevron' })) svg.setAttribute(key, value)
    svg.innerHTML = '<path d="M4 6l4 4 4-4"/>'
    return svg
  }

  let menu, dashboard
  function paint(session) {
    const customer = session.customer
    const name = customer?.displayName || customer?.email || 'Your workspace'
    const detail = customer ? customer.email : 'Owner'
    if (!menu) {
      dashboard = node('a', undefined, 'site-header-start-free')
      dashboard.href = '/app'; dashboard.id = 'site-dashboard-link'
      dashboard.append(node('span', 'Open dashboard', 'site-header-start-free-2'))
      menu = node('details', undefined, 'site-account-menu'); menu.id = 'site-account-menu'
      const summary = node('summary'); summary.id = 'site-account-button'
      const avatar = node('span', undefined, 'site-avatar'); avatar.setAttribute('aria-hidden', 'true')
      summary.append(avatar, node('span', undefined, 'site-account-name'), chevron())
      const popover = node('div', undefined, 'site-account-popover')
      const identity = node('div', undefined, 'site-account-identity')
      identity.append(node('strong'), node('p'))
      const settings = node('a', 'Settings'); settings.href = '/app#/settings'; settings.id = 'site-account-settings'
      const logout = node('button', 'Sign out'); logout.type = 'button'; logout.id = 'site-logout'
      logout.addEventListener('click', signOut)
      popover.append(identity, settings, logout)
      menu.append(summary, popover)
      for (const link of links) link.hidden = true
      actions.append(dashboard, menu)
    }
    menu.querySelector('.site-avatar').textContent = initials(name)
    menu.querySelector('.site-account-name').textContent = name
    menu.querySelector('#site-account-button').setAttribute('aria-label', `Account menu for ${name}`)
    menu.querySelector('.site-account-identity strong').textContent = name
    menu.querySelector('.site-account-identity p').textContent = detail
    menu.querySelector('#site-account-settings').hidden = !customer
  }
  function clear() {
    menu?.remove(); dashboard?.remove(); menu = dashboard = undefined
    for (const link of links) link.hidden = false
  }
  async function signOut() {
    const button = menu.querySelector('#site-logout')
    button.disabled = true
    let logoutUrl
    try {
      const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!response.ok && response.status !== 401) throw new Error()
      logoutUrl = (await response.json()).logoutUrl
    } catch {
      button.disabled = false
      button.textContent = 'Sign out failed. Try again.'
      return
    }
    forgetSaved()
    try { new BroadcastChannel('bezalel-account').postMessage('signed-out') } catch {}
    clear()
    // Cloudflare Access sessions end at Access, not here.
    if (logoutUrl === '/cdn-cgi/access/logout') location.assign(logoutUrl)
  }
  document.addEventListener('click', event => { if (menu?.open && !menu.contains(event.target)) menu.open = false })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.open) { menu.open = false; menu.querySelector('summary').focus() }
  })

  if (!hasMarker()) return
  const saved = savedSession()
  if (saved) paint(saved)
  fetch('/api/session', { credentials: 'same-origin' })
    .then(response => response.json())
    .then(session => { if (session.authenticated) paint(session); else { forgetSaved(); clear() } })
    .catch(() => {})
})()
