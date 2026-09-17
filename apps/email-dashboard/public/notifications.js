export function createDesktopNotifications({ rpc, openInbox }) {
  let account = null, timer = null, generation = 0, busy = false, since = null
  let enabled = false
  const seen = new Set(), visible = new Set()
  function remember(ids) {
    for (const id of ids) seen.add(id)
    while (seen.size > 500) seen.delete(seen.values().next().value)
  }
  async function poll() {
    if (!account || !enabled || !since || busy || !('Notification' in window)) return
    const current = generation, key = `bezalel-notifications:${account}`
    busy = true
    try {
      const { notifications } = await rpc('getNotifications', { since })
      if (current !== generation) return
      if (Notification.permission !== 'granted') {
        remember(notifications.map(item => item.id))
        return
      }
      const show = () => {
        if (current !== generation) return
        let stored = []
        try { const value = JSON.parse(localStorage.getItem(key) ?? '[]'); if (Array.isArray(value)) stored = value } catch {}
        for (const id of stored) seen.add(id)
        const fresh = notifications.filter(item => !seen.has(item.id))
        if (!fresh.length) return
        const alert = new Notification('New mail in Bezalel Email', {
          body: fresh.length === 1 ? `New mail in ${fresh[0].inboxId}` : `${fresh.length} new messages in your inboxes`,
          tag: 'bezalel-new-mail',
        })
        visible.add(alert)
        alert.onclose = () => visible.delete(alert)
        alert.onclick = () => { if (current !== generation) return; window.focus(); openInbox(fresh[0].inboxId); alert.close() }
        remember(fresh.map(item => item.id))
        try { localStorage.setItem(key, JSON.stringify([...seen])) } catch {}
      }
      if (navigator.locks) await navigator.locks.request(key, show)
      else if (document.hasFocus()) show()
    } catch { /* A later poll retries temporary network or browser failures. */ }
    finally { if (current === generation) busy = false }
  }
  function reset() {
    generation++; clearInterval(timer); timer = null; account = null; busy = false; since = null; seen.clear()
    for (const alert of visible) alert.close()
    visible.clear()
  }
  return {
    start(customer) {
      if (!customer || (account === customer.id && enabled === customer.desktopNotifications)) return
      reset(); account = customer.id; enabled = customer.desktopNotifications === true; since = customer.notificationCursor ?? null
      timer = setInterval(poll, 30_000)
      void poll()
    },
    reset,
  }
}
