import { allocatedFeatures, billingFeatures, type BillingFeature } from "../src/billing.js"

/**
 * In-memory stand-in for the Autumn REST API. It is not Autumn: it models the
 * five calls the Worker makes and the balance arithmetic the tests depend on.
 */
export interface FakeAutumnOptions { included?: Partial<Record<BillingFeature, number>> }
export function fakeAutumn(options: FakeAutumnOptions = {}) {
  const included: Record<string, number> = { [billingFeatures.inboxes]: 2, [billingFeatures.sends]: 2, [billingFeatures.triage]: 1, ...options.included }
  const customers = new Map<string, { email: string; name?: string; granted: Record<string, number>; usage: Record<string, number>; held: Record<string, number> }>()
  const events = new Map<string, number>()
  const locks = new Map<string, { customerId: string; feature: string; expiresAt: number }>()
  const state = { down: false, calls: [] as string[], checkouts: [] as { customerId: string; planId: string }[], finalized: [] as string[] }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const customerView = (id: string) => {
    const c = customers.get(id)!
    return {
      id, email: c.email, name: c.name ?? null,
      subscriptions: [{ plan_id: "free", status: "active", current_period_end: Date.UTC(2026, 9, 1), canceled_at: null }],
      balances: Object.fromEntries(Object.keys(c.granted).map(feature => [feature, balance(id, feature)])),
    }
  }
  // Held units are unavailable to other requests but not yet usage.
  const balance = (id: string, feature: string) => {
    const c = customers.get(id)!
    if (!(feature in c.granted)) return null
    const usage = c.usage[feature] ?? 0, held = c.held[feature] ?? 0
    return { feature_id: feature, granted: c.granted[feature], usage, remaining: c.granted[feature]! - usage - held, unlimited: false, next_reset_at: Date.UTC(2026, 9, 1) }
  }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.replace(/^\/v1\//, "")
    state.calls.push(path)
    if (state.down) return json({ code: "internal_error", message: "boom" }, 500)
    if (init?.method !== "POST" || (init.headers as Record<string, string>).authorization !== "Bearer am_sk_test_fixture") return json({ code: "unauthorized" }, 401)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    const id = String(body.customer_id)
    if (path === "customers.get_or_create") {
      if (!customers.has(id)) customers.set(id, { email: String(body.email), ...(body.name ? { name: String(body.name) } : {}), granted: { ...included }, usage: {}, held: {} })
      return json(customerView(id))
    }
    if (path === "balances.finalize") {
      const lock = locks.get(String(body.lock_id))
      if (!lock) return json({ code: "lock_not_found", message: "Lock not found" }, 404)
      locks.delete(String(body.lock_id))
      state.finalized.push(`${body.action}:${lock.feature}`)
      const c = customers.get(lock.customerId)!
      c.held[lock.feature] = (c.held[lock.feature] ?? 0) - 1
      if (body.action === "confirm") c.usage[lock.feature] = (c.usage[lock.feature] ?? 0) + 1
      return json({ success: true })
    }
    if (!customers.has(id)) return json({ code: "customer_not_found", message: "Customer not found" }, 404)
    if (path === "balances.check") {
      const feature = String(body.feature_id), current = balance(id, feature)
      const required = typeof body.required_balance === "number" ? body.required_balance : 1
      const allowed = current ? current.remaining >= required : false
      const lock = body.lock as { enabled?: boolean; lock_id?: string; expires_at?: number } | undefined
      if (allowed && body.send_event) {
        const c = customers.get(id)!
        if (lock?.enabled) {
          // Autumn refuses locks on allocated features; only consumable balances can be held.
          if (allocatedFeatures.has(feature as BillingFeature)) return json({ code: "invalid_request", message: "Lock is not supported for allocated features" }, 400)
          if (!lock.lock_id || typeof lock.expires_at !== "number" || lock.expires_at <= Date.now() || lock.expires_at > Date.now() + 86_400_000) return json({ code: "invalid_request", message: "Lock expires_at cannot be more than 1 day from now" }, 400)
          locks.set(lock.lock_id, { customerId: id, feature, expiresAt: lock.expires_at })
          c.held[feature] = (c.held[feature] ?? 0) + required
        } else c.usage[feature] = (c.usage[feature] ?? 0) + required
      }
      return json({ allowed, customer_id: id, feature_id: feature, required_balance: required, balance: balance(id, feature) })
    }
    if (path === "balances.track") {
      const key = String(body.idempotency_key), value = typeof body.value === "number" ? body.value : 1
      if (events.has(key)) return json({ code: "duplicate_event", message: "Already recorded" }, 409)
      events.set(key, value)
      const c = customers.get(id)!, feature = String(body.feature_id)
      c.usage[feature] = (c.usage[feature] ?? 0) + value
      return json({ customer_id: id, feature_id: feature, balance: balance(id, feature) })
    }
    if (path === "billing.attach") {
      state.checkouts.push({ customerId: id, planId: String(body.plan_id) })
      return json({ customer_id: id, payment_url: `https://checkout.stripe.test/${body.plan_id}`, required_action: null })
    }
    if (path === "billing.open_customer_portal") return json({ customer_id: id, url: `https://billing.stripe.test/session/${id}` })
    return json({ code: "not_found" }, 404)
  }
  return {
    request, state, events,
    usage: (id: string, feature: BillingFeature) => customers.get(id)?.usage[feature] ?? 0,
    held: (id: string, feature: BillingFeature) => customers.get(id)?.held[feature] ?? 0,
    openLocks: () => locks.size,
    grant: (id: string, feature: BillingFeature, granted: number) => { customers.get(id)!.granted[feature] = granted },
    has: (id: string) => customers.has(id),
  }
}
