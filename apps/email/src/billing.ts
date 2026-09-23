import { z } from "zod"
import { MailError } from "./contracts.js"
import { readBytes } from "./security.js"

/**
 * Feature ids shared with ops/autumn/autumn.config.ts. The Worker meters
 * inboxes, sends, and triage. Custom domains, storage, and seats are declared
 * for the plans but not yet enforced; see docs/pricing.md.
 */
export const billingFeatures = {
  inboxes: "inboxes",
  sends: "sends",
  triage: "triage",
  customDomains: "custom_domains",
  storage: "storage_mb",
  seats: "seats",
} as const
export type BillingFeature = typeof billingFeatures[keyof typeof billingFeatures]
export const billingPlans = ["free", "developer", "team"] as const
export type BillingPlan = typeof billingPlans[number]

export interface BillingCustomer { id: string; email: string; name?: string }
export interface FeatureBalance {
  feature: string
  granted: number | null
  used: number
  remaining: number | null
  unlimited: boolean
  resetsAt: string | null
}
export interface BillingAccess { allowed: boolean; balance: FeatureBalance | null }
export interface BillingSubscription { planId: string; status: string; currentPeriodEnd: string | null; canceledAt: string | null }
export interface BillingUsage { subscriptions: BillingSubscription[]; balances: FeatureBalance[] }
/**
 * A unit of a feature taken for one in-flight action. Confirm it when the action
 * commits, release it otherwise. Consumable features (sends, triage) use an Autumn
 * balance lock. Allocated features (inboxes, domains) cannot be locked, so their
 * unit is consumed at once and released by an idempotent negative usage event.
 */
export type BillingHold = { feature: BillingFeature; customer: BillingCustomer } & ({ lockId: string } | { refundKey: string })
/** Features Autumn treats as allocated rather than consumable. Must match `consumable: false` in ops/autumn/autumn.config.ts. */
export const allocatedFeatures: ReadonlySet<BillingFeature> = new Set([billingFeatures.inboxes, billingFeatures.customDomains, billingFeatures.storage, billingFeatures.seats])

/** Reusable billing mechanics. Policy (who is exempt, which feature gates what) lives in metering.ts. */
export interface BillingProvider {
  /**
   * Checks and, when allowed, takes one unit atomically. Concurrent callers cannot both pass on the last unit.
   * Consumable features are held under a lock until finalize() or expiry; allocated features are consumed and refunded on release.
   */
  hold(customer: BillingCustomer, feature: BillingFeature): Promise<BillingAccess & { hold: BillingHold | null }>
  finalize(hold: BillingHold, action: "confirm" | "release"): Promise<void>
  track(customer: BillingCustomer, feature: BillingFeature, value: number, idempotencyKey: string): Promise<void>
  usage(customer: BillingCustomer): Promise<BillingUsage>
  checkout(customer: BillingCustomer, planId: BillingPlan, successUrl?: string): Promise<{ paymentUrl: string | null }>
  /** A hosted page where the customer manages payment, top-up quantities, and cancellation. */
  portal(customer: BillingCustomer, returnUrl?: string): Promise<{ url: string }>
}
/** Holds release themselves after this long if the Worker never finalizes them. */
export const holdLifetimeMs = 10 * 60 * 1000

const unavailable = () => new MailError("Billing is temporarily unavailable. Retry shortly.", "billing_unavailable", 503, true)
const optionalNumber = z.number().nullable().optional()
const balance = z.object({
  feature_id: z.string(),
  granted: optionalNumber,
  remaining: optionalNumber,
  usage: optionalNumber,
  unlimited: z.boolean().optional(),
  next_reset_at: optionalNumber,
}).loose()
const checkResponse = z.object({ allowed: z.boolean(), balance: balance.nullable().optional() }).loose()
const customerResponse = z.object({
  subscriptions: z.array(z.object({ plan_id: z.string(), status: z.string(), current_period_end: optionalNumber, canceled_at: optionalNumber }).loose()).default([]),
  balances: z.record(z.string(), balance.nullable()).default({}),
}).loose()
const attachResponse = z.object({ payment_url: z.string().nullable().optional() }).loose()
const portalResponse = z.object({ url: z.string() }).loose()
const errorResponse = z.object({ code: z.string().optional(), message: z.string().optional() }).loose()

const epoch = (value: number | null | undefined) => value == null ? null : new Date(value).toISOString()
const balanceView = (value: z.infer<typeof balance>): FeatureBalance => ({
  feature: value.feature_id,
  granted: value.unlimited ? null : value.granted ?? null,
  used: value.usage ?? 0,
  remaining: value.unlimited ? null : value.remaining ?? null,
  unlimited: value.unlimited ?? false,
  resetsAt: epoch(value.next_reset_at),
})

/**
 * Autumn REST client. Autumn sits between the Worker and Stripe: it holds plan
 * definitions and balances, and the Worker asks it before metered actions.
 * The secret key never leaves the Worker.
 */
