import { processTriage } from "./triage-worker.js"
import type { TriageAnalyzer } from "./triage.js"
import type { Metering } from "./metering.js"
import type { BillingHold } from "./billing.js"
import { clientEventTarget } from "./mail-clients.js"
import { initialDelivery, deliveryEvent } from "./delivery.js"
import PostalMime, { type Address } from "postal-mime"
import { compile } from "html-to-text"
import {
  MailError,
  type Attachment,
  inputs,
  address as emailAddress,
  type Input,
  type MailConfig,
  type MailData,
  type MessageRow,
  type ObjectStore,
  type Operation,
  type SendResult,
  type Transport
} from "./contracts.js"
import { MailboxStore, emptyMail } from "./mailbox-store.js"
import type { CustomDomains } from "./custom-domains.js"
import { inboundProtection, type InboundScanner, type MessageProtection } from "./protection.js"
import {
  fingerprint,
  signDownload,
  signEvent,
  validateUrl
} from "./security.js"

const asIso = (value: unknown): string | undefined =>
  value ? new Date(String(value)).toISOString() : undefined
const inboxView = (row: {
  address: string
  display_name: string | null
  created_at: string
}) => ({
  inboxId: row.address,
  address: row.address,
  ...(row.display_name ? { displayName: row.display_name } : {}),
  createdAt: row.created_at
})
const addresses = (values: Address[] | undefined): string[] =>
  (values ?? []).flatMap((value) =>
    "group" in value
      ? addresses(value.group)
      : value.address
        ? [clean(value.address.toLowerCase())]
        : []
  )
const references = (value: string | undefined): string[] =>
  (value?.match(/<[^<>\s]+>/g) ?? [])
    .filter((id) => id.length <= 998 && !/[\u0000-\u001f\u007f]/.test(id))
    .slice(-50)
const short = (value: string, limit: number): string =>
  value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "")
const clean = (value: string): string =>
  value.replace(/\0/g, "").replace(/[\uD800-\uDFFF]/gu, "\uFFFD")
const htmlToText = compile({
  wordwrap: false,
  limits: { maxInputLength: 25 * 1024 * 1024, maxDepth: 100 },
  selectors: [{ selector: "img", format: "skip" }]
})
const plainText = (text?: string, html?: string): string =>
  clean(text?.trim() ? text : html ? htmlToText(html) : "")
const summary = (row: MessageRow, inboxId: string) => ({
  ...(row.protection ? { protection: row.protection } : {}),
  ...(row.triage && row.protection?.status !== "quarantined" ? { triage: row.triage } : {}),
  messageId: row.wire_id,
  threadId: row.thread_id,
  inboxId,
  from: row.data.from,
  to: row.data.to,
  subject: row.data.subject,
  preview: row.protection?.status === "quarantined" ? "" : short(row.data.text ?? "", 200),
  timestamp: row.timestamp,
  labels: row.labels,
  attachments: row.data.attachments.map(({ objectKey: _, ...a }) => a)
})
const messageView = (
  row: MessageRow,
  inboxId: string,
  includeHtml: boolean,
  ownerReview = false
) => ({
  ...summary(row, inboxId),
  ...(row.delivery ? { delivery: row.delivery } : {}),
  cc: row.data.cc,
  replyTo: row.data.replyTo,
  ...(row.direction === "sent" ? { bcc: row.data.bcc } : {}),
  ...(row.protection?.status !== "quarantined" || ownerReview ? {
    text: row.data.text,
    ...(includeHtml ? { html: row.data.html } : {})
  } : {})
})
const offsetOf = (token?: string): number => {
  if (token === undefined) return 0
  if (!/^\d{1,7}$/.test(token)) throw new MailError("Invalid page token")
  return Number(token)
}
const nextPage = (rows: unknown[], limit: number, offset: number) =>
  rows.length > limit ? { nextPageToken: String(offset + limit) } : {}

