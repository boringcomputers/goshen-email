import PostalMime, { type Email } from "postal-mime"
import { z } from "zod"
import { address, MailError } from "./contracts.js"
import { ingestGatewayDelivery } from "./gateway-delivery.js"
import type { MailService } from "./mail-service.js"
import type { MessageProtection } from "./protection.js"
import { fingerprint } from "./security.js"

const parseOptions = { forceRfc822Attachments: true, maxNestingDepth: 16, maxHeadersSize: 128 * 1024 }
const values = (email: Email, name: string) => email.headers.filter((h) => h.key === name).map((h) => h.value)
const one = (email: Email, name: string) => {
  const entries = values(email, name)
  return entries.length === 1 ? entries[0] : undefined
}
const mailbox = (value: string | undefined): string | undefined => {
  const parsed = address.safeParse(value?.trim().replace(/^<([^<>]+)>$/, "$1"))
  return parsed.success ? parsed.data : undefined
}

export async function ingestFeedback(service: MailService, raw: Uint8Array, protection: MessageProtection) {
  const signers = service.customDomains?.config.feedbackSigners ?? []
  const verified = protection.authentication.signingDomains.filter((domain) => signers.includes(domain))
  if (protection.authentication.dkim !== "pass" || !verified.length || protection.antivirus.status !== "clean") return "ignored"
  let report: Email
  try { report = await PostalMime.parse(raw, parseOptions) } catch { return "ignored" }
  const contentType = one(report, "content-type")
  if (!contentType || !/^multipart\/report\s*;/i.test(contentType) ||
      !/;\s*report-type\s*=\s*(?:"feedback-report"|feedback-report)(?:\s*;|\s*$)/i.test(contentType) ||
      !one(report, "from")) return "ignored"

  // Only a verified, full-body signature covering the MIME header can authorize suppression.
  const signatures = values(report, "dkim-signature").map((signature) =>
    new Map(signature.split(";").map((part) => {
      const at = part.indexOf("=")
      return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()] as const
    })))
  const trusted = signatures.filter((tags) => verified.includes(tags.get("d")?.toLowerCase() ?? ""))
  if (trusted.length !== 1 || trusted[0]!.has("l") ||
      !["from", "content-type"].every((name) => trusted[0]!.get("h")?.toLowerCase().split(":").map((h) => h.trim()).includes(name)))
    return "ignored"
  const reports = report.attachments.filter((a) => a.mimeType === "message/feedback-report")
  const originals = report.attachments.filter((a) => ["message/rfc822", "text/rfc822-headers"].includes(a.mimeType))
  if (reports.length !== 1 || originals.length !== 1) return "ignored"
  let fields: Email, original: Email
  try {
    fields = await PostalMime.parse(reports[0]!.content, parseOptions)
    original = await PostalMime.parse(originals[0]!.content, parseOptions)
  } catch { return "ignored" }
  if (one(fields, "feedback-type")?.toLowerCase() !== "abuse" || one(fields, "version") !== "1" || !one(fields, "user-agent"))
    return "ignored"
  const sender = mailbox(one(fields, "original-mail-from"))
  const messageId = one(original, "message-id")?.trim()
  const match = /^<([a-f0-9-]{36})@([^<>]+)>$/i.exec(messageId ?? "")
  if (!sender || !match || !z.uuid().safeParse(match[1]).success ||
      original.from?.address?.toLowerCase() !== sender || sender.split("@")[1] !== match[2]) return "ignored"
  const recipients = [...new Set(values(fields, "original-rcpt-to").map(mailbox))]
  if (!recipients.length || recipients.length > 50 || recipients.some((recipient) => !recipient)) return "ignored"
  let row
  try {
    const inbox = await service.store.deliveryInbox(sender, match[1]!)
    row = await service.store.message(inbox.id, messageId!)
  } catch (error) {
    if (error instanceof MailError && error.status === 404) return "ignored"
    throw error
  }
  if (row.id !== match[1] || row.direction !== "sent" ||
      recipients.some((recipient) => ![...row.data.to, ...row.data.cc, ...row.data.bcc].includes(recipient!))) return "ignored"
  const eventId = "feedback:" + fingerprint(raw)
  let updated = false
  for (const recipient of recipients) {
    const result = await ingestGatewayDelivery(service, {
      eventId, trackingId: row.id, messageId: row.wire_id, sender, recipient: recipient!,
      status: "complained", occurredAt: new Date().toISOString(), reason: "Verified provider abuse report",
    })
    updated ||= result === "updated"
  }
  return updated ? "updated" : "ignored"
}
