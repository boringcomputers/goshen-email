export const operations = new Set([
  'listInboxes', 'createInbox', 'deleteInbox', 'inboxQuota', 'listMessages', 'getMessage',
  'listThreads', 'getThread', 'reviewThread', 'searchMessages', 'send', 'reply',
  'updateMessageLabels', 'updateThreadLabels', 'getAttachment', 'releaseQuarantine',
  'listDomains', 'createDomain', 'verifyDomain', 'deleteDomain',
])

export class DashboardError extends Error {
  constructor(message, status = 400, code) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

export const customerOperations = new Set([...operations, 'session', 'getSettings', 'updateSettings', 'getNotifications', 'listCustomers', 'inviteCustomer',
  'setCustomerAccess', 'getCredentials', 'rotateCredentials', 'finishInboxSetup', 'setupStatus', 'createApiKey', 'listApiKeys', 'revokeApiKey', 'getInbox', 'updateInbox',
  'getUsage', 'startCheckout', 'openBillingPortal'])

export const nativeReadOperations = new Set([
  'listInboxes', 'listMessages', 'getMessage', 'listThreads', 'getThread', 'searchMessages', 'getAttachment',
])

export function nativeMailClient({ workerUrl, apiToken, adminEmails = '', request }) {
  if (!apiToken || !adminEmails.trim()) return undefined
  if (apiToken.length < 32) throw new Error('NATIVE_MAIL_API_TOKEN must contain at least 32 characters')
  const admins = new Set(adminEmails.split(',').map(email => email.trim().toLowerCase()).filter(Boolean))
  const client = rpcClient({ workerUrl, request, endpoint: '/rpc', allowed: nativeReadOperations,
    authorize: () => `Bearer ${apiToken}`, setting: 'NATIVE_MAIL_WORKER_URL' })
  const origin = new URL(workerUrl).origin
  return {
    async execute(operation, input, identityToken) {
      const result = await client.execute(operation, input, identityToken)
      // The browser opens attachment links directly, so they must point back at the configured
      // native Worker. The dashboard knows that origin; the browser does not.
      if (operation === 'getAttachment' && !attachmentUrl(result?.downloadUrl, origin))
        throw new DashboardError('The native mail service returned an invalid attachment URL', 502)
      return result
    },
    permits: customer => customer?.role === 'admin' && typeof customer.email === 'string' && admins.has(customer.email.toLowerCase()),
  }
}

function attachmentUrl(value, origin) {
  let url
  try { url = new URL(value) } catch { return false }
  return url.origin === origin && url.pathname.startsWith('/attachments/') && !url.username && !url.password
}

function rpcClient({ workerUrl, request = fetch, endpoint, allowed, authorize, transform = (_, input) => input, setting = 'MAIL_WORKER_URL' }) {
  let base
  try { base = new URL(workerUrl) } catch { throw new Error(`${setting} must be an HTTPS origin`) }
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error(`${setting} must be an HTTPS origin`)
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
        const code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 100) : undefined
        throw new DashboardError(message, response.status >= 400 && response.status <= 599 ? response.status : 502, code)
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
