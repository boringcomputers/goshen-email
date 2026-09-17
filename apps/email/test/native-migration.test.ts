import { createHmac } from "node:crypto"
import { expect, it } from "vitest"
import { inputs } from "../src/contracts.js"
import { migrate, type Database } from "../src/database.js"
import { emptyMail } from "../src/mailbox-store.js"
import { fingerprint, signDownload, signEvent } from "../src/security.js"
import { handleRequest } from "../src/worker.js"
import { migrations as nativeMigrations } from "./fixtures/native-8c39cb8/schema.js"
import { config, fixture } from "./support.js"

const inboxId = "11111111-1111-4111-8111-111111111111"
const clientInboxId = "22222222-2222-4222-8222-222222222222"
const messageId = "33333333-3333-4333-8333-333333333333"
const threadId = "44444444-4444-4444-8444-444444444444"
const attachmentId = "55555555-5555-4555-8555-555555555555"
const objectKey = `${inboxId}/${messageId}/${attachmentId}`
const sendInput = inputs.send.parse({ inboxId: "agent@example.com", to: ["customer@example.net"],
  subject: "Already sent", text: "Original body", idempotencyKey: "original-send-key" })

// Project the original columns so new defaults cannot hide changes to old data.
async function snapshot(db: Database, columns: { table_name: string; column_name: string }[]) {
  const result: Record<string, unknown[]> = {}
  for (const table of new Set(columns.map((column) => column.table_name))) {
    const names = columns.filter((column) => column.table_name === table)
      .map((column) => `"${column.column_name.replaceAll('"', '""')}"`).join(", ")
    result[table] = await db.query(`select to_jsonb(original) as row from
      (select ${names} from mail."${table.replaceAll('"', '""')}") original order by to_jsonb(original)::text`)
  }
  return result
}

