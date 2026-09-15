export const operations = new Set([
  'listInboxes', 'createInbox', 'deleteInbox', 'inboxQuota', 'listMessages', 'getMessage',
  'listThreads', 'getThread', 'reviewThread', 'searchMessages', 'send', 'reply',
  'updateMessageLabels', 'updateThreadLabels', 'getAttachment', 'releaseQuarantine',
  'listDomains', 'createDomain', 'verifyDomain', 'deleteDomain',
])

export class DashboardError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function mailClient({ workerUrl, apiToken, request = fetch }) {
  const base = new URL(workerUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('MAIL_WORKER_URL must be an HTTPS origin')
  if (!apiToken || apiToken.length < 32) throw new Error('MAIL_API_TOKEN must contain at least 32 characters')
  return {
    async execute(operation, input) {
      if (!operations.has(operation)) throw new DashboardError('Unknown email operation', 404)
      const value = operation === 'releaseQuarantine'
        ? { ...input, reviewedBy: 'standalone-dashboard-owner' }
        : input
      let response
      try {
        response = await request(new URL(`/rpc/${operation}`, base), {
          method: 'POST',
          headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(value), redirect: 'manual', signal: AbortSignal.timeout(45_000),
        })
      } catch {
        throw new DashboardError('The email service did not respond. For sends, retry the same draft to preserve its request ID.', 502)
      }
      let body
      try { body = await response.json() } catch {
        throw new DashboardError('The email service returned an unreadable response. For sends, retry the same draft.', 502)
      }
      if (!response.ok) {
        const message = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 1000) : 'The email request failed'
        throw new DashboardError(message, response.status >= 400 && response.status <= 599 ? response.status : 502)
      }
      if (!body || !Object.hasOwn(body, 'result')) throw new DashboardError('The email response has no result', 502)
      return body.result
    },
  }
}
