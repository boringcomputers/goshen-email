import { expect, it } from "vitest"
import { accountInboxMigrations } from "../src/account-inbox-schema.js"
import { CustomerStore, inviteInput } from "../src/customer-store.js"
import { fixture } from "./support.js"
import { migrate } from "../src/database.js"

it("upgrades the old five-inbox default once and preserves explicit quotas on reruns", async () => {
  const f = await fixture()
  try {
    await f.db.query("alter table mail.customers alter column inbox_limit set not null, alter column inbox_limit set default 5")
    const store = new CustomerStore(f.db, [])
    const old = await store.invite({ email: "old@example.net", inboxLimit: 5 })
    const limited = await store.invite({ email: "limited@example.net", inboxLimit: 2 })
    for (const migration of accountInboxMigrations) await f.db.query(migration)
    const unlimited = await store.invite(inviteInput.parse({ email: "new@example.net" }))
    const explicit = await store.invite({ email: "explicit@example.net", inboxLimit: 5 })
    for (const migration of accountInboxMigrations) await f.db.query(migration)
    await f.service.store.saveDomain(await f.service.transport.verifyDomain("example.com"))
    await store.provision(unlimited.customer, "grouped@example.com", "example.com", undefined, "research")
    await migrate(f.db)
    expect((await store.inbox(unlimited.customer, "grouped@example.com")).group_name).toBe("research")
    expect(unlimited.customer.inboxLimit).toBeNull()
    const rows = await f.db.query<{ id: string; inbox_limit: number | null }>("select id, inbox_limit from mail.customers")
    expect(rows.find(row => row.id === old.customer.id)!.inbox_limit).toBeNull()
    expect(rows.find(row => row.id === limited.customer.id)!.inbox_limit).toBe(2)
    expect(rows.find(row => row.id === explicit.customer.id)!.inbox_limit).toBe(5)
  } finally { await f.pg.close() }
})
