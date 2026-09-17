import { expect, it } from "vitest"
import { accountInboxMigrations } from "../src/account-inbox-schema.js"
import { CustomerStore, inviteInput } from "../src/customer-store.js"
import { fixture } from "./support.js"
import { migrate } from "../src/database.js"

it("preserves historical quotas and enforcement while making new accounts unlimited, including on reruns", async () => {
  const f = await fixture()
  try {
    await f.db.query("alter table mail.customers alter column inbox_limit set not null, alter column inbox_limit set default 5")
    const store = new CustomerStore(f.db, [])
    const old = await store.invite({ email: "old@example.net", inboxLimit: 5 })
    const limited = await store.invite({ email: "limited@example.net", inboxLimit: 2 })
    await f.db.query("insert into mail.customers(email) values ('old-default@example.net')")
    await f.service.store.saveDomain(await f.service.transport.verifyDomain("example.com"))
    for (let i = 0; i < 5; i++) await store.provision(old.customer, `old-${i}@example.com`, "example.com")
    await expect(store.provision(old.customer, "old-sixth@example.com", "example.com")).rejects.toMatchObject({ code: "inbox_limit", status: 422 })
    for (const migration of accountInboxMigrations) await f.db.query(migration)
    await expect(store.provision(old.customer, "old-sixth@example.com", "example.com")).rejects.toMatchObject({ code: "inbox_limit", status: 422 })
    const [newDefault] = await f.db.query<{ inbox_limit: number | null }>("insert into mail.customers(email) values ('new-default@example.net') returning inbox_limit")
    expect(newDefault!.inbox_limit).toBeNull()
    const unlimited = await store.invite(inviteInput.parse({ email: "new@example.net" }))
    const explicit = await store.invite({ email: "explicit@example.net", inboxLimit: 5 })
    for (const migration of accountInboxMigrations) await f.db.query(migration)
    await store.provision(unlimited.customer, "grouped@example.com", "example.com", undefined, "research")
    for (let i = 0; i < 5; i++) await store.provision(unlimited.customer, `new-${i}@example.com`, "example.com")
    expect(await store.inboxCount(unlimited.customer)).toBe(6)
    await migrate(f.db)
    expect((await store.inbox(unlimited.customer, "grouped@example.com")).group_name).toBe("research")
    expect(unlimited.customer.inboxLimit).toBeNull()
    const rows = await f.db.query<{ id: string; email: string; inbox_limit: number | null }>("select id, email, inbox_limit from mail.customers")
    expect(rows.find(row => row.id === old.customer.id)!.inbox_limit).toBe(5)
    expect(rows.find(row => row.email === "old-default@example.net")!.inbox_limit).toBe(5)
    expect(rows.find(row => row.email === "new-default@example.net")!.inbox_limit).toBeNull()
    expect(rows.find(row => row.id === limited.customer.id)!.inbox_limit).toBe(2)
    expect(rows.find(row => row.id === explicit.customer.id)!.inbox_limit).toBe(5)
    await expect(store.provision(old.customer, "old-sixth@example.com", "example.com")).rejects.toMatchObject({ code: "inbox_limit", status: 422 })
  } finally { await f.pg.close() }
})