export class MailService {
  readonly store: MailboxStore
  readonly objects: ObjectStore
  readonly transport: Transport
  readonly config: MailConfig
  readonly request: typeof fetch
  readonly customDomains?: CustomDomains
  readonly scanner?: InboundScanner
  readonly triageAnalyzer?: TriageAnalyzer
  readonly metering?: Metering
  constructor(deps: {
    store: MailboxStore
    objects: ObjectStore
    transport: Transport
    config: MailConfig
    request?: typeof fetch
    customDomains?: CustomDomains
    scanner?: InboundScanner
    triageAnalyzer?: TriageAnalyzer
    metering?: Metering
  }) {
    this.store = deps.store
    this.objects = deps.objects
    this.transport = deps.transport
    this.config = deps.config
    this.request = deps.request ?? fetch.bind(globalThis)
    this.customDomains = deps.customDomains
    this.scanner = deps.scanner
    this.triageAnalyzer = deps.triageAnalyzer
    this.metering = deps.metering
  }

  async execute(operation: Operation, raw: unknown, testing = false): Promise<unknown> {
    const parsed = inputs[operation].safeParse(raw)
    if (!parsed.success)
      throw new MailError("Invalid email request", "invalid_request", 400)
    const value = parsed.data
    if ("inboxId" in value && typeof value.inboxId === "string") {
      try {
        const inbox = await this.store.inbox(value.inboxId)
        if (inbox.testing !== testing)
          throw new MailError("Inbox not found", "not_found", 404)
      } catch (error) {
        if (error instanceof MailError && error.code === "not_found" &&
            (operation === "inboxExists" || operation === "deleteInbox")) return false
        throw error
      }
    }
    // Each branch reparses to preserve the operation's input type.
    switch (operation) {
      case "createInbox": {
        const input = inputs.createInbox.parse(value)
        const domain = input.domain ?? this.config.defaultDomain
        if (!domain) throw new MailError("Configure an email domain before creating inboxes", "domain_not_configured", 422)
        await this.store.assertUnscopedDomain(domain)
        const info = await this.transport.verifyDomain(domain)
        if (info.status !== "VERIFIED")
          throw new MailError(
            "Enable Email Sending and route this domain's catch-all to the email Worker",
            "domain_not_ready",
            422
          )
        await this.store.saveDomain(info)
        const username =
          input.username?.toLowerCase() ??
          `agent-${crypto.randomUUID().slice(0, 12)}`
        if (!emailAddress.safeParse(`${username}@${domain}`).success)
          throw new MailError("This address is too long. Choose a shorter username or domain.", "invalid_argument", 422)
        await this.transport.ensureInboxRoute?.(`${username}@${domain}`)
        return inboxView(
          await this.store.createInbox(
            `${username}@${domain}`,
            domain,
            input.displayName,
            testing
          )
        )
      }
      case "listInboxes":
        return { inboxes: (await this.store.listInboxes(testing)).map(inboxView) }
      case "inboxQuota":
        return {
          count: (await this.store.listInboxes(testing)).length,
          limit: null
        }
      case "inboxExists": {
        try {
          await this.store.inbox(inputs.inboxExists.parse(value).inboxId)
          return true
        } catch (error) {
          if (error instanceof MailError && error.status === 404)
            return false
          throw error
        }
      }
      case "deleteInbox":
        return this.store.deleteInbox(
          inputs.deleteInbox.parse(value).inboxId
        )
      case "send":
        return this.send(inputs.send.parse(value))
      case "reply":
        return this.reply(inputs.reply.parse(value))
      case "getMessage": {
        const input = inputs.getMessage.parse(value)
        const inbox = await this.store.inbox(input.inboxId)
        return messageView(
          await this.store.message(inbox.id, input.messageId),
          inbox.address,
          input.includeHtml
        )
      }
      case "listMessages":
      case "searchMessages": {
        const input =
          operation === "listMessages"
            ? inputs.listMessages.parse(value)
            : inputs.searchMessages.parse(value)
        const inbox = await this.store.inbox(input.inboxId)
        const offset = offsetOf(input.pageToken)
        const rows = await this.store.listMessages(inbox.id, {
          ...input,
          offset
        })
        return {
          messages: rows
            .slice(0, input.limit)
            .map((row) => summary(row, inbox.address)),
          ...nextPage(rows, input.limit, offset)
        }
      }
      case "listThreads": {
        const input = inputs.listThreads.parse(value)
        const inbox = await this.store.inbox(input.inboxId)
        const offset = offsetOf(input.pageToken)
        const rows = await this.store.listThreads(inbox.id, {
          ...input,
          offset
        })
        return {
          threads: rows.slice(0, input.limit).map((row) => ({
            threadId: row.thread_id,
            inboxId: inbox.address,
            subject: row.subject,
            preview: row.preview ?? "",
            timestamp: asIso(row.timestamp),
            messageCount: row.message_count,
            labels: row.labels,
            receivedTimestamp: asIso(row.received_timestamp),
            sentTimestamp: asIso(row.sent_timestamp),
            lastMessageId: row.last_message_id,
            senders: row.senders,
            recipients: row.recipients,
            ...(row.triage ? { triage: row.triage } : {}),
            attachmentCount: row.attachment_count
          })),
          ...nextPage(rows, input.limit, offset)
        }
      }
      case "getThread":
      case "reviewThread": {
        const input = inputs[operation].parse(value)
        const inbox = await this.store.inbox(input.inboxId)
        const rows = await this.store.thread(
          inbox.id,
          input.threadId,
          input.includeBodies
        )
        const last = rows.at(-1)!
        return {
          threadId: input.threadId,
          inboxId: inbox.address,
          subject: last.data.subject,
          timestamp: last.timestamp,
          preview: summary(last, inbox.address).preview,
          messageCount: rows.length,
          labels: [...new Set(rows.flatMap((row) => row.labels))],
          senders: [...new Set(rows.map((row) => row.data.from))],
          recipients: [...new Set(rows.flatMap((row) => row.data.to))],
          ...(last.triage && last.protection?.status !== "quarantined" ? { triage: last.triage } : {}),
          messages: rows.map((row) =>
            input.includeBodies
              ? messageView(row, inbox.address, true, operation === "reviewThread")
              : summary(row, inbox.address)
          )
        }
      }
      case "updateMessageLabels":
      case "updateThreadLabels": {
        const input = inputs[operation].parse(value)
        if ([...input.addLabels, ...input.removeLabels].includes("quarantined"))
          throw new MailError("Quarantine requires owner review", "quarantine_review_required", 403)
        const inbox = await this.store.inbox(input.inboxId)
        if ("messageId" in input) {
          await this.store.updateMessageLabels(inbox.id, input.messageId, input.addLabels, input.removeLabels)
        } else {
          await this.store.updateLabels(inbox.id, input.threadId, input.addLabels, input.removeLabels)
        }
        return null
      }
      case "getAttachment":
        return this.attachment(inputs.getAttachment.parse(value))
      case "releaseQuarantine":
        return this.releaseQuarantine(inputs.releaseQuarantine.parse(value))
      case "createDomain": {
        if (!this.customDomains)
          throw new MailError("Custom email domains are not configured on this deployment", "not_configured", 503)
        return this.customDomains.create(inputs.createDomain.parse(value).domain)
      }
      case "verifyDomain": {
        const domain = inputs.verifyDomain.parse(value).domainId
        await this.store.assertUnscopedDomain(domain)
        const info = await this.transport.verifyDomain(domain)
        await this.store.saveDomain(info)
        return info
      }
      case "listDomains":
        return (await this.store.domains()).filter(
          (domain) => domain.status !== "DELETED"
        )
      case "deleteDomain":
        return this.store.deleteDomain(
          inputs.deleteDomain.parse(value).domainId
        )
      case "ensureWebhook": {
        if (!this.config.eventsUrl)
          throw new MailError("Set MAIL_EVENTS_URL to enable a shared webhook", "not_configured", 503)
        if (
          new URL(inputs.ensureWebhook.parse(value).url).href !==
          validateUrl(this.config.eventsUrl).href
        )
          throw new MailError(
            "Webhook URL must match the configured event destination",
            "webhook_url_mismatch",
            422
          )
        return {
          status: this.webhookStatus(),
          secret: this.config.webhookSecret
        }
      }
      case "webhookStatus":
        return this.webhookStatus()
    }
  }

