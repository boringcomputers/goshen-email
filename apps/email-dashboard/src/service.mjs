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

export const customerOperations = new Set([...operations, 'session', 'listCustomers', 'inviteCustomer',
  'setCustomerAccess', 'getCredentials', 'rotateCredentials', 'finishInboxSetup', 'setupStatus', 'createApiKey', 'listApiKeys', 'revokeApiKey', 'getInbox', 'updateInbox'])

function rpcClient({ workerUrl, request = fetch, endpoint, allowed, authorize, transform = (_, input) => input }) {
  const base = new URL(workerUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('MAIL_WORKER_URL must be an HTTPS origin')
  return {
    async execute(operation, input, identityToken) {
      if (!allowed.has(operation)) throw new DashboardError('Unknown email operation', 404)
      const value = transform(operation, input)
      const authorization = authorize(identityToken)
      let response
      try {
        response = await request(new URL(`${endpoint}/${operation}`, base), {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
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

export function mailClient({ apiToken, ...options }) {
  if (!apiToken || apiToken.length < 32) throw new Error('MAIL_API_TOKEN must contain at least 32 characters')
  return rpcClient({ ...options, endpoint: '/rpc', allowed: operations, authorize: () => `Bearer ${apiToken}`,
    transform: (operation, input) => operation === 'releaseQuarantine'
      ? { ...input, reviewedBy: 'standalone-dashboard-owner' } : input })
}

export function customerMailClient(options) {
  return rpcClient({ ...options, endpoint: '/dashboard-rpc', allowed: customerOperations,
    authorize: (token) => {
      if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token))
        throw new DashboardError('Sign in to continue', 401)
      return `Bearer ${token}`
    } })
}
