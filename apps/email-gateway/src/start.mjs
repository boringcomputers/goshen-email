import { mkdir, writeFile, access, chown, chmod, stat } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { z } from 'zod'
import { gatewayServer, makeTransport } from './server.mjs'
import { workerClient } from './worker-client.mjs'
import { socketmapServer } from './socketmap.mjs'
import { postfixConfiguration, smtpDnsFilter } from './postfix.mjs'
import { stageTls, probeStarttls } from './tls.mjs'
import { DeliveryJournal } from './journal.mjs'
import { makeScanner, checkScanners } from './scanner.mjs'

const parsed = z.object({
  MAIL_GATEWAY_HOSTNAME: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  MAIL_GATEWAY_TOKEN: z.string().min(32),
  MAIL_WORKER_URL: z.url().refine((value) => new URL(value).protocol === 'https:' && !new URL(value).username && !new URL(value).password),
}).safeParse(process.env)
if (!parsed.success) {
  console.error('Mail gateway configuration is incomplete')
  process.exit(1)
}
const env = parsed.data
const config = { workerUrl: env.MAIL_WORKER_URL, token: env.MAIL_GATEWAY_TOKEN }
const client = workerClient(config)
const hostname = env.MAIL_GATEWAY_HOSTNAME
const certificate = process.env.MAIL_TLS_CERT_FILE ?? `/certs/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${hostname}/${hostname}.crt`
const privateKey = process.env.MAIL_TLS_KEY_FILE ?? `/certs/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${hostname}/${hostname}.key`
if (![certificate, privateKey].every((value) => /^\/[a-zA-Z0-9/_.-]+$/.test(value))) throw new Error('Invalid TLS file paths')
await mkdir('/etc/bezalel-email', { recursive: true, mode: 0o750 })
await chown('/etc/bezalel-email', 0, 65534)
await writeFile('/etc/bezalel-email/worker.json', JSON.stringify(config), { mode: 0o640 })
await chmod('/etc/bezalel-email/worker.json', 0o640)
await chown('/etc/bezalel-email/worker.json', 0, 65534)

let postfix
let shuttingDown = false
let healthy = false
let trackingHealthy = true
let scannersHealthy = false
const scanConfig = { rspamdUrl: 'http://rspamd:11333', antivirusHost: 'antivirus', antivirusPort: 3310 }
const journal = new DeliveryJournal('/var/spool/postfix/bezalel')
const transport = makeTransport(hostname)
const server = gatewayServer(config, transport,
  () => healthy && trackingHealthy && scannersHealthy && postfix?.exitCode === null, journal, makeScanner(scanConfig))
server.listen(8080, '0.0.0.0')
const socketmap = socketmapServer(client).listen(10031, '127.0.0.1')

for (;;) {
  try { await Promise.all([access(certificate), access(privateKey)]); break } catch {}
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
const source = { certificate, privateKey, hostname }
let staged
try { staged = await stageTls(source, '/etc/postfix/tls') } catch {
  console.error('SMTP TLS credentials are invalid')
  process.exit(1)
}
const files = postfixConfiguration(hostname, staged.chainPath)
await writeFile('/etc/postfix/main.cf', files.main)
await writeFile('/etc/postfix/master.cf', files.master)
await writeFile('/etc/postfix/smtp_dns_reply_filter', smtpDnsFilter)
execFileSync('postfix', ['check'], { stdio: 'inherit' })
// The delivery program reads its scoped credential file, so Postfix inherits no API secrets.
postfix = spawn('postfix', ['start-fg'], { stdio: 'inherit', env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } })
postfix.once('exit', (code) => {
  if (!shuttingDown) process.exit(code || 1)
})
for (let attempt = 0; attempt < 20; attempt++) {
  try { await probeStarttls(hostname, staged); healthy = true; break } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!healthy) {
  console.error('SMTP STARTTLS readiness failed')
  try { execFileSync('postfix', ['stop'], { stdio: 'inherit' }) } catch {}
  process.exit(1)
}
let checking = false
let scanningHealth = false
const scanHealth = async () => {
  if (scanningHealth) return
  scanningHealth = true
  try { await checkScanners(scanConfig); scannersHealthy = true } catch {
    scannersHealthy = false
    console.error('Incoming mail scanners are unavailable')
  } finally { scanningHealth = false }
}
await scanHealth()
const scanReadiness = setInterval(scanHealth, 15000)
const renew = setInterval(async () => {
  if (checking) return
  checking = true
  try {
    try {
      const next = await stageTls(source, '/etc/postfix/tls', staged)
      if (next !== staged) {
        execFileSync('postfix', ['reload'], { stdio: 'inherit' })
        staged = next
      }
    } catch { console.error('Could not refresh SMTP TLS credentials') }
    await probeStarttls(hostname, staged)
    healthy = true
  } catch {
    healthy = false
    console.error('SMTP STARTTLS readiness failed')
  } finally {
    checking = false
  }
}, 30000)

let reading = false
let collecting = false
const track = setInterval(async () => {
  if (reading || collecting) return
  reading = true
  try { await journal.readLogs(); trackingHealthy = true } catch {
    trackingHealthy = false
    console.error('SMTP delivery journal is unavailable')
  } finally { reading = false }
}, 1000)
let delivering = false
const report = setInterval(async () => {
  if (delivering) return
  delivering = true
  try { await journal.flush(client) } catch {
    trackingHealthy = false
    console.error('SMTP delivery reports could not be stored')
  } finally { delivering = false }
}, 1000)
const collect = setInterval(async () => {
  if (collecting || reading) return
  collecting = true
  try {
    await journal.collect()
    const log = await stat('/var/spool/postfix/bezalel/postfix.log').catch(() => null)
    if (log && log.size >= 20 * 1024 * 1024) execFileSync('postfix', ['logrotate'], { stdio: 'inherit' })
  } catch { console.error('SMTP journal maintenance failed') }
  finally { collecting = false }
}, 60000)

const stop = () => {
  shuttingDown = true
  clearInterval(renew)
  clearInterval(scanReadiness)
  clearInterval(track)
  clearInterval(report)
  clearInterval(collect)
  server.close()
  socketmap.close()
  transport.close()
  journal.close()
  try { execFileSync('postfix', ['stop'], { stdio: 'inherit' }) } catch {}
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
