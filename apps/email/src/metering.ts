import { billingFeatures, billingPlans, type BillingCustomer, type BillingPlan, type BillingProvider, type BillingUsage } from "./billing.js"
import { MailError } from "./contracts.js"

/**
 * Decides when a metered action may proceed and records it afterwards.
 * Platform administrators are exempt. The daily per-inbox send limit stays in
 * SQL as an abuse backstop regardless of plan.
 */
export class Metering {
  constructor(readonly billing: BillingProvider, readonly exemptEmails: string[]) {}

  exempt(customer: BillingCustomer): boolean {
    return this.exemptEmails.includes(customer.email.toLowerCase())
  }

  private async allow(customer: BillingCustomer, feature: keyof typeof billingFeatures): Promise<boolean> {
    if (this.exempt(customer)) return true
    return (await this.billing.check(customer, billingFeatures[feature])).allowed
  }

  private async record(customer: BillingCustomer, feature: keyof typeof billingFeatures, value: number, key: string): Promise<void> {
    if (this.exempt(customer)) return
    // The action already happened. A failed record must not turn success into an error for the caller.
    await this.billing.track(customer, billingFeatures[feature], value, key).catch(() => {})
  }

  async assertInboxAvailable(customer: BillingCustomer): Promise<void> {
    if (!(await this.allow(customer, "inboxes")))
      throw new MailError("Your plan's inbox limit is reached. Upgrade or add inboxes to create more.", "billing_limit", 402)
  }
  recordInbox(customer: BillingCustomer, inboxId: string, delta: 1 | -1): Promise<void> {
    return this.record(customer, "inboxes", delta, `inbox:${inboxId}:${delta > 0 ? "create" : "delete"}`)
  }

  async assertSendAvailable(customer: BillingCustomer): Promise<void> {
    if (!(await this.allow(customer, "sends")))
      throw new MailError("Your plan's monthly send limit is reached. Upgrade or add sends, then retry with the same idempotencyKey.", "billing_limit", 402)
  }
  recordSend(customer: BillingCustomer, inboxId: string, idempotencyKey: string): Promise<void> {
    return this.record(customer, "sends", 1, `send:${inboxId}:${idempotencyKey}`)
  }

  /** Triage is skipped, not failed, when the allowance is spent or billing cannot answer. */
  async triageAllowed(customer: BillingCustomer): Promise<boolean> {
    try { return await this.allow(customer, "triage") } catch { return false }
  }
  recordTriage(customer: BillingCustomer, messageId: string): Promise<void> {
    return this.record(customer, "triage", 1, `triage:${messageId}`)
  }

  usage(customer: BillingCustomer): Promise<BillingUsage> {
    return this.billing.usage(customer)
  }

  async checkout(customer: BillingCustomer, planId: string, successUrl?: string): Promise<{ paymentUrl: string | null }> {
    if (!billingPlans.includes(planId as BillingPlan)) throw new MailError("Choose a plan", "invalid_request", 400)
    if (this.exempt(customer)) throw new MailError("Administrator accounts are not billed", "forbidden", 403)
    return this.billing.checkout(customer, planId as BillingPlan, successUrl)
  }
}
