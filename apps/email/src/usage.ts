import { z } from "zod"
import { billingPlans, type BillingCustomer } from "./billing.js"
import type { CustomerStore, Customer } from "./customer-store.js"
import type { MailService } from "./mail-service.js"
import { planView, pricingPlans } from "./pricing.js"

export type BillableCustomer = BillingCustomer

export const startCheckoutInput = z.object({ planId: z.enum(billingPlans) }).strict()
export const openBillingPortalInput = z.object({}).strict()

const featureBalance = z.object({
  feature: z.string(), granted: z.number().nullable(), used: z.number(), remaining: z.number().nullable(),
  unlimited: z.boolean(), resetsAt: z.string().nullable(),
})
export const usageOutput = z.object({
  billing: z.enum(["metered", "exempt", "disabled"]),
  plan: z.object({ planId: z.string(), status: z.string(), currentPeriodEnd: z.string().nullable(), canceledAt: z.string().nullable() }).nullable(),
  inboxes: z.object({ count: z.number(), limit: z.number().nullable() }),
  features: z.array(featureBalance),
  plans: z.array(planView),
})
export type UsageView = z.infer<typeof usageOutput>

/**
 * One usage view for the dashboard, REST, SDKs, CLI, and MCP. Without billing
 * configured it reports the local inbox count and operator quota; with it, the
 * account's plan, remaining balances from Autumn, and the plans on offer.
 */
export async function accountUsage(service: MailService, store: CustomerStore, customer: Customer): Promise<UsageView> {
  const inboxes = { count: await store.inboxCount(customer), limit: customer.inboxLimit }
  const metering = service.metering
  if (!metering) return { billing: "disabled", plan: null, inboxes, features: [], plans: [] }
  const billable: BillingCustomer = { id: customer.id, email: customer.email, ...(customer.displayName ? { name: customer.displayName } : {}) }
  if (metering.exempt(billable)) return { billing: "exempt", plan: null, inboxes, features: [], plans: [...pricingPlans] }
  // The usage correction takes the account lock so it cannot refund a unit a concurrent createInbox is holding.
  const usage = await store.withAccountLock(customer, (_db, count) => { inboxes.count = count; return metering.usage(billable, count) })
  const plan = usage.subscriptions.find(s => s.status === "active" && !s.canceledAt) ?? usage.subscriptions[0] ?? null
  return { billing: "metered", plan, inboxes, features: usage.balances, plans: [...pricingPlans] }
}
