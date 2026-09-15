import { z } from "zod"

const result = z.enum(["pass", "fail", "none", "temperror", "permerror", "unavailable"])
export const messageProtection = z.object({
  status: z.enum(["clean", "quarantined", "released"]),
  scannedAt: z.iso.datetime({ offset: true }),
  authentication: z.object({
    spf: result, dkim: result, dmarc: result,
    signingDomains: z.array(z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)).max(20),
  }),
  spam: z.object({ score: z.number().finite(), threshold: z.number().finite().positive() }),
  antivirus: z.object({
    status: z.enum(["clean", "infected", "unscannable"]),
    signatures: z.array(z.string().max(1000).refine((v) => !/[\x00-\x1f\x7f]/.test(v))).max(20),
  }),
  reasons: z.array(z.enum(["malware", "spam", "authentication_failed", "scan_incomplete"])).max(4),
  releasedAt: z.iso.datetime({ offset: true }).optional(),
  releasedBy: z.string().min(1).max(200).optional(),
})
export type MessageProtection = z.infer<typeof messageProtection>
export const inboundProtection = messageProtection.refine((value) =>
  value.status !== "released" && !value.releasedAt && !value.releasedBy &&
  (value.status === "quarantined") === (value.reasons.length > 0) &&
  (value.antivirus.status === "infected") === value.reasons.includes("malware") &&
  (value.antivirus.status === "unscannable") === value.reasons.includes("scan_incomplete"))
export type InboundScanner = (raw: Uint8Array, envelope: { sender: string; recipient: string }) => Promise<MessageProtection>
