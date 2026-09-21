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

  /** The action is already decided. A failed settlement must not turn it into an error for the caller. */
  async settle(hold: BillingHold | null, action: "confirm" | "release"): Promise<void> {
    if (hold) await this.billing.finalize(hold, action).catch(() => {})
  }

  private async record(customer: BillingCustomer, feature: keyof typeof billingFeatures, value: number, key: string): Promise<void> {
    if (this.exempt(customer)) return
    await this.billing.track(customer, billingFeatures[feature], value, key).catch(() => {})
  }

  holdInbox(customer: BillingCustomer): Promise<BillingHold | null> {
    return this.hold(customer, "inboxes", "Your plan's inbox limit is reached. Upgrade or add inboxes to create more.")
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

  usage(customer: BillingCustomer): Promise<BillingUsage> {
    return this.billing.usage(customer)
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
