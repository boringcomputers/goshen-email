import { afterEach, describe, expect, it, vi } from "vitest"
import original from "../src/worker.js"
import native, { nativeEnvironment } from "../src/native-worker.js"
import { nativeTestEnvironment } from "./fixtures/native-env.js"

afterEach(() => { vi.restoreAllMocks() })

describe("native deployment boundary", () => {
  it("keeps the standalone entry point available to its existing deployment", async () => {
    const request = new Request("https://mail.example.com/openapi.json")
    expect((await original.fetch(request, nativeTestEnvironment())).status).toBe(200)
    expect((await native.fetch(request, nativeTestEnvironment())).status).toBe(404)
  })
  it.each(["/openapi.json", "/mcp", "/v1/inboxes", "/api/auth/sign-in/magic-link",
    "/account-rpc/session", "/dashboard-rpc/listInboxes"])("does not expose %s", async (path) => {
    const dispatch = vi.spyOn(original, "fetch")
    const response = await native.fetch(new Request(`https://mail.example.com${path}`), nativeTestEnvironment())
    expect(response.status).toBe(404)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("retains health and bearer authentication for native and direct-client APIs", async () => {
    const env = nativeTestEnvironment()
    expect((await native.fetch(new Request(env.PUBLIC_EMAIL_URL + "/healthz"), env)).status).toBe(200)
    for (const path of ["/rpc/listInboxes", "/test-rpc/listInboxes", "/clients/provision", "/inbox-rpc/listMessages"]) {
      const response = await native.fetch(new Request(env.PUBLIC_EMAIL_URL + path, { method: "POST", body: "{}" }), env)
      expect(response.status).toBe(401)
    }
  })

  it.each([
    { MAIL_EVENTS_URL: undefined }, { MAIL_EVENTS_URL: "" },
    { MAIL_EVENTS_URL: "https://another.example/events" },
    { BEZALEL_EVENTS_URL: "https://another.example/events" },
    { WORKER_NAME: "bezalel-email-standalone" }, { DEFAULT_EMAIL_DOMAIN: "agents.goshenemail.com" },
    { PUBLIC_EMAIL_URL: "https://another.example" },
    { TYPESAFE_API_KEY: "private-triage-key" }, { AUTH_PUBLIC_URL: "https://accounts.example.com" },
    { AUTH_PUBLIC_URL: " " },
    { ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com" },
  ])("rejects incompatible settings before dispatch: %j", async (overrides) => {
    const dispatch = vi.spyOn(original, "fetch")
    const env = { ...nativeTestEnvironment(), ...overrides }
    const response = await native.fetch(new Request(env.PUBLIC_EMAIL_URL + "/healthz"), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: {
      message: "Native email is not configured", code: "not_configured", transient: false,
    } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("accepts the existing webhook alias without changing secrets or client configuration", () => {
    const env = { ...nativeTestEnvironment(), MAIL_EVENTS_URL: undefined,
      BEZALEL_EVENTS_URL: "https://mcp.bezalel.sh/events/cloudflare" }
    expect(nativeEnvironment(env)).toBe(env)
  })

  it("rejects invalid background configuration before claiming events or accepting incoming mail", async () => {
    const env = { ...nativeTestEnvironment(), MAIL_EVENTS_URL: undefined }
    const methods = [vi.spyOn(original, "email"), vi.spyOn(original, "queue"), vi.spyOn(original, "scheduled")]
    const ctx = {} as ExecutionContext
    await expect(native.email({} as ForwardableEmailMessage, env, ctx)).rejects.toMatchObject({ code: "not_configured" })
    await expect(native.queue({} as MessageBatch, env, ctx)).rejects.toMatchObject({ code: "not_configured" })
    await expect(native.scheduled({} as ScheduledController, env, ctx)).rejects.toMatchObject({ code: "not_configured" })
    methods.forEach((method) => expect(method).not.toHaveBeenCalled())
  })
})
