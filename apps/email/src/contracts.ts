import { z } from "zod"
import type { MessageDelivery } from "./delivery.js"
import type { MessageProtection } from "./protection.js"

export class MailError extends Error {
  readonly code: string
  readonly status: number
  readonly transient: boolean
  constructor(
    message: string,
    code = "invalid_request",
    status = 400,
    transient = false
  ) {
    super(message)
    this.name = "MailError"
    this.code = code
    this.status = status
    this.transient = transient
  }
}

export const address = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase())
export const domainName = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/)
  .refine((value) => value.split(".").every((label) => label.length <= 63))
const pgText = z
  .string()
  .refine((value) => !/[\0\uD800-\uDFFF]/u.test(value), "Invalid text")
const id = pgText
  .min(1)
  .max(998)
  .refine((value) => !/[\r\n\0]/.test(value))
const labels = z.array(pgText.min(1).max(64)).max(50)
export const outgoingAttachment = z.object({
  filename: pgText.min(1).max(200).refine((v) => v.trim().length > 0 && !/[\x00-\x1f\x7f/\\]/.test(v)),
  contentType: z.string().max(100).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  content: z.string().max(Math.ceil(2 * 1024 * 1024 / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((v) => v.length % 4 === 0)
    .refine((v) => Buffer.from(v, "base64").toString("base64") === v)
})
const outgoingAttachments = z.array(outgoingAttachment).max(10)
  .refine((files) => files.reduce((sum, file) => sum + Buffer.from(file.content, "base64").length, 0) <= 2 * 1024 * 1024)
const body = {
  attachments: outgoingAttachments.optional(),
  labels: labels.refine((values) => !values.includes("quarantined"), "Quarantine requires owner review").optional(),
  text: pgText.max(2_000_000).optional(),
  html: pgText.max(2_000_000).optional()
}
const page = {
  limit: z.number().int().min(1).max(100).default(20),
  pageToken: z.string().max(200).optional()
}
const inbox = { inboxId: address }
const message = { ...inbox, messageId: id }
const thread = { ...inbox, threadId: z.uuid() }
const hasBody = (value: { text?: string; html?: string }) =>
  Boolean(value.text?.trim() || value.html?.trim())
export const inputs = {
  createInbox: z.object({
    username: z
      .string()
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
    domain: domainName.optional(),
    displayName: pgText
      .max(200)
      .refine((v) => !/[\r\n]/.test(v))
      .optional()
  }),
  listInboxes: z.object({}),
  inboxQuota: z.object({}),
  inboxExists: z.object(inbox),
  deleteInbox: z.object(inbox),
  send: z
    .object({
      ...inbox,
      ...body,
      to: z.array(address).min(1).max(50),
      cc: z.array(address).max(50).optional(),
      bcc: z.array(address).max(50).optional(),
      subject: pgText
        .max(998)
        .refine((v) => !/[\r\n]/.test(v))
        .default(""),
      idempotencyKey: pgText.min(1).max(200)
    })
    .refine(hasBody, "Email body is required")
    .refine((v) => Buffer.byteLength(v.text ?? "") + Buffer.byteLength(v.html ?? "") <= 512 * 1024, "Email bodies must fit within 512 KiB")
    .refine(
      (v) =>
        v.to.length + (v.cc?.length ?? 0) + (v.bcc?.length ?? 0) <= 50,
      "Maximum 50 recipients"
    ),
  reply: z
    .object({
      ...message,
      ...body,
      replyAll: z.boolean().default(false),
      to: z.array(address).min(1).max(50).optional(),
      cc: z.array(address).max(50).optional(),
      bcc: z.array(address).max(50).optional(),
      idempotencyKey: pgText.min(1).max(200)
    })
    .refine(hasBody, "Email body is required")
    .refine((v) => Buffer.byteLength(v.text ?? "") + Buffer.byteLength(v.html ?? "") <= 512 * 1024, "Email bodies must fit within 512 KiB"),
  listMessages: z.object({ ...inbox, ...page, labels: labels.optional() }),
  getMessage: z.object({
    ...message,
    includeHtml: z.boolean().default(false)
  }),
  listThreads: z.object({
    ...inbox,
    ...page,
    labels: labels.optional(),
    includeTrash: z.boolean().default(false)
  }),
  getThread: z.object({
    ...thread,
    includeBodies: z.boolean().default(false)
  }),
  reviewThread: z.object({
    ...thread,
    includeBodies: z.boolean().default(false)
  }),
  updateMessageLabels: z.object({
    ...message,
    addLabels: labels.default([]),
    removeLabels: labels.default([])
  }),
  updateThreadLabels: z.object({
    ...thread,
    addLabels: labels.default([]),
    removeLabels: labels.default([])
  }),
  searchMessages: z.object({
    ...inbox,
    ...page,
    query: pgText.min(1).max(1000)
  }),
  getAttachment: z.object({ ...message, attachmentId: z.uuid() }),
  releaseQuarantine: z.object({ ...message, reviewedBy: pgText.min(1).max(200) }),
  createDomain: z.object({ domain: domainName }),
  listDomains: z.object({}),
  verifyDomain: z.object({ domainId: domainName }),
  deleteDomain: z.object({ domainId: domainName }),
  ensureWebhook: z.object({ url: z.url() }),
  webhookStatus: z.object({})
} as const
export type Operation = keyof typeof inputs
export type Input<K extends Operation> = z.infer<(typeof inputs)[K]>

export interface Attachment {
  attachmentId: string
  filename: string
  contentType: string
  size: number
  objectKey: string
}
export interface MailData {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  text: string
  html: string
  references: string[]
  attachments: Attachment[]
}
export interface InboxRow {
  id: string
  address: string
  custom_address?: string | null
  email_aliases?: string[]
  display_name: string | null
  created_at: string
  testing: boolean
}
export interface MessageRow {
  id: string
  inbox_id: string
  wire_id: string
  thread_id: string
  timestamp: string
  direction: "received" | "sent"
  labels: string[]
  data: MailData
  delivery?: MessageDelivery | null
  protection?: MessageProtection | null
}
export interface DomainInfo {
  domainId: string
  domain: string
  status: string
  records: Array<{
    type: string
    name: string
    value: string
    priority?: number
    status?: "verified" | "pending"
  }>
}
export interface SendResult {
  messageId: string
  threadId: string
  deduplicated?: boolean
}
export interface DeliveryResult {
  messageId: string
  delivered: string[]
  queued: string[]
  bounced: string[]
  suppressed: string[]
}
export interface Transport {
  ensureInboxRoute?(address: string): Promise<void>
  send(input: {
    trackingId?: string
    from: string | { address: string; name: string }
    to: string[]
    cc: string[]
    bcc: string[]
    subject: string
    text?: string
    html?: string
    attachments?: z.infer<typeof outgoingAttachments>
    headers: Record<string, string>
  }): Promise<DeliveryResult>
  verifyDomain(domain: string): Promise<DomainInfo>
}
export interface ObjectStore {
  put(
    key: string,
    body: ArrayBuffer | Uint8Array | string
  ): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>
  list(options: {
    prefix: string
    cursor?: string
    limit?: number
  }): Promise<{
    objects: Array<{ key: string }>
    truncated: boolean
    cursor?: string
  }>
  delete(keys: string | string[]): Promise<void>
}
export interface MailConfig {
  accountId?: string
  defaultDomain?: string
  domains: Record<string, string>
  publicUrl: string
  eventsUrl?: string
  webhookSecret: string
  apiToken: string
}
