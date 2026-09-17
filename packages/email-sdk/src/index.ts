import type { operations } from "./operations.js"
export { manifest } from "./manifest.js"
import { manifest } from "./manifest.js"
export type Operation = keyof typeof manifest
// The public method types come from the same OpenAPI contract served by the Worker.
type ObjectOrEmpty<T> = [NonNullable<T>] extends [never] ? Record<never, never> : NonNullable<T> extends Record<string, never> ? Record<never, never> : NonNullable<T>
type Body<K extends Operation> = [NonNullable<operations[K]["requestBody"]>] extends [never] ? Record<never, never> : NonNullable<operations[K]["requestBody"]> extends { content: { "application/json": infer B } } ? B : Record<never, never>
export type Input<K extends Operation> = ObjectOrEmpty<operations[K]["parameters"]["path"]> & ObjectOrEmpty<operations[K]["parameters"]["query"]> & ObjectOrEmpty<Body<K>>
export type Result<K extends Operation> = operations[K]["responses"][200]["content"]["application/json"]
export type { operations } from "./operations.js"
export class BezalelError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly transient = false) { super(message); this.name = "BezalelError" }
}
export const defaultBaseUrl = "https://bezalel-email-standalone.michaelwasihun96.workers.dev"
export function apiBase(value = defaultBaseUrl) {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("baseUrl must be an HTTPS origin (HTTP is allowed only on loopback)")
  return url
}
export function prepareRequest<K extends Operation>(operation: K, input: Input<K>, baseUrl = defaultBaseUrl) {
  if (!Object.hasOwn(manifest, operation)) throw new Error("Unknown email operation")
  const definition = manifest[operation], body = { ...input } as Record<string, unknown>
  const path = definition.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = body[name]
    if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`)
    delete body[name]
    return encodeURIComponent(value)
  })
  const url = new URL(path, apiBase(baseUrl))
  if (definition.method === "GET") {
    for (const [name, value] of Object.entries(body)) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item))
    }
  }
  return { url: url.href, method: definition.method, ...(!["GET", "DELETE"].includes(definition.method) ? { body: JSON.stringify(body) } : {}) }
}
export interface ClientOptions { apiKey: string; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch }
export class BezalelEmail {
  readonly #key: string
  readonly #base: string
  readonly #timeout: number
  readonly #fetch: typeof fetch
  constructor({ apiKey, baseUrl = defaultBaseUrl, timeoutMs = 30_000, fetch: request = globalThis.fetch }: ClientOptions) {
    if (!/^(bze_|gme_)\S+$/.test(apiKey ?? "")) throw new Error("Use an account API key (bze_) or mailbox key (gme_)")
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("timeoutMs must be between 1 and 300000")
    this.#key = apiKey; this.#base = apiBase(baseUrl).origin; this.#timeout = timeoutMs; this.#fetch = request
  }
  async request<K extends Operation>(operation: K, input: Input<K>, options: { signal?: AbortSignal } = {}): Promise<Result<K>> {
    const prepared = prepareRequest(operation, input, this.#base)
    const timeout = AbortSignal.timeout(this.#timeout)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const cancellation = () => {
      if (options.signal?.aborted && signal.reason === options.signal.reason)
        throw new BezalelError("The request was canceled. An in-flight send may already have been accepted.", 0, "request_cancelled")
    }
    let response: Response
    try {
      signal.throwIfAborted()
      response = await this.#fetch(prepared.url, { method: prepared.method, body: prepared.body,
        headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json", accept: "application/json" },
        redirect: "manual", signal })
    } catch {
      cancellation()
      throw new BezalelError("The request did not complete. Retry a send with the same idempotencyKey and contents.", 0, "network_error", true)
    }
    let body: unknown
    try { body = await response.json() }
    catch { cancellation(); throw new BezalelError("The API returned an unreadable response", response.status, "invalid_response") }
    if (!response.ok) {
      const error = (body as { error?: { message?: unknown; code?: unknown; transient?: unknown } } | null)?.error
      throw new BezalelError(typeof error?.message === "string" ? error.message.replaceAll(this.#key, "[redacted]") : "Email request failed",
        response.status, typeof error?.code === "string" ? error.code : "api_error", error?.transient === true)
    }
    return body as Result<K>
  }
  readonly inboxes = {
    list: (input: Input<"listInboxes"> = {}) => this.request("listInboxes", input), create: (input: Input<"createInbox">) => this.request("createInbox", input),
    get: (input: Input<"getInbox">) => this.request("getInbox", input), delete: (input: Input<"deleteInbox">) => this.request("deleteInbox", input),
    update: (input: Input<"updateInbox">) => this.request("updateInbox", input),
    finishSetup: (input: Input<"finishInboxSetup">) => this.request("finishInboxSetup", input),
  }
  readonly messages = {
    list: (input: Input<"listMessages">) => this.request("listMessages", input), search: (input: Input<"searchMessages">) => this.request("searchMessages", input),
    get: (input: Input<"getMessage">) => this.request("getMessage", input), send: (input: Input<"send">) => this.request("send", input),
    reply: (input: Input<"reply">) => this.request("reply", input), updateLabels: (input: Input<"updateMessageLabels">) => this.request("updateMessageLabels", input),
    getAttachment: (input: Input<"getAttachment">) => this.request("getAttachment", input),
  }
  readonly threads = {
    list: (input: Input<"listThreads">) => this.request("listThreads", input), get: (input: Input<"getThread">) => this.request("getThread", input),
    updateLabels: (input: Input<"updateThreadLabels">) => this.request("updateThreadLabels", input),
  }
  async *pages<K extends "listInboxes" | "listMessages" | "searchMessages" | "listThreads">(operation: K, input: Input<K>): AsyncGenerator<Result<K>> {
    const seen = new Set<string>()
    let pageToken = (input as { pageToken?: string }).pageToken
    do {
      if (pageToken && seen.has(pageToken)) throw new BezalelError("API repeated a pagination cursor", 0, "invalid_response")
      if (pageToken) seen.add(pageToken)
      const page = await this.request(operation, { ...input, pageToken })
      yield page
      pageToken = page.nextPageToken
    } while (pageToken)
  }
}
