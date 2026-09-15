import { z } from "zod"
import {
  address,
  domainName,
  MailError,
  type DeliveryResult,
  type MailConfig,
  type MessageRow,
} from "./contracts.js"
import type { MailboxStore } from "./mailbox-store.js"

const statuses = [
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
] as const
export type DeliveryStatus = (typeof statuses)[number] | "accepted" | "queued"
export interface RecipientDelivery {
  recipient: string
  status: DeliveryStatus
  updatedAt: string
  delivered: boolean
  eventId?: string
  provider?: string
  reason?: string
  smtpStatusCode?: string
  smtpEnhancedStatusCode?: string
  deliveryTimeMs?: number
  deliveryEventAt?: string
}
export interface MessageDelivery {
  version: number
  sentAt: string
  updatedAt: string
  recipients: RecipientDelivery[]
}

const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\0\uD800-\uDFFF]/u.test(v))
const eventSchema = z
  .object({
    type: z.enum(statuses.map((s) => `cf.email.sending.message.${s}` as const)),
    source: z.object({
      type: z.literal("email.sending"),
      zoneId: z.string(),
      domain: domainName,
    }),
    payload: z.object({
      eventId: safeText(200).min(1),
      messageId: safeText(998).min(1),
      sender: address,
      recipient: address,
      terminal: z.boolean(),
      delivery: z.object({
        status: z.enum(statuses),
        provider: safeText(100).optional(),
        deliveryTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30 * 86400_000)
          .optional(),
        smtpStatusCode: safeText(20).optional(),
        smtpEnhancedStatusCode: safeText(20).optional(),
        smtpResponse: safeText(2000).optional(),
      }),
      bounce: z.object({ reason: safeText(2000).optional() }).optional(),
      failure: z.object({ reason: safeText(2000).optional() }).optional(),
      rejection: z
        .object({
          reason: safeText(2000).optional(),
          detail: safeText(2000).optional(),
        })
        .optional(),
      complaint: z.object({ type: safeText(200).optional() }).optional(),
    }),
    metadata: z.object({
      accountId: z.string(),
      eventSchemaVersion: z.literal(1),
      eventTimestamp: z.iso.datetime({ offset: true }),
    }),
  })
  .refine(
    (v) =>
      v.type === `cf.email.sending.message.${v.payload.delivery.status}` &&
      v.payload.terminal === (v.payload.delivery.status !== "deferred"),
  )
type DeliveryEvent = z.infer<typeof eventSchema>
export interface DeliveryUpdate {
  eventId: string
  recipient: string
  status: (typeof statuses)[number]
  occurredAt: string
  reason?: string
  provider?: string
  smtpStatusCode?: string
  smtpEnhancedStatusCode?: string
  deliveryTimeMs?: number
}
const terminal = (status: DeliveryStatus) =>
  !["accepted", "queued", "deferred"].includes(status)

export function initialDelivery(
  row: MessageRow,
  receipt?: DeliveryResult,
): MessageDelivery {
  return {
    version: 1,
    sentAt: row.timestamp,
    updatedAt: row.timestamp,
    recipients: [
      ...new Set(
        [...row.data.to, ...row.data.cc, ...row.data.bcc].map((r) =>
          r.toLowerCase(),
        ),
      ),
    ].map((recipient) => {
      const includes = (values?: string[]) =>
        values?.some((r) => r.toLowerCase() === recipient)
      const status = includes(receipt?.suppressed)
        ? "rejected"
        : includes(receipt?.bounced)
          ? "bounced"
          : includes(receipt?.delivered)
            ? "delivered"
            : includes(receipt?.queued)
              ? "queued"
              : "accepted"
      return {
        recipient,
        status,
        updatedAt: row.timestamp,
        delivered: status === "delivered",
        ...(status === "rejected" ? { reason: "Recipient is suppressed" } : {}),
      }
    }),
  }
}

export function reduceDelivery(
  current: MessageDelivery,
  event: DeliveryEvent,
): MessageDelivery | null {
  const p = event.payload
  return reduceDeliveryUpdate(current, {
    eventId: p.eventId, recipient: p.recipient, status: p.delivery.status,
    occurredAt: event.metadata.eventTimestamp,
    reason: p.complaint?.type ?? p.rejection?.detail ?? p.rejection?.reason ??
      p.failure?.reason ?? p.bounce?.reason ?? p.delivery.smtpResponse,
    provider: p.delivery.provider, smtpStatusCode: p.delivery.smtpStatusCode,
    smtpEnhancedStatusCode: p.delivery.smtpEnhancedStatusCode,
    deliveryTimeMs: p.delivery.deliveryTimeMs,
  })
}