  webhookStatus() {
    return {
      configured: Boolean(
        this.config.eventsUrl && this.config.webhookSecret
      ),
      webhookId: "cloudflare-email",
      url: this.config.eventsUrl
    }
  }

  async send(
    input: Input<"send">,
    reply?: { threadId: string; references: string[] }
  ): Promise<SendResult> {
    let inbox = await this.store.inbox(input.inboxId)
    const signature = fingerprint(JSON.stringify({ input, reply }))
    // One send unit is held before the reservation exists, so a denied send leaves
    // no record and the same idempotencyKey succeeds after the customer upgrades.
    // A key whose reservation will be answered as-is skips the hold: retries of a
    // completed send must return its result even when the allowance is spent.
    // The hold is confirmed after commit and released on every other exit.
    const customer = this.metering ? await this.store.inboxCustomer(inbox.id) : null
    const hold = this.metering && customer && !(await this.store.sendSettled(inbox.id, input.idempotencyKey))
      ? await this.metering.holdSend(customer) : null
    const settle = (action: "confirm" | "release") => this.metering?.settle(hold, action) ?? Promise.resolve()
    let existing
    try {
      existing = await this.store.reserveSend(inbox.id, input.idempotencyKey, signature)
    } catch (error) {
      await settle("release")
      throw error
    }
    if (existing) {
      await settle("release")
      if (existing.fingerprint !== signature)
        throw new MailError(
          "Idempotency key was used for a different email",
          "idempotency_conflict",
          409
        )
      if (existing.state === "sent" && existing.result)
        return { ...existing.result, deduplicated: true }
      if (existing.state === "failed" && existing.error)
        throw new MailError(
          existing.error.message,
          existing.error.code,
          existing.error.status
        )
      throw new MailError(
        "Send is pending or its outcome is uncertain; it will not be sent again",
        "delivery_uncertain",
        503,
        true
      )
    }
    // A disconnect may have completed between lookup and reservation. Re-read
    // the sender after reserving; the pending send now prevents disconnects.
    inbox = await this.store.inbox(inbox.address)
    const headers: Record<string, string> = {
      "Auto-Submitted": reply ? "auto-replied" : "auto-generated"
    }
    if (reply?.references.length) {
      headers["In-Reply-To"] = reply.references.at(-1)!
      headers.References = reply.references
        .join(" ")
        .slice(-2000)
        .replace(/^[^<]*/, "")
    }
    const messageId = crypto.randomUUID()
    const attachments: Attachment[] = []
    try {
      if (input.attachments?.length) {
        await this.store.db.query(
          `insert into mail.garbage(prefix, available_at) values ($1, now() + interval '1 day') on conflict do nothing`,
          [`${inbox.id}/${messageId}/`]
        )
      }
      for (const file of input.attachments ?? []) {
        const attachmentId = crypto.randomUUID()
        const objectKey = `${inbox.id}/${messageId}/${attachmentId}`
        const bytes = Buffer.from(file.content, "base64")
        await this.objects.put(objectKey, bytes)
        attachments.push({ attachmentId, objectKey, filename: file.filename, contentType: file.contentType, size: bytes.length })
      }
    } catch {
      const error = new MailError("Attachment storage failed before sending. Retry this request.", "attachment_storage_error", 503)
      await this.store.failSend(inbox.id, input.idempotencyKey, error)
      await settle("release")
      throw error
    }
    let receipt
    try {
      receipt = await this.transport.send({
        trackingId: messageId,
        from: inbox.display_name
          ? { address: inbox.custom_address ?? inbox.address, name: inbox.display_name }
          : inbox.custom_address ?? inbox.address,
        to: input.to,
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        subject: input.subject,
        ...(input.text ? { text: input.text } : {}),
        ...(input.html ? { html: input.html } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        headers
      })
    } catch (error) {
      if (error instanceof MailError && !error.transient)
        await this.store.failSend(inbox.id, input.idempotencyKey, error)
      // An uncertain outcome is not charged either; the reservation already stops a resend.
      await settle("release")
      throw error
    }
    const threadId = reply?.threadId ?? crypto.randomUUID()
    const result = { messageId: receipt.messageId, threadId }
    const row: MessageRow = {
      id: messageId,
      inbox_id: inbox.id,
      wire_id: receipt.messageId,
      thread_id: threadId,
      timestamp: new Date().toISOString(),
      direction: "sent",
      labels: [...new Set(["sent", ...(input.labels ?? [])])],
      data: {
        ...emptyMail(),
        from: inbox.custom_address ?? inbox.address,
        to: input.to,
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        subject: input.subject,
        text: plainText(input.text, input.html),
        html: input.html ?? "",
        references: reply?.references ?? [],
        attachments
      }
    }
    row.delivery = initialDelivery(row, receipt)
    const failed = [...receipt.bounced, ...receipt.suppressed]
    if (failed.length) row.labels.push("bounced")
    const event = failed.length && !inbox.testing
      ? {
          type: "email.bounced",
          inboxId: inbox.address,
          message: summary(row, inbox.address),
          recipients: failed,
          occurredAt: row.timestamp
        }
      : null
    try {
      await this.store.commitMessage(row, event, {
        key: input.idempotencyKey,
        result,
        ...(!inbox.testing ? { deliveryEvent: deliveryEvent(row, inbox.address, row.delivery) } : {})
      })
    } catch (error) {
      await settle("release")
      throw error
    }
    await settle("confirm")
    return result
  }

  async reply(input: Input<"reply">): Promise<SendResult> {
    const inbox = await this.store.inbox(input.inboxId)
    const original = await this.store.message(inbox.id, input.messageId)
    if (original.protection?.status === "quarantined")
      throw new MailError("Release this message before replying", "message_quarantined", 403)
    const from = original.data.replyTo.length
      ? original.data.replyTo
      : [original.data.from]
    const primary = original.direction === "sent" ? original.data.to : from
    const ownAddresses = new Set([inbox.address, ...(inbox.email_aliases ?? [])])
    const to = [...new Set(primary)].filter((a) => !ownAddresses.has(a))
    const cc = input.replyAll
      ? [...new Set([...original.data.to, ...original.data.cc])].filter(
          (a) => !ownAddresses.has(a) && !to.includes(a)
        )
      : []
    const request = inputs.send.safeParse({
      inboxId: inbox.address,
      to: input.to ?? to,
      cc: input.cc ?? (input.to !== undefined ? [] : cc),
      bcc: input.bcc ?? [],
      subject: /^re:/i.test(original.data.subject)
        ? original.data.subject
        : `Re: ${original.data.subject}`,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
      labels: input.labels,
      idempotencyKey: input.idempotencyKey
    })
    if (!request.success)
      throw new MailError(
        "Reply recipients or content are invalid",
        "invalid_reply",
        422
      )
    return this.send(request.data, {
      threadId: original.thread_id,
      references: [...original.data.references, original.wire_id].slice(
        -50
      )
    })
  }

  async receive(
    recipient: string,
    raw: Uint8Array,
    scan?: MessageProtection,
  ): Promise<{ messageId: string; threadId: string }> {
    const inbox = await this.store.inbox(recipient.toLowerCase())
    const protection = scan ? inboundProtection.parse(scan) : undefined
    const parsed = await PostalMime.parse(raw, {
      maxHeadersSize: 128 * 1024,
      maxNestingDepth: 32
    })
    const wireId =
      references(parsed.messageId)[0] ??
      `<${fingerprint(raw)}@inbound.bezalel>`
    try {
      const existing = await this.store.message(inbox.id, wireId)
      return { messageId: existing.wire_id, threadId: existing.thread_id }
    } catch (error) {
      if (!(error instanceof MailError && error.status === 404))
        throw error
    }
    const refs = [
      ...references(parsed.references),
      ...references(parsed.inReplyTo)
    ].slice(-50)
    const threadId = protection?.status === "quarantined" ? crypto.randomUUID() : await this.store.resolveThread(inbox.id, refs)
    const id = crypto.randomUUID()
    await this.store.db.query(
      `insert into mail.garbage(prefix, available_at) values ($1, now() + interval '1 day') on conflict do nothing`,
      [`${inbox.id}/${id}/`]
    )
    const data: MailData = {
      from: addresses(parsed.from ? [parsed.from] : [])[0] ?? "",
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      bcc: [],
      replyTo: addresses(parsed.replyTo),
      subject: clean(parsed.subject ?? ""),
      text: plainText(parsed.text, parsed.html),
      html: clean(parsed.html ?? ""),
      references: refs,
      attachments: []
    }
    for (const attachment of parsed.attachments) {
      const attachmentId = crypto.randomUUID()
      const bytes =
        typeof attachment.content === "string"
          ? Buffer.from(
              attachment.content,
              attachment.encoding === "base64" ? "base64" : "utf8"
            )
          : new Uint8Array(attachment.content)
      const objectKey = `${inbox.id}/${id}/${attachmentId}`
      await this.objects.put(objectKey, bytes)
      data.attachments.push({
        attachmentId,
        filename: clean(attachment.filename || "attachment"),
        contentType: clean(
          attachment.mimeType || "application/octet-stream"
        ),
        size: bytes.byteLength,
        objectKey
      })
    }
    await this.objects.put(`${inbox.id}/${id}/raw.eml`, raw)
    // Quarantined mail is not analysed unless released, so its unit is held at release instead.
    // The hold taken here is confirmed only once the message is stored.
    const triage = protection?.status === "quarantined" ? { enabled: Boolean(this.triageAnalyzer), hold: null } : await this.triageHold(inbox.id)
    const row: MessageRow = {
      id,
      inbox_id: inbox.id,
      wire_id: wireId,
      thread_id: threadId,
      timestamp: new Date().toISOString(),
      direction: "received",
      ...(triage.enabled ? { triage: { status: "pending" as const } } : {}),
      labels: protection?.status === "quarantined" ? ["quarantined"] : ["received", "unread"],
      ...(protection ? { protection } : {}),
      data
    }
    let saved
    try {
      saved = await this.store.commitMessage(row,
        inbox.testing || protection?.status === "quarantined" ? null : this.receivedEvent(row, inbox.address), undefined,
        !parsed.headers.some(header => header.key.toLowerCase() === "auto-submitted" && header.value.toLowerCase() !== "no") &&
        !parsed.headers.some(header => header.key.toLowerCase() === "x-bezalel-notification"))
    } catch (error) {
      await this.metering?.settle(triage.hold, "release")
      throw error
    }
    await this.metering?.settle(triage.hold, "confirm")
    return { messageId: saved.wire_id, threadId: saved.thread_id }
  }

  private receivedEvent(row: MessageRow, address: string) {
    return {
      type: "email.received",
      inboxId: address,
      occurredAt: row.timestamp,
      message: {
        ...summary(row, address),
        text: short(row.data.text, 64 * 1024),
        bodyTruncated: row.data.text.length > 64 * 1024,
        bodiesOmitted: false
      }
    }
  }

  async releaseQuarantine(input: Input<"releaseQuarantine">): Promise<boolean> {
    const inbox = await this.store.inbox(input.inboxId)
    const row = await this.store.message(inbox.id, input.messageId)
    if (row.protection?.status !== "quarantined") return false
    if (row.protection.antivirus.status !== "clean")
      throw new MailError("Attachments did not pass scanning and cannot be released", "malware_blocked", 403)
    const released = { ...row, protection: { ...row.protection, status: "released" as const,
      releasedAt: new Date().toISOString(), releasedBy: input.reviewedBy },
      labels: [...new Set([...row.labels.filter((label) => !["quarantined", "trash"].includes(label)), "received", "unread"])] }
    // Release makes the pending analysis eligible, so its unit is held here and
    // confirmed only if this call is the one that releases the message.
    const triage = row.triage?.status === "pending" ? await this.triageHold(inbox.id) : { enabled: false, hold: null }
    if (row.triage?.status === "pending" && !triage.enabled)
      await this.store.db.query("update mail.messages set triage = null where id = $1 and triage->>'status' = 'pending'", [row.id])
    let result: { status: string } | undefined
    try {
      ;[result] = await this.store.db.query<{ status: string }>(
        "select mail.release_quarantine($1, $2, $3::jsonb, $4::jsonb) as status",
        [inbox.id, row.id, JSON.stringify(released.protection),
          inbox.testing ? null : JSON.stringify(this.receivedEvent(released, inbox.address))])
    } catch (error) {
      await this.metering?.settle(triage.hold, "release")
      throw error
    }
    await this.metering?.settle(triage.hold, result?.status === "released" ? "confirm" : "release")
    if (result?.status === "missing") throw new MailError("Message not found", "not_found", 404)
    if (result?.status === "infected") throw new MailError("Attachments did not pass scanning", "malware_blocked", 403)
    return result?.status === "released"
  }

  /**
   * Whether triage should run for a message, holding the unit that pays for it.
   * Triage runs when the operator enabled it and, under metering, the inbox's
   * account has allowance left. Holding at receipt means a burst of mail cannot
   * overspend; the caller confirms the hold once the message is stored or
   * released, and an analysis that ends in failure refunds the unit.
   */
  private async triageHold(inboxId: string): Promise<{ enabled: boolean; hold: BillingHold | null }> {
    if (!this.triageAnalyzer) return { enabled: false, hold: null }
    if (!this.metering) return { enabled: true, hold: null }
    const customer = await this.store.inboxCustomer(inboxId)
    if (!customer) return { enabled: true, hold: null }
    const { allowed, hold } = await this.metering.holdTriage(customer)
    return { enabled: allowed, hold }
  }

  async processTriage(): Promise<void> {
    if (!this.triageAnalyzer) return
    const metering = this.metering
    await processTriage(this.store.db, this.triageAnalyzer, !metering ? undefined : async (message, status) => {
      if (status !== "failed") return
      const customer = await this.store.inboxCustomer(message.inbox_id)
      if (customer) await metering.refundTriage(customer, message.id)
    })
  }

  async acceptIncoming(recipient: string, raw: Uint8Array, sender?: string): Promise<void> {
    const inbox = await this.store.inbox(recipient.toLowerCase())
    const key = `${inbox.id}/incoming/${crypto.randomUUID()}.eml`
    await this.objects.put(key, raw)
    const rows = await this.store.db.query(
      `insert into mail.incoming(object_key, inbox_id, recipient, envelope_sender)
      select $1, id, address, $3 from mail.inboxes where id = $2 and deleted_at is null
      on conflict (object_key) do update set recipient = excluded.recipient returning object_key`,
      [key, inbox.id, sender ?? null]
    )
    if (!rows.length) {
      await this.objects.delete(key)
      throw new MailError("Inbox not found", "not_found", 404)
    }
  }

  async processIncoming(): Promise<void> {
    for (let processed = 0; processed < 10; processed++) {
      // Start each lease when its work begins; preceding scans may take minutes.
      const [job] = await this.store.db.query<{
        object_key: string
        recipient: string
        attempts: number
        envelope_sender: string | null
      }>(`with due as (
        select object_key from mail.incoming where available_at <= now() order by available_at limit 1 for update skip locked
      ) update mail.incoming i set available_at = now() + interval '5 minutes', attempts = attempts + 1
        from due where i.object_key = due.object_key returning i.object_key, i.recipient, i.attempts, i.envelope_sender`)
      if (!job) break
      try {
        const object = await this.objects.get(job.object_key)
        if (!object) throw new Error("Stored email unavailable")
        const raw = new Uint8Array(
          await new Response(object.body).arrayBuffer()
        )
        const protection = this.scanner ? await this.scanner(raw, { sender: job.envelope_sender ?? "", recipient: job.recipient }) : undefined
        await this.receive(job.recipient, raw, protection)
        await this.store.completeIncoming(job.object_key)
      } catch {
        await this.store.db.query(
          `update mail.incoming set available_at = now() + $2 * interval '1 second' where object_key = $1`,
          [
            job.object_key,
            Math.min(3600, 2 ** Math.min(job.attempts, 12) * 5)
          ]
        )
      }
    }
  }

  async attachment(input: Input<"getAttachment">) {
    const inbox = await this.store.inbox(input.inboxId)
    const row = await this.store.message(inbox.id, input.messageId)
    if (row.protection?.status === "quarantined" || (row.protection && row.protection.antivirus.status !== "clean"))
      throw new MailError("Release this message before downloading attachments", "message_quarantined", 403)
    const attachment = row.data.attachments.find(
      (a) => a.attachmentId === input.attachmentId
    )
    if (!attachment)
      throw new MailError("Attachment not found", "not_found", 404)
    const expires = String(Math.floor(Date.now() / 1000) + 300)
    const url = new URL(
      `/attachments/${inbox.id}/${row.id}/${attachment.attachmentId}`,
      validateUrl(this.config.publicUrl)
    )
    url.searchParams.set("expires", expires)
    url.searchParams.set(
      "signature",
      signDownload(this.config.webhookSecret, url.pathname, expires)
    )
    const { objectKey: _, ...metadata } = attachment
    return {
      ...metadata,
      downloadUrl: url.href,
      expiresAt: new Date(Number(expires) * 1000).toISOString()
    }
  }

  async flushEvents(): Promise<void> {
    for (const event of await this.store.pendingEvents()) {
      const body = JSON.stringify(event.payload)
      const timestamp = String(Math.floor(Date.now() / 1000))
      let delivered = false
      try {
        const target = await clientEventTarget(this, event.inbox_id)
        if (target === null) {
          await this.store.settleEvent(event.id, true, event.attempts)
          continue
        }
        const response = await this.request(
          validateUrl(target.url),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "svix-id": event.id,
              "svix-timestamp": timestamp,
              "svix-signature": signEvent(
                target.secret,
                event.id,
                timestamp,
                body
              )
            },
            body,
            signal: AbortSignal.timeout(10_000),
            redirect: "manual"
          }
        )
        delivered = response.ok
        await response.body?.cancel()
      } catch {
        /* The outbox keeps the event for the next scheduled attempt. */
      }
      await this.store.settleEvent(event.id, delivered, event.attempts)
    }
  }

  async collectGarbage(): Promise<void> {
    const rows = await this.store.db.query<{ prefix: string }>(
      `select prefix from mail.garbage where available_at <= now() order by created_at limit 10`
    )
    for (const row of rows) {
      const objects = await this.objects.list({
        prefix: row.prefix,
        limit: 1000
      })
      if (objects.objects.length)
        await this.objects.delete(objects.objects.map((o) => o.key))
      if (!objects.truncated)
        await this.store.db.query(
          `delete from mail.garbage where prefix = $1`,
          [row.prefix]
        )
    }
  }
}
