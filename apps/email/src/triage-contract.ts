import { z } from "zod"

export const triageCategory = z.enum(["billing", "support", "sales", "personal", "notification", "other"])
export const triageUrgency = z.enum(["low", "normal", "high", "critical"])
const probability = z.number().min(0).max(1)
export const triageResult = z.object({
  status: z.literal("complete"),
  version: z.literal(1),
  model: z.string().min(1).max(100),
  analyzedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  bodyTruncated: z.boolean(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
  category: z.object({ value: triageCategory, confidence: probability, probabilities: z.record(triageCategory, probability) }),
  needsReply: z.object({ value: z.boolean().nullable(), probability }),
  urgency: z.object({ value: triageUrgency.nullable(), score: z.number().min(0).max(3), confidence: probability,
    probabilities: z.record(z.enum(["0", "1", "2", "3"]), probability) }),
})
export const messageTriage = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("failed"), code: z.enum(["provider_unavailable", "provider_rejected", "invalid_response"]), failedAt: z.iso.datetime() }),
  triageResult,
])
export type MessageTriage = z.infer<typeof messageTriage>
export type TriageResult = z.infer<typeof triageResult>
export const triageFilters = {
  category: triageCategory.optional(),
  needsReply: z.enum(["yes", "no", "uncertain"]).optional(),
  urgency: triageUrgency.optional(),
}
export type TriageFilters = { category?: z.infer<typeof triageCategory>; needsReply?: "yes" | "no" | "uncertain"; urgency?: z.infer<typeof triageUrgency> }

// Parameters start at $6 after the existing pagination parameters. Null triage
// never matches a filter, including needsReply=uncertain.
export const triageFilterSql = (column: string) => `
  and ($6::text is null or (${column}->>'status' = 'complete' and ${column}->'category'->>'value' = $6))
  and ($7::text is null or (${column}->>'status' = 'complete' and
    coalesce(${column}->'needsReply'->>'value', 'uncertain') = case $7 when 'yes' then 'true' when 'no' then 'false' else 'uncertain' end))
  and ($8::text is null or (${column}->>'status' = 'complete' and ${column}->'urgency'->>'value' = $8))`
export const triageFilterParams = (options: TriageFilters) => [options.category ?? null, options.needsReply ?? null, options.urgency ?? null]
