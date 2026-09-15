import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { MailError } from "./contracts.js"

export const fingerprint = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")
export const equalSecret = (left: string, right: string): boolean => {
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}
export const signEvent = (
  secret: string,
  id: string,
  timestamp: string,
  body: string
): string =>
  `v1,${createHmac(
    "sha256",
    Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  )
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`

export const signDownload = (
  secret: string,
  path: string,
  expires: string
): string =>
  createHmac("sha256", secret)
    .update(`attachment\n${path}\n${expires}`)
    .digest("hex")

export const validateUrl = (value: string): URL => {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new MailError(
      "Service URLs must use HTTPS",
      "configuration_error",
      503
    )
  return url
}

export const readBytes = async (
  stream: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Uint8Array> => {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new MailError(
          "Message exceeds size limit",
          "payload_too_large",
          413
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