it("upgrades the deployed native schema without changing saved mail, credentials, or pending work", async () => {
  const f = await fixture()
  try {
    await f.pg.exec("drop schema mail cascade")
    for (const statement of nativeMigrations) await f.db.query(statement)
    await f.db.query("insert into mail.domains(domain, info, credentials) values ($1,$2,$3)", ["example.com",
      { domainId: "example.com", domain: "example.com", status: "VERIFIED", records: [] }, { encrypted: "synthetic-ciphertext" }])
    for (const [id, address, testing, deleted] of [
      [inboxId, "agent@example.com", false, null], [clientInboxId, "client@example.com", false, null],
      ["66666666-6666-4666-8666-666666666666", "test@example.com", true, null],
      ["77777777-7777-4777-8777-777777777777", "retired@example.com", false, "2026-09-01T00:00:00Z"],
    ]) await f.db.query(`insert into mail.inboxes(id,address,domain,display_name,testing,deleted_at,email_aliases)
      values ($1,$2,'example.com','Original name',$3,$4,ARRAY['old-alias@example.com'])`, [id, address, testing, deleted])
    await f.db.query(`insert into mail.clients(client_id,inbox_id,webhook_url,token_version,daily_send_limit)
      values ('existing-client',$1,'https://client.example.net/events',4,17)`, [clientInboxId])
    await f.db.query(`insert into mail.messages(id,inbox_id,wire_id,thread_id,timestamp,direction,labels,data)
      values ($1,$2,'<original@example.net>',$3,'2026-09-01T12:34:56Z','received',ARRAY['received','archive','custom-label'],$4)`,
    [messageId, inboxId, threadId, { ...emptyMail(), from: "customer@example.net", to: ["agent@example.com"],
      subject: "Original subject", text: "Original body", html: "<p>Original body</p>",
      attachments: [{ attachmentId, objectKey, filename: "original.txt", contentType: "text/plain", size: 13 }] }])
    f.blobs.set(objectKey, new TextEncoder().encode("Original file"))
    const sendResult = { messageId: "<sent@example.net>", threadId }
    await f.db.query(`insert into mail.sends(inbox_id,key,fingerprint,state,result)
      values ($1,$2,$3,'sent',$4)`, [inboxId, sendInput.idempotencyKey, fingerprint(JSON.stringify({ input: sendInput })), sendResult])
    await f.db.query(`insert into mail.sends(inbox_id,key,fingerprint,state) values ($1,'uncertain','uncertain-fingerprint','pending')`, [inboxId])
    for (const [id, inbox, delivered] of [["shared-event", inboxId, null], ["client-event", clientInboxId, null],
      ["delivered-event", inboxId, "2026-09-01T00:00:00Z"]]) {
      await f.db.query(`insert into mail.outbox(id,inbox_id,payload,attempts,delivered_at)
        values ($1,$2,$3,3,$4)`, [id, inbox, { type: "email.received", marker: id }, delivered])
    }
    await f.db.query(`insert into mail.incoming(object_key,inbox_id,recipient,attempts,envelope_sender)
      values ('pending/raw.eml',$1,'agent@example.com',2,'sender@example.net')`, [inboxId])
    await f.db.query("insert into mail.garbage(prefix) values ('retired-prefix/')")
    await f.db.query(`insert into mail.recipient_suppressions(inbox_id,recipient,reason,event_id)
      values ($1,'bounced@example.net','hard_bounce','original-bounce')`, [inboxId])
    const columns = await f.db.query<{ table_name: string; column_name: string }>(
      "select table_name,column_name from information_schema.columns where table_schema='mail' order by table_name,ordinal_position")
    const before = await snapshot(f.db, columns)
    expect(Object.keys(before)).toHaveLength(10)
    const expires = String(Math.floor(Date.now() / 1000) + 240)
    const attachmentPath = `/attachments/${inboxId}/${messageId}/${attachmentId}`
    const oldLink = `${config.publicUrl}${attachmentPath}?expires=${expires}&signature=${signDownload(config.webhookSecret, attachmentPath, expires)}`
    const oldKey = `gme_${clientInboxId}.${createHmac("sha256", config.apiToken).update(`inbox:${clientInboxId}:4`).digest("base64url")}`

    await migrate(f.db)
    await migrate(f.db)
    expect(await snapshot(f.db, columns)).toEqual(before)
    expect(await f.db.query("select * from mail.customer_inboxes")).toEqual([])
    expect(await f.db.query("select * from mail.messages where triage is not null")).toEqual([])
    expect((await f.service.execute("listInboxes", {}) as any).inboxes).toHaveLength(2)
    const message = await f.service.execute("getMessage", { inboxId: "agent@example.com", messageId: "<original@example.net>", includeHtml: true })
    expect(message).toMatchObject({ messageId: "<original@example.net>", threadId, text: "Original body", html: "<p>Original body</p>",
      labels: ["received", "archive", "custom-label"], attachments: [{ attachmentId, filename: "original.txt", size: 13 }] })
    const download = await handleRequest(new Request(oldLink), f.service)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe("Original file")
    const client = await handleRequest(new Request(`${config.publicUrl}/inbox-rpc/getInbox`, {
      method: "POST", headers: { authorization: `Bearer ${oldKey}` }, body: "{}",
    }), f.service)
    expect(client.status).toBe(200)
    expect(await client.json()).toMatchObject({ result: { inboxId: "client@example.com" } })
    expect(await f.service.send(sendInput)).toEqual({ ...sendResult, deduplicated: true })
    expect(await f.service.store.reserveSend(inboxId, "uncertain", "uncertain-fingerprint")).toMatchObject({ state: "pending" })
    expect(f.send).not.toHaveBeenCalled()

    f.request.mockImplementation(async () => new Response("retry", { status: 503 }))
    await f.service.flushEvents()
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(await f.db.query("select id,attempts,delivered_at from mail.outbox where delivered_at is null order by id"))
      .toEqual([{ id: "client-event", attempts: 4, delivered_at: null }, { id: "shared-event", attempts: 4, delivered_at: null }])
    await f.db.query("update mail.outbox set available_at=now() where delivered_at is null")
    f.request.mockClear()
    f.request.mockImplementation(async () => new Response("ok"))
    await f.service.flushEvents()
    expect(f.request).toHaveBeenCalledTimes(2)
    for (const [url, request] of f.request.mock.calls) {
      const headers = new Headers(request!.headers)
      const id = headers.get("svix-id")!
      const secret = id === "shared-event" ? config.webhookSecret :
        `whsec_${createHmac("sha256", config.webhookSecret).update(`inbox:${clientInboxId}`).digest("base64")}`
      expect(String(url)).toBe(id === "shared-event" ? config.eventsUrl : "https://client.example.net/events")
      expect(headers.get("svix-signature")).toBe(signEvent(secret, id, headers.get("svix-timestamp")!, String(request!.body)))
      expect(JSON.parse(String(request!.body))).toEqual({ type: "email.received", marker: id })
    }
    await f.service.flushEvents()
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(await f.db.query("select id from mail.outbox where delivered_at is null")).toEqual([])
  } finally { await f.pg.close() }
})
