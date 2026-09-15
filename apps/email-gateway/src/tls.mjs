import { readFile, writeFile, mkdir, chmod, rename, rm } from 'node:fs/promises'
import { createHash, createPrivateKey, X509Certificate, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'

export async function stageTls(source, directory, previous) {
  const [certificate, privateKey] = await Promise.all([
    readFile(source.certificate, 'utf8'), readFile(source.privateKey, 'utf8'),
  ])
  const leaf = new X509Certificate(certificate)
  if (!leaf.checkPrivateKey(createPrivateKey(privateKey)) || !leaf.checkHost(source.hostname) ||
      Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now())
    throw new Error('SMTP certificate does not match its key, hostname, or validity period')
  tls.createSecureContext({ cert: certificate, key: privateKey })
  const bundle = privateKey.trim() + '\n' + certificate.trim() + '\n'
  const version = createHash('sha256').update(bundle).digest('hex')
  if (previous?.version === version) return previous
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const chainPath = directory + '/server.pem'
  const temporary = directory + '/.' + randomUUID() + '.pem'
  try {
    // The root entrypoint owns this file. Postfix loads TLS before dropping privileges.
    await writeFile(temporary, bundle, { mode: 0o600, flag: 'wx' })
    await rename(temporary, chainPath)
  } finally { await rm(temporary, { force: true }) }
  return { chainPath, certificate, version, fingerprint: leaf.fingerprint256 }
}

function reply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const clean = () => {
      socket.off('data', data); socket.off('error', failed); socket.off('end', ended)
    }
    const failed = (error) => { clean(); reject(error) }
    const ended = () => failed(new Error('SMTP closed before replying'))
    const data = (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 8192) return failed(new Error('SMTP reply is too large'))
      const lines = buffer.split('\r\n')
      if (lines.slice(0, -1).some((line) => /^[0-9]{3} /.test(line))) {
        clean()
        resolve(buffer)
      }
    }
    socket.on('data', data); socket.once('error', failed); socket.once('end', ended)
  })
}

export async function probeStarttls(hostname, staged, port = 25) {
  const socket = net.connect({ host: '127.0.0.1', port })
  let secure
  socket.setTimeout(3000, () => socket.destroy(new Error('SMTP health check timed out')))
  try {
    if (!(await reply(socket)).startsWith('220 ')) throw new Error('SMTP greeting failed')
    socket.write('EHLO ' + hostname + '\r\n')
    const capabilities = await reply(socket)
    if (!/^250[- ]STARTTLS\r?$/im.test(capabilities)) throw new Error('SMTP does not offer STARTTLS')
    socket.write('STARTTLS\r\n')
    if (!(await reply(socket)).startsWith('220 ')) throw new Error('SMTP refused STARTTLS')
    socket.setTimeout(0)
    // Trust the staged certificate, including a leaf issued by Caddy's intermediate.
    secure = tls.connect({ socket, servername: hostname, ca: staged.certificate,
      allowPartialTrustChain: true, minVersion: 'TLSv1.2' })
    secure.setTimeout(3000, () => secure.destroy(new Error('SMTP TLS health check timed out')))
    await once(secure, 'secureConnect')
    if (secure.getPeerCertificate().fingerprint256 !== staged.fingerprint)
      throw new Error('SMTP is serving a different certificate')
    secure.write('EHLO ' + hostname + '\r\n')
    if (!(await reply(secure)).startsWith('250')) throw new Error('Encrypted SMTP greeting failed')
    secure.write('QUIT\r\n')
    if (!(await reply(secure)).startsWith('221 ')) throw new Error('Encrypted SMTP close failed')
  } finally { secure?.destroy(); socket.destroy() }
}
