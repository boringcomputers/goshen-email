// Goshen Email pricing, pushed to Autumn with `npx atmn@2 push` from this folder.
// Feature ids must match billingFeatures in apps/email/src/billing.ts; a test checks that.
// Prices and limits are explained in docs/pricing.md. Change them here, then there.
import { atmn, feature, plan } from "atmn"

export const inboxes = feature({ featureId: "inboxes", name: "Inboxes", type: "metered", consumable: false })
export const sends = feature({ featureId: "sends", name: "Sends", type: "metered", consumable: true })
export const triage = feature({ featureId: "triage", name: "Triage analyses", type: "metered", consumable: true })
export const customDomains = feature({ featureId: "custom_domains", name: "Custom domains", type: "metered", consumable: false })
export const storage = feature({ featureId: "storage_mb", name: "Storage (MB)", type: "metered", consumable: false })
export const seats = feature({ featureId: "seats", name: "Seats", type: "metered", consumable: false })

const monthly = { interval: "month" } as const
// Every top-up is $2 per unit per month: one inbox, one domain, 1,000 sends, or 1,000 triage analyses.
const topUp = (billingUnits: number) => ({ amount: 2, billingUnits, interval: "month", billingMethod: "prepaid" } as const)

export const free = plan({
  planId: "free",
  versionSlug: "v1",
  active: true,
  name: "Free",
  description: "Try agents with real inboxes. No card required.",
  autoEnable: true,
  group: "goshen",
  items: [
    { featureId: inboxes.featureId, included: 5 },
    { featureId: sends.featureId, included: 1_000, reset: monthly },
    { featureId: triage.featureId, included: 500, reset: monthly },
    // No custom domains on Free: the feature is absent, so a check for it is denied.
    { featureId: storage.featureId, included: 1_024 },
    { featureId: seats.featureId, included: 1 },
  ],
})

export const developer = plan({
  planId: "developer",
  versionSlug: "v1",
  active: true,
  name: "Developer",
  description: "For one person's agents in production.",
  price: { amount: 20, interval: "month" },
  group: "goshen",
  items: [
    { featureId: inboxes.featureId, included: 10, price: topUp(1) },
    { featureId: sends.featureId, included: 10_000, reset: monthly, price: topUp(1_000) },
    { featureId: triage.featureId, included: 10_000, reset: monthly, price: topUp(1_000) },
    { featureId: customDomains.featureId, included: 5, price: topUp(1) },
    { featureId: storage.featureId, included: 10_240 },
    { featureId: seats.featureId, included: 2 },
  ],
})

export const team = plan({
  planId: "team",
  versionSlug: "v1",
  active: true,
  name: "Team",
  description: "For a team running a fleet of agents.",
  price: { amount: 99, interval: "month" },
  group: "goshen",
  items: [
    { featureId: inboxes.featureId, included: 100, price: topUp(1) },
    { featureId: sends.featureId, included: 100_000, reset: monthly, price: topUp(1_000) },
    { featureId: triage.featureId, included: 100_000, reset: monthly, price: topUp(1_000) },
    { featureId: customDomains.featureId, included: 50, price: topUp(1) },
    { featureId: storage.featureId, included: 102_400 },
    { featureId: seats.featureId, included: 10 },
  ],
})

export default atmn({
  features: [inboxes, sends, triage, customDomains, storage, seats],
  plans: [free, developer, team],
})
