import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { type AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { unstable_dev, type Unstable_DevWorker } from "wrangler"

describe("email HTTP requests in the Workers runtime", () => {
  let mock: Server
  let worker: Unstable_DevWorker
  let redirect = false
  const requests: string[] = []
  beforeAll(async () => {
    mock = createServer((request, response) => {
      const path = request.url ?? ""
      requests.push(path)
      request.resume()
      if (redirect) {
        response.writeHead(307, { location: "/collect" })
        response.end()
        return
      }
      const result = path.endsWith("/subdomains")
        ? [{ name: "example.com", enabled: true }]
        : path.endsWith("/catch_all")
          ? { enabled: true, actions: [{ type: "worker", value: ["runtime-test"] }] }
          : { name: "example.com", enabled: true }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ success: true, result }))
    })
    mock.listen(0, "127.0.0.1")
    await once(mock, "listening")
    worker = await unstable_dev("test/fixtures/runtime-worker.ts", {
      config: "test/fixtures/wrangler.jsonc",
      local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0, logLevel: "error",
      vars: { MOCK_URL: `http://127.0.0.1:${(mock.address() as AddressInfo).port}` },
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true }
    })
  })
  beforeEach(() => { requests.length = 0; redirect = false })
  afterAll(async () => {
    await worker?.stop()
    mock?.closeAllConnections()
    await new Promise<void>((resolve) => mock?.close(() => resolve()) ?? resolve())
  })
  it("verifies the domain through three HTTP requests", async () => {
    const response = await worker.fetch("http://localhost/domain")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: "VERIFIED" })
    expect(requests).toHaveLength(3)
  })
  it("delivers webhook events and leaves redirects queued without following them", async () => {
    expect(await (await worker.fetch()).json()).toMatchObject({
      settlements: [{ id: "runtime-event", delivered: true }]
    })
    redirect = true
    expect(await (await worker.fetch()).json()).toMatchObject({
      settlements: [{ id: "runtime-event", delivered: false }]
    })
    expect(requests).toEqual(["/events/cloudflare", "/events/cloudflare"])
  })
})
