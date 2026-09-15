import { z } from "zod"
import { address, MailError } from "./contracts.js"
import { deliveryEvent, initialDelivery, reduceDeliveryUpdate } from "./delivery.js"
import type { MailService } from "./mail-service.js"

const text = (max: number) => z.string().max(max).refine((v) => !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v))
export const gatewayDelivery = z.object({
  eventId: text(200).min(1),
  trackingId: z.uuid(),
  messageId: text(998).min(1),
  sender: address,
  recipient: address,
  status: z.enum(["delivered", "deferred", "bounced", "complained"]),
  occurredAt: z.iso.datetime({ offset: true }),
  reason: text(2000).optional(),
  smtpStatusCode: z.string().regex(/^[245][0-9]{2}$/).optional(),
  smtpEnhancedStatusCode: z.string().regex(/^[245]\.[0-9]{1,3}\.[0-9]{1,3}$/).optional(),
  deliveryTimeMs: z.number().int().min(0).max(30 * 86400_000).optional(),
})
export type GatewayDelivery = z.infer<typeof gatewayDelivery>

export async function ingestGatewayDelivery(
  service: MailService,
  input: GatewayDelivery,
): Promise<"updated" | "ignored"> {
  const custom = service.customDomains
  if (!custom || custom.managedDomains.includes(input.sender.split("@")[1]!)) return "ignored"
  if (Date.parse(input.occurredAt) > Date.now() + 300_000) return "ignored"
  let inbox
  try { inbox = await service.store.deliveryInbox(input.sender, input.trackingId) } catch (error) {
    if (error instanceof MailError && error.status === 404) return "ignored"
    throw error
  }
  if (inbox.testing) return "ignored"
  for (let attempt = 0; attempt < 5; attempt++) {
    let row
    try { row = await service.store.message(inbox.id, input.messageId) } catch (error) {
      if (error instanceof MailError && error.status === 404)
        throw new MailError("Delivery event arrived before message storage", "message_pending", 503, true)
      throw error
    }
    if (row.id !== input.trackingId || row.direction !== "sent" || row.data.from !== input.sender ||
        ![...row.data.to, ...row.data.cc, ...row.data.bcc].includes(input.recipient) ||
        Date.parse(input.occurredAt) < Date.parse(row.timestamp) - 300_000) return "ignored"
    const current = row.delivery ?? { ...initialDelivery(row), version: 0 }
    const next = reduceDeliveryUpdate(current, { ...input, provider: "bezalel-smtp" })
    if (!next) return "ignored"
    const suppression = input.status === "complained" ? "complaint" :
      input.status === "bounced" && input.smtpEnhancedStatusCode?.startsWith("5.") ? "hard_bounce" : null
    const result = await service.store.applyGatewayDelivery(row, current.version, next,
      deliveryEvent(row, inbox.address, next),
      suppression ? { recipient: input.recipient, reason: suppression, eventId: input.eventId } : null)
    if (result === "updated") return "updated"
    if (result === "missing") return "ignored"
  }
  throw new MailError("Concurrent delivery update; retry later", "delivery_busy", 503, true)
}
