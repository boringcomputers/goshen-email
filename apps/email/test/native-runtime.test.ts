import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { unstable_dev, type Unstable_DevWorker } from "wrangler"
import { fixture, config } from "./support.js"
import { nativeTestEnvironment } from "./fixtures/native-env.js"

it.skipIf(!process.env.TEST_DATABASE_URL)("serves existing native and test inboxes through workerd and PostgreSQL", async () => {
  const f = await fixture()
  let worker: Unstable_DevWorker | undefined
  const directory = await mkdtemp(join(tmpdir(), "native-mail-runtime-"))
  try {
    await f.service.execute("createInbox", { username: "existing" })
    await f.db.query(`insert into mail.inboxes(id,address,domain,testing)
      values (gen_random_uuid(),'test@example.com','example.com',true)`)
    const { HYPERDRIVE: _, MAIL_OBJECTS: __, ...vars } = nativeTestEnvironment()
    const configuration = join(directory, "wrangler.json")
    await writeFile(configuration, JSON.stringify({
      name: "native-runtime-test", main: resolve("src/native-worker.ts"),
      compatibility_date: "2026-09-06", compatibility_flags: ["nodejs_compat"],
      hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32), localConnectionString: f.connectionString }],
      r2_buckets: [{ binding: "MAIL_OBJECTS", bucket_name: "native-runtime-test" }], vars,
    }), { mode: 0o600 })
    worker = await unstable_dev("src/native-worker.ts", {
      config: configuration, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0,
      logLevel: "error", experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    })
    expect((await worker.fetch("http://localhost/healthz")).status).toBe(200)
    for (const [prefix, address] of [["rpc", "existing@example.com"], ["test-rpc", "test@example.com"]]) {
      const response = await worker.fetch(`http://localhost/${prefix}/listInboxes`, {
        method: "POST", headers: { authorization: `Bearer ${config.apiToken}` }, body: "{}",
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { result: { inboxes: { inboxId: string }[] } }
      expect(body.result.inboxes.map((inbox) => inbox.inboxId)).toEqual([address])
    }
    expect((await worker.fetch("http://localhost/rpc/listInboxes", { method: "POST", body: "{}" })).status).toBe(401)
    expect((await worker.fetch("http://localhost/openapi.json")).status).toBe(404)
    expect((await worker.fetch("http://localhost/account-rpc/session", { method: "POST", body: "{}" })).status).toBe(404)
  } finally {
    await worker?.stop()
    await f.pg.close()
    await rm(directory, { recursive: true, force: true })
  }
})