export function autumnBilling(secretKey: string, request: typeof fetch = fetch, baseUrl = "https://api.useautumn.com/v1"): BillingProvider {
  const call = async <T>(path: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    let response: Response
    try {
      response = await request(`${baseUrl}/${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json", "x-api-version": "2.4.0" },
        body: JSON.stringify(body),
      })
    } catch { throw unavailable() }
    let bytes: Uint8Array
    try { bytes = await readBytes(response.body, 512 * 1024) } catch { throw unavailable() }
    let json: unknown
    try { json = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw unavailable() }
    if (!response.ok) {
      const error = errorResponse.safeParse(json)
      // Only the code leaves this module; provider messages are not shown to customers.
      throw new AutumnError(response.status, error.success ? error.data.code ?? "" : "")
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw unavailable()
    return parsed.data
  }
  const identity = (customer: BillingCustomer) => ({ customer_id: customer.id, customer_data: { email: customer.email, ...(customer.name ? { name: customer.name } : {}) } })
  const ensureCustomer = (customer: BillingCustomer) =>
    call("customers.get_or_create", { customer_id: customer.id, email: customer.email, ...(customer.name ? { name: customer.name } : {}) }, customerResponse)
  /** Customers are created lazily: the first metered action creates the Autumn record on its default plan. */
  const withCustomer = async <T>(customer: BillingCustomer, task: () => Promise<T>): Promise<T> => {
    try { return await task() }
    catch (error) {
      if (!(error instanceof AutumnError)) throw error
      if (error.status === 404 || error.code === "customer_not_found") {
        await ensureCustomer(customer).catch(failWith)
        try { return await task() } catch (retry) { throw rethrow(retry) }
      }
      throw rethrow(error)
    }
  }
  const check = async (customer: BillingCustomer, feature: BillingFeature, extra: Record<string, unknown>) => {
    const result = await withCustomer(customer, () => call("balances.check", { ...identity(customer), feature_id: feature, required_balance: 1, ...extra }, checkResponse))
    return { allowed: result.allowed, balance: result.balance ? balanceView(result.balance) : null }
  }
  return {
    async hold(customer, feature) {
      const id = crypto.randomUUID()
      if (allocatedFeatures.has(feature)) {
        const access = await check(customer, feature, { send_event: true })
        return { ...access, hold: access.allowed ? { feature, customer, refundKey: `refund:${id}` } : null }
      }
      const access = await check(customer, feature, { send_event: true, lock: { enabled: true, lock_id: id, expires_at: Date.now() + holdLifetimeMs } })
      return { ...access, hold: access.allowed ? { feature, customer, lockId: id } : null }
    },
    async finalize(hold, action) {
      if ("lockId" in hold) { await call("balances.finalize", { lock_id: hold.lockId, action }, z.unknown()).catch(failWith); return }
      // The unit was consumed when it was taken; confirming changes nothing and releasing gives it back.
      if (action === "release") await this.track(hold.customer, hold.feature, -1, hold.refundKey)
    },
    async track(customer, feature, value, idempotencyKey) {
      try {
        await withCustomer(customer, () => call("balances.track", { ...identity(customer), feature_id: feature, value, idempotency_key: idempotencyKey }, z.unknown()))
      } catch (error) {
        // A repeated idempotency key means the usage is already recorded.
        if (!(error instanceof MailError && error.code === "billing_duplicate")) throw error
      }
    },
    async usage(customer) {
      const result = await ensureCustomer(customer).catch(failWith)
      return {
        subscriptions: result.subscriptions.map(s => ({ planId: s.plan_id, status: s.status, currentPeriodEnd: epoch(s.current_period_end), canceledAt: epoch(s.canceled_at) })),
        balances: Object.values(result.balances).filter((b): b is z.infer<typeof balance> => b !== null).map(balanceView),
      }
    },
    async checkout(customer, planId, successUrl) {
      const result = await withCustomer(customer, () => call("billing.attach", {
        ...identity(customer), plan_id: planId, redirect_mode: "always", ...(successUrl ? { success_url: successUrl } : {}),
      }, attachResponse))
      return { paymentUrl: result.payment_url ?? null }
    },
    async portal(customer, returnUrl) {
      const result = await withCustomer(customer, () => call("billing.open_customer_portal", { customer_id: customer.id, ...(returnUrl ? { return_url: returnUrl } : {}) }, portalResponse))
      return { url: result.url }
    },
  }
}

class AutumnError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code || `autumn_${status}`) }
}
/** Provider failures become one retriable Worker error. Duplicate idempotency keys are already-recorded usage, not failures. */
const rethrow = (error: unknown): MailError => {
  if (error instanceof MailError) return error
  if (error instanceof AutumnError && error.status === 409) return new MailError("Usage already recorded", "billing_duplicate", 409)
  return unavailable()
}
const failWith = (error: unknown): never => { throw rethrow(error) }
