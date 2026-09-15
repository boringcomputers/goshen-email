import net from 'node:net'

export function socketmapServer(client) {
  return net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let reading = false
    socket.setTimeout(30000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 20000) return socket.destroy()
      void drain()
    })
    async function drain() {
      if (reading) return
      reading = true
      try {
        while (!socket.destroyed) {
          const colon = buffer.indexOf(58)
          if (colon < 0) {
            if (buffer.length > 5) socket.destroy()
            break
          }
          const prefix = buffer.subarray(0, colon).toString('ascii')
          if (!/^(?:0|[1-9][0-9]{0,4})$/.test(prefix) || Number(prefix) > 10000) return socket.destroy()
          const end = colon + 1 + Number(prefix)
          if (buffer.length <= end) break
          if (buffer[end] !== 44) return socket.destroy()
          const value = buffer.subarray(colon + 1, end).toString('utf8')
          buffer = buffer.subarray(end + 1)
          const [name, ...key] = value.split(' ')
          let reply = 'NOTFOUND '
          try {
            if (name === 'domains' || name === 'recipients') {
              const allowed = await client.allowed(name === 'domains' ? 'domain' : 'recipient', key.join(' '))
              if (allowed) reply = 'OK 1'
            }
          } catch {
            reply = 'TEMP Email lookup unavailable'
          }
          socket.write(`${Buffer.byteLength(reply)}:${reply},`)
        }
      } finally { reading = false }
    }
  })
}
