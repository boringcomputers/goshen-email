import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../dist/index.js'
async function cli(args, stdin = '') {
  const output = [], errors = []; let calls = 0
  const code = await run(args, { env: { BEZALEL_API_KEY: 'bze_secret' }, readStdin: async () => stdin,
    out: text => output.push(text), error: text => errors.push(text), fetch: async () => { calls++; return Response.json({ inboxes: [] }) } })
  return { code, output, errors, calls }
}
test('dry run validates without contacting the API or exposing credentials', async () => {
  const result = await cli(['messages', 'send', '--inbox-id', 'me@example.com', '--to', 'you@example.net', '--text', 'Hi', '--idempotency-key', 'stable', '--dry-run'])
  assert.equal(result.code, 0); assert.equal(result.calls, 0)
  const preview = JSON.parse(result.output[0]); assert.equal(JSON.parse(preview.body).idempotencyKey, 'stable')
  assert.ok(!result.output.join('').includes('bze_secret'))
})
test('schema is available without credentials or network', async () => {
  const result = await cli(['--schema']); assert.equal(result.code, 0); assert.equal(result.calls, 0)
  assert.equal(Object.keys(JSON.parse(result.output[0])).length, 17)
})
test('invalid values, flags and missing idempotency keys fail locally', async () => {
  for (const args of [
    ['messages', 'list', '--inbox-id', 'me@example.com', '--limit', 'oops'],
    ['messages', 'send', '--inbox-id', 'me@example.com', '--to', 'you@example.net', '--text', 'Hi'],
    ['inboxes', 'create', '--unknown', 'x'],
  ]) { const result = await cli(args); assert.equal(result.code, 1); assert.equal(result.calls, 0); assert.equal(result.output.length, 0) }
})
test('accepts JSON stdin and writes machine-readable output', async () => {
  const result = await cli(['inboxes', 'list', '--json', '-'], '{}')
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.output[0]), { inboxes: [] }); assert.equal(result.calls, 1)
})
