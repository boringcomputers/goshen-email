// Select the initial view before styles and the application module finish loading.
(() => {
  const titles = Object.freeze({ inboxes: 'Inboxes', mail: 'Inboxes', 'api-keys': 'API keys', integrations: 'Integrations', domains: 'Domains', setup: 'Get started', settings: 'Settings', 'native-mail': 'Bezalel inboxes' })
  function parse(hash) {
    let parts
    try { parts = hash.slice(2).split('/').map(decodeURIComponent) } catch { parts = [] }
    const requested = parts[0] || 'inboxes'
    const inboxId = requested === 'inboxes' ? parts[1] : undefined
    return { page: inboxId ? 'mail' : requested === 'mail' ? 'inboxes' : requested, inboxId }
  }
  window.BezalelDashboardRoutes = Object.freeze({ titles, parse })
  const { page } = parse(location.hash)
  const initial = Object.hasOwn(titles, page) ? page : 'inboxes'
  document.documentElement.dataset.initialPage = initial
  // dashboard-shell.js replaces this CSS-drawn title with the real text once the body exists.
  document.documentElement.dataset.initialTitle = ''
  document.documentElement.style.setProperty('--initial-page-title', JSON.stringify(titles[initial]))
  document.title = `${titles[initial]} · Bezalel Email`
})()
