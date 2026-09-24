import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
test('a real stdio client discovers the catalog and calls the API through the client', async () => {
  let requests = 0
  const api = createServer((request, response) => {
    requests++; assert.equal(request.headers.authorization, 'Bearer bze_test')
    assert.equal(request.url, '/v1/inboxes?limit=50')
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ inboxes: [] }))
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const client = new Client({ name: 'stdio-proof', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
    env: { GOSHENEMAIL_API_KEY: 'bze_test', GOSHENEMAIL_BASE_URL: `http://127.0.0.1:${api.address().port}` }, stderr: 'pipe' })
  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    assert.equal(tools.length, 17)
    assert.equal(tools.find(tool => tool.name === 'send').annotations.readOnlyHint, false)
    assert.equal(tools.find(tool => tool.name === 'send').annotations.destructiveHint, true)
    assert.equal(tools.find(tool => tool.name === 'delete_inbox').annotations.destructiveHint, true)
    assert.deepEqual((await client.callTool({ name: 'list_inboxes', arguments: {} })).structuredContent, { result: { inboxes: [] } })
    assert.equal(requests, 1)
  } finally { await client.close(); await new Promise(resolve => api.close(resolve)) }
})
