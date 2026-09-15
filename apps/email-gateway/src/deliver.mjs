import { workerClient } from './worker-client.mjs'
import { readFile } from 'node:fs/promises'
import { requestScan } from './scanner.mjs'
import { isIP } from 'node:net'

// Postfix runs this program once per envelope recipient and retains retries.
try {
  const config = JSON.parse(await readFile('/etc/bezalel-email/worker.json', 'utf8'))
  const recipient = process.argv[2]
  if (!recipient || !/^[^\s<>@]+@[^\s<>@]+$/.test(recipient)) process.exit(67)
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 25 * 1024 * 1024) process.exit(65)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  const protection = await requestScan('http://127.0.0.1:8080', config.token, raw, {
    recipient, sender: process.argv[3] === '<>' ? '' : (process.argv[3] ?? ''),
    ...(isIP(process.argv[4] ?? '') ? { ip: process.argv[4] } : {}),
    ...(process.argv[5] ? { helo: process.argv[5] } : {}),
  })
  const result = await workerClient(config).receive(recipient, raw, protection)
  process.exit(result === 'delivered' ? 0 : 67)
} catch {
  // EX_TEMPFAIL leaves the accepted message in Postfix's persistent queue.
  process.exit(75)
}
