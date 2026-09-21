import { z } from "zod"
import { billingPlans } from "./billing.js"

/**
 * The plan catalog the dashboard and landing page show. Autumn holds the
 * billed copy in ops/autumn/autumn.config.ts; a test keeps the two in step.
 * Prices are US dollars per month. Included amounts are per month for sends
 * and triage and standing counts for the rest.
 */
export const planView = z.object({
  planId: z.enum(billingPlans),
  name: z.string(),
  description: z.string(),
  price: z.number(),
  included: z.object({ inboxes: z.number(), sends: z.number(), triage: z.number(), customDomains: z.number(), storageMb: z.number(), seats: z.number() }),
  topUps: z.boolean(),
})
export type PlanView = z.infer<typeof planView>

/** Every top-up unit costs this much per month: one inbox, one domain, 1,000 sends, or 1,000 triage analyses. */
export const topUpPrice = 2

export const pricingPlans: readonly PlanView[] = [
  { planId: "free", name: "Free", description: "Try agents with real inboxes. No card required.", price: 0,
    included: { inboxes: 5, sends: 1_000, triage: 500, customDomains: 0, storageMb: 1_024, seats: 1 }, topUps: false },
  { planId: "developer", name: "Developer", description: "For one person's agents in production.", price: 20,
    included: { inboxes: 10, sends: 10_000, triage: 10_000, customDomains: 5, storageMb: 10_240, seats: 2 }, topUps: true },
  { planId: "team", name: "Team", description: "For a team running a fleet of agents.", price: 99,
    included: { inboxes: 100, sends: 100_000, triage: 100_000, customDomains: 50, storageMb: 102_400, seats: 10 }, topUps: true },
]
