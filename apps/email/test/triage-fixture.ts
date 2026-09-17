import { TriageError, type TriageAnalyzer } from "../src/triage.js"
import { triageCategory, type TriageResult } from "../src/triage-contract.js"

// Deterministic UI and client fixtures. These values are not Jev evaluations.
export const fixtureTriage: TriageAnalyzer = async message => {
  if (message.data.subject.includes("Pending analysis")) throw new TriageError("provider_unavailable", true)
  if (message.data.subject.includes("Unavailable analysis")) throw new TriageError("provider_rejected", false)
  const category = message.data.subject.includes("outage") ? "support" : message.data.subject.includes("newsletter") ? "notification" : "billing"
  const uncertain = message.data.subject.includes("Ambiguous")
  const urgency = category === "support" ? "critical" : category === "notification" ? "low" : "normal"
  const score = urgency === "critical" ? 3 : urgency === "low" ? 0 : 1
  return {
    status: "complete", version: 1, model: "fixture-not-live-jev", analyzedAt: new Date().toISOString(), durationMs: 12, bodyTruncated: false,
    usage: { inputTokens: 250, outputTokens: 40 },
    category: { value: category, confidence: uncertain ? 0.3 : 1,
      probabilities: Object.fromEntries(triageCategory.options.map(value => [value, value === category ? 1 : 0])) as TriageResult["category"]["probabilities"] },
    needsReply: { value: uncertain ? null : category !== "notification", probability: uncertain ? 0.5 : category === "notification" ? 0.01 : 0.98 },
    urgency: { value: uncertain ? null : urgency, score, confidence: uncertain ? 0.3 : 1,
      probabilities: { "0": score === 0 ? 1 : 0, "1": score === 1 ? 1 : 0, "2": 0, "3": score === 3 ? 1 : 0 } },
  }
}
