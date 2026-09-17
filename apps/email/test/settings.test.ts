import { expect, it } from "vitest"
import { fixture } from "./support.js"
import { CustomerStore } from "../src/customer-store.js"
import { settingsMigrations } from "../src/settings-schema.js"
import { migrate } from "../src/database.js"

it("upgrades existing accounts, preserves names on migration reruns, and supports Access profiles", async () => {
  const f = await fixture()
  try {
    const store = new CustomerStore(f.db, [])
    await f.db.query('alter table mail.customers drop column organization_name')
    const { customer } = await store.invite({ email: 'alex@example.net', displayName: 'Alex', inboxLimit: 3 })
    for (const migration of settingsMigrations) await f.db.query(migration)
    const identity = { email: customer.email, subject: 'access-alex' }
    expect(await store.resolve(identity)).toMatchObject({ organizationName: 'Your workspace', inboxLimit: 3 })
    await store.updateSettings(customer, { organizationName: 'Research lab', displayName: 'Alex Rivera' })
    await migrate(f.db)
    expect(await store.resolve(identity)).toMatchObject({ organizationName: 'Research lab', displayName: 'Alex Rivera', inboxLimit: 3 })
    await store.setAccess(customer.id, false)
    await expect(store.updateSettings(customer, { organizationName: 'Disabled' })).rejects.toMatchObject({ status: 403 })
  } finally { await f.pg.close() }
})
