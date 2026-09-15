export function workerClient(config, request = fetch) {
  return {
    async delivery(event) {
      const response = await request(new URL('/gateway/delivery', config.workerUrl), {
        method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(event), redirect: 'error', signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error('Worker delivery tracking unavailable')
      const result = await response.json()
      if (!['updated', 'ignored'].includes(result.result)) throw new Error('Worker delivery tracking receipt unreadable')
    },
    async allowed(kind, value) {
      if (!['domain', 'recipient'].includes(kind)) return false
      const url = new URL(`/gateway/${kind}`, config.workerUrl)
      url.searchParams.set('value', value.toLowerCase())
      const response = await request(url, {
        headers: { authorization: `Bearer ${config.token}` },
        redirect: 'error', signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error('Worker lookup unavailable')
      const data = await response.json()
      if (typeof data.allowed !== 'boolean') throw new Error('Invalid lookup response')
      return data.allowed
    },
    async receive(recipient, raw, protection) {
      const response = await request(new URL('/gateway/receive', config.workerUrl), {
        method: 'POST', headers: { authorization: `Bearer ${config.token}`,
          'content-type': 'message/rfc822', 'x-bezalel-recipient': recipient,
          ...(protection ? { 'x-bezalel-protection': JSON.stringify(protection) } : {}) },
        body: raw, redirect: 'error', signal: AbortSignal.timeout(60000),
      })
      if ([404, 422].includes(response.status)) return 'rejected'
      if (!response.ok) throw new Error('Worker delivery unavailable')
      const result = await response.json()
      if (typeof result.messageId !== 'string') throw new Error('Worker receipt unreadable')
      return 'delivered'
    },
  }
}
