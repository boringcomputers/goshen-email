export function createDesktopNotifications({ rpc, openInbox }) {
  let account = null, timer = null, generation = 0, busy = false, initialized = false
  let enabled = false
  const seen = new Set(), visible = new Set()
  async function poll() {
    if (!account || !enabled || busy || !('Notification' in window) || Notification.permission !== 'granted') return
    const current = generation, key = `bezalel-notifications:${account}`
    busy = true
    try {
      const { notifications } = await rpc('getNotifications')
      if (current !== generation) return
      if (!initialized) {
        for (const item of notifications) seen.add(item.id)
        initialized = true
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
        for (const item of fresh) seen.add(item.id)
        const recent = [...seen].slice(-500)
        seen.clear(); for (const id of recent) seen.add(id)
        try { localStorage.setItem(key, JSON.stringify(recent)) } catch {}
      }
      if (navigator.locks) await navigator.locks.request(key, show)
      else if (document.hasFocus()) show()
    } catch { /* A later poll retries temporary network or browser failures. */ }
    finally { if (current === generation) busy = false }
  }
  function reset() {
    generation++; clearInterval(timer); timer = null; account = null; busy = false; initialized = false; seen.clear()
    for (const alert of visible) alert.close()
    visible.clear()
  }
  return {
    start(customer) {
      if (!customer || (account === customer.id && enabled === customer.desktopNotifications)) return
      reset(); account = customer.id; enabled = customer.desktopNotifications === true
      timer = setInterval(poll, 30_000)
      void poll()
    },
    reset,
  }
}
