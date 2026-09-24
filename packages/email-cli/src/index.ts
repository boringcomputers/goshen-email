import { GoshenEmailClient, GoshenEmailError, manifest, prepareRequest, type Operation, type Input } from "@goshenemail/client"
import { z } from "zod"
export const commands = {
  "inboxes list": "listInboxes", "inboxes create": "createInbox", "inboxes get": "getInbox", "inboxes delete": "deleteInbox", "inboxes finish-setup": "finishInboxSetup",
  "inboxes update": "updateInbox",
  "messages list": "listMessages", "messages search": "searchMessages", "messages get": "getMessage", "messages send": "send", "messages reply": "reply",
  "messages labels": "updateMessageLabels", "messages attachment": "getAttachment", "threads list": "listThreads", "threads get": "getThread", "threads labels": "updateThreadLabels",
  "account usage": "getUsage",
} as const
const help = `Goshen Email 0.1.0\n\nUsage: goshenemail <resource> <command> [--json <JSON|->] [flags]\n\n${Object.keys(commands).join("\n")}\n\n--schema       Print the operation schema (or all schemas with no command)\n--dry-run      Validate and show the request without contacting the API\n--base-url     API origin (defaults to GOSHENEMAIL_BASE_URL or hosted API)\n--help         Show usage\n--version      Show version\n\nSet GOSHENEMAIL_API_KEY in your environment. Output is JSON; errors go to stderr.\nUse --json - to read a body from stdin. Send/reply require --idempotency-key.\n`
export async function run(argv: string[], io: { env: Record<string, string | undefined>; readStdin(): Promise<string>; out(text: string): void; error(text: string): void; fetch?: typeof fetch }): Promise<number> {
  try {
    if (argv.includes("--help")) { io.out(help); return 0 }
    if (argv.includes("--version")) { io.out("0.1.0"); return 0 }
    if (!argv.length) { io.out(help); return 0 }
    if (argv.length === 1 && argv[0] === "--schema") { io.out(JSON.stringify(manifest)); return 0 }
    const name = argv.slice(0, 2).join(" ")
    if (!Object.hasOwn(commands, name)) throw new Error("Unknown command. Run goshenemail --help")
    const operation = commands[name as keyof typeof commands], definition = manifest[operation]
    if (argv.includes("--schema")) { io.out(JSON.stringify(definition)); return 0 }
    const input: Record<string, unknown> = Object.create(null), options: Record<string, string | boolean> = {}
    const properties = definition.inputSchema.properties as Record<string, { type?: string | readonly string[]; anyOf?: readonly { type?: string }[] }>
    for (let i = 2; i < argv.length; i++) {
      const flag = argv[i]!
      if (["--dry-run"].includes(flag)) { options[flag] = true; continue }
      if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`)
      const value = argv[++i]
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
      if (flag === "--base-url") { options[flag] = value; continue }
      if (flag === "--json") {
        let data: unknown
        try { data = JSON.parse(value === "-" ? await io.readStdin() : value) } catch { throw new Error("Invalid JSON input") }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("JSON input must be an object")
        for (const [key, entry] of Object.entries(data)) {
          if (Object.hasOwn(input, key)) throw new Error(`Repeated parameter: ${key}`)
          input[key] = entry
        }
        continue
      }
      const key = flag.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
      const propertyType = properties[key]?.type ?? properties[key]?.anyOf?.find(value => value.type && value.type !== "null")?.type
      const type = typeof propertyType === "string" ? propertyType : propertyType?.find(value => value !== "null")
      if (!type) throw new Error(`Unknown flag: ${flag}`)
      if (type === "array") {
        if (input[key] !== undefined && !Array.isArray(input[key])) throw new Error(`Invalid ${flag}`)
        ;(input[key] ??= [] as unknown[]); (input[key] as unknown[]).push(value)
      } else {
        if (Object.hasOwn(input, key)) throw new Error(`Repeated parameter: ${key}`)
        if (type === "boolean" && !["true", "false"].includes(value)) throw new Error(`Use true or false for ${flag}`)
        if (["number", "integer"].includes(type) && !/^\d+$/.test(value)) throw new Error(`Use an integer for ${flag}`)
        input[key] = type === "boolean" ? value === "true" : ["number", "integer"].includes(type) ? Number(value) : value
      }
    }
    const parsed = z.fromJSONSchema(definition.inputSchema as never).safeParse(input)
    if (!parsed.success) throw new Error("Invalid parameters. Run this command with --schema for required fields and types.")
    const value = parsed.data as Input<Operation>, baseUrl = String(options["--base-url"] || io.env.GOSHENEMAIL_BASE_URL || "") || undefined
    if (options["--dry-run"]) { io.out(JSON.stringify({ ...prepareRequest(operation, value, baseUrl), authorization: "Bearer [redacted]" })); return 0 }
    const client = new GoshenEmailClient({ apiKey: io.env.GOSHENEMAIL_API_KEY ?? "", baseUrl, fetch: io.fetch })
    io.out(JSON.stringify(await client.request(operation, value)))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed"
    io.error(JSON.stringify({ error: { message, ...(error instanceof GoshenEmailError ? { status: error.status, code: error.code, transient: error.transient } : { code: "invalid_arguments" }) } }))
    return 1
  }
}