export function reduceDeliveryUpdate(
  current: MessageDelivery,
  p: DeliveryUpdate,
): MessageDelivery | null {
  const at = new Date(p.occurredAt).toISOString()
  let changed = false
  const recipients = current.recipients.map((previous) => {
    if (previous.recipient !== p.recipient) return previous
    const status = p.status
    const newer =
      !previous.eventId ||
      at > previous.updatedAt ||
      (at === previous.updatedAt && p.eventId > previous.eventId)
    const advance =
      previous.eventId !== p.eventId &&
      ((status === "complained" && previous.status !== "complained") ||
        (previous.status !== "complained" &&
          (newer || (!terminal(previous.status) && terminal(status))) &&
          (!terminal(previous.status) || terminal(status))))
    let next = { ...previous }
    if (advance) {
      const reason = p.reason
      next = {
        recipient: previous.recipient,
        status,
        updatedAt: at,
        eventId: p.eventId,
        delivered: status === "delivered" || status === "complained",
        ...(p.provider
          ? { provider: p.provider }
          : previous.provider
            ? { provider: previous.provider }
            : {}),
        ...(reason
          ? { reason: reason.slice(0, 512).replace(/[\uD800-\uDBFF]$/, "") }
          : {}),
        ...(p.smtpStatusCode
          ? { smtpStatusCode: p.smtpStatusCode }
          : {}),
        ...(p.smtpEnhancedStatusCode
          ? { smtpEnhancedStatusCode: p.smtpEnhancedStatusCode }
          : {}),
        ...(["delivered", "complained"].includes(status) &&
        previous.deliveryTimeMs !== undefined
          ? { deliveryTimeMs: previous.deliveryTimeMs }
          : {}),
        ...(["delivered", "complained"].includes(status) &&
        previous.deliveryEventAt
          ? { deliveryEventAt: previous.deliveryEventAt }
          : {}),
      }
    }
    // Complaints prove prior delivery. A late delivered event can still supply latency.
    if (
      status === "delivered" &&
      (advance || previous.status === "complained") &&
      p.deliveryTimeMs !== undefined &&
      (!previous.deliveryEventAt || at < previous.deliveryEventAt)
    ) {
      next.deliveryTimeMs = p.deliveryTimeMs
      next.deliveryEventAt = at
      if (p.provider) next.provider = p.provider
    }
    if (JSON.stringify(next) === JSON.stringify(previous)) return previous
    changed = true
    return next
  })
  return changed
    ? {
        ...current,
        version: current.version + 1,
        updatedAt: [current.updatedAt, at].sort().at(-1)!,
        recipients,
      }
    : null
}

export const deliveryEvent = (
  row: MessageRow,
  inboxId: string,
  delivery: MessageDelivery,
) => ({
  type: "email.delivery_updated",
  inboxId,
  occurredAt: delivery.updatedAt,
  message: { messageId: row.wire_id, threadId: row.thread_id, inboxId },
  delivery,
})

export async function ingestDelivery(
  store: MailboxStore,
  config: MailConfig,
  raw: unknown,
): Promise<"updated" | "ignored"> {
  const parsed = eventSchema.safeParse(raw)
  if (!parsed.success) return "ignored"
  const event = parsed.data
  if (Date.parse(event.metadata.eventTimestamp) > Date.now() + 300_000)
    return "ignored"
  if (!config.accountId)
    throw new MailError(
      "Delivery tracking account is not configured",
      "not_configured",
      503,
      true,
    )
  if (
    event.metadata.accountId !== config.accountId ||
    config.domains[event.source.domain] !== event.source.zoneId ||
    event.payload.sender.split("@")[1] !== event.source.domain
  )
    return "ignored"
  let inbox
  try {
    inbox = await store.inbox(event.payload.sender)
  } catch (e) {
    if (e instanceof MailError && e.status === 404) return "ignored"
    throw e
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    let row
    try {
      row = await store.message(inbox.id, event.payload.messageId)
    } catch (e) {
      if (e instanceof MailError && e.status === 404)
        throw new MailError(
          "Delivery event arrived before message storage",
          "message_pending",
          503,
          true,
        )
      throw e
    }
    if (row.direction !== "sent" || row.data.from !== inbox.address)
      return "ignored"
    // Historical messages become tracked only when a provider event identifies them.
    const current = row.delivery ?? { ...initialDelivery(row), version: 0 }
    const next = reduceDelivery(current, event)
    if (!next) return "ignored"
    const result = await store.applyDelivery(
      row,
      current.version,
      next,
      inbox.testing ? null : deliveryEvent(row, inbox.address, next),
    )
    if (result === "updated") return "updated"
    if (result === "missing") return "ignored"
  }
  throw new MailError(
    "Concurrent delivery update; retry later",
    "delivery_busy",
    503,
    true,
  )
}
