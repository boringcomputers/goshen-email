import { billingFeatures, billingPlans, type BillingCustomer, type BillingHold, type BillingPlan, type BillingProvider, type BillingUsage } from "./billing.js"
import { MailError } from "./contracts.js"

/**
 * Decides when a metered action may proceed and settles it afterwards.
 * Holds make the check and the deduction one atomic step, so two requests
 * cannot both pass on the last unit. Platform administrators are exempt. The
 * daily per-inbox send limit stays in SQL as an abuse backstop regardless of plan.
 */
export class Metering {
  constructor(readonly billing: BillingProvider, readonly exemptEmails: string[]) {}

  exempt(customer: BillingCustomer): boolean {
    return this.exemptEmails.includes(customer.email.toLowerCase())
  }

  /** Holds one unit, or throws billing_limit. Returns null for exempt accounts, which have nothing to settle. */
  private async hold(customer: BillingCustomer, feature: keyof typeof billingFeatures, denied: string): Promise<BillingHold | null> {
    if (this.exempt(customer)) return null
    const access = await this.billing.hold(customer, billingFeatures[feature])
    if (!access.allowed || !access.hold) throw new MailError(denied, "billing_limit", 402)
    return access.hold
  }

  /**
   * The action is already decided. A failed settlement must not turn it into an
   * error for the caller. A consumed unit has no expiry to fall back on, so its
   * release is retried; if it still fails, the next createInbox or getUsage
   * reconciles the account's inbox usage against the database.
   */
  async settle(hold: BillingHold | null, action: "confirm" | "release"): Promise<void> {
    if (!hold) return
    const attempts = "lockId" in hold || action === "confirm" ? 1 : 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { await this.billing.finalize(hold, action); return }
      catch { if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 250 * attempt)) }
    }
  }

  private async record(customer: BillingCustomer, feature: keyof typeof billingFeatures, value: number, key: string): Promise<void> {
    if (this.exempt(customer)) return
    await this.billing.track(customer, billingFeatures[feature], value, key).catch(() => {})
  }

  /**
   * Holds one inbox unit. `count` is the account's inbox count in the database,
   * the source of truth. Autumn's usage should equal it before this new inbox;
   * when it does not (a lost refund, or inboxes that predate billing), usage is
   * corrected with an idempotent event and the decision is made on the true count.
   */
  async holdInbox(customer: BillingCustomer, count: number): Promise<BillingHold | null> {
    if (this.exempt(customer)) return null
    const denied = "Your plan's inbox limit is reached. Upgrade or add inboxes to create more."
    const access = await this.billing.hold(customer, billingFeatures.inboxes)
    // After a successful hold Autumn's usage includes this inbox; after a denial it does not.
    const expected = access.hold ? count + 1 : count
    if (access.balance && !access.balance.unlimited && access.balance.used !== expected) {
      await this.reconcileInboxes(customer, expected, access.balance.used)
      if (access.hold && access.balance.granted !== null && expected > access.balance.granted) {
        await this.settle(access.hold, "release")
        throw new MailError(denied, "billing_limit", 402)
      }
      if (!access.hold) {
        const retry = await this.billing.hold(customer, billingFeatures.inboxes)
        if (retry.allowed && retry.hold) return retry.hold
      }
    }
    if (!access.allowed || !access.hold) throw new MailError(denied, "billing_limit", 402)
    return access.hold
  }
  /** Moves Autumn's inbox usage to `count`. Idempotent per (from, to) pair, so a repeated correction is recorded once. */
  async reconcileInboxes(customer: BillingCustomer, count: number, used: number): Promise<void> {
    if (this.exempt(customer) || used === count) return
    await this.billing.track(customer, billingFeatures.inboxes, count - used, `reconcile:inboxes:${customer.id}:${used}:${count}`)
  }
  creditInbox(customer: BillingCustomer, inboxId: string): Promise<void> {
    return this.record(customer, "inboxes", -1, `inbox:${inboxId}:delete`)
  }

  holdSend(customer: BillingCustomer): Promise<BillingHold | null> {
    return this.hold(customer, "sends", "Your plan's monthly send limit is reached. Upgrade or add sends, then retry with the same idempotencyKey.")
  }

  /**
   * Holds one triage unit. Confirm it once the message is stored or released,
   * release it otherwise. Triage is skipped, not failed, when the allowance is
   * spent or billing cannot answer.
   */
  async holdTriage(customer: BillingCustomer): Promise<{ allowed: boolean; hold: BillingHold | null }> {
    if (this.exempt(customer)) return { allowed: true, hold: null }
    try {
      const access = await this.billing.hold(customer, billingFeatures.triage)
      return { allowed: access.allowed && access.hold !== null, hold: access.hold }
    } catch { return { allowed: false, hold: null } }
  }
  refundTriage(customer: BillingCustomer, messageId: string): Promise<void> {
    return this.record(customer, "triage", -1, `triage:${messageId}:refund`)
  }

  /** Reads usage and, when `inboxCount` is given, corrects Autumn's inbox usage to it first. */
  async usage(customer: BillingCustomer, inboxCount?: number): Promise<BillingUsage> {
    let usage = await this.billing.usage(customer)
    const inboxes = usage.balances.find(b => b.feature === billingFeatures.inboxes)
    if (inboxCount !== undefined && inboxes && !inboxes.unlimited && inboxes.used !== inboxCount) {
      await this.reconcileInboxes(customer, inboxCount, inboxes.used)
      usage = await this.billing.usage(customer)
    }
    return usage
  }

  async checkout(customer: BillingCustomer, planId: string, successUrl?: string): Promise<{ paymentUrl: string | null }> {
    if (!billingPlans.includes(planId as BillingPlan)) throw new MailError("Choose a plan", "invalid_request", 400)
    if (this.exempt(customer)) throw new MailError("Administrator accounts are not billed", "forbidden", 403)
    return this.billing.checkout(customer, planId as BillingPlan, successUrl)
  }

  async portal(customer: BillingCustomer, returnUrl?: string): Promise<{ url: string }> {
    if (this.exempt(customer)) throw new MailError("Administrator accounts are not billed", "forbidden", 403)
    return this.billing.portal(customer, returnUrl)
  }
}
