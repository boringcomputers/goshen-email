import { z } from "zod"
import { address, inputs } from "./contracts.js"

export const inboxGroup = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/)
export const listAccountInboxes = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  pageToken: z.string().min(1).max(1024).optional(),
  group: inboxGroup.optional(),
}).strict()
export const createAccountInbox = inputs.createInbox.extend({ group: inboxGroup.optional() }).strict()
export const updateAccountInbox = z.object({ inboxId: address, group: inboxGroup.nullable() }).strict()
