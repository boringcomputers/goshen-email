import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dashboardHandler, assets } from '../src/handler.mjs'
import { docsAssets } from '../src/docs-assets.mjs'

// The documentation is generated from Markdown and the OpenAPI document into public/docs and
// committed. These tests hold the generated output to its sources and check that the dashboard
// serves it the same way it serves every other fixed asset: allowlisted path, fixed content type,
// the shared security headers, and nothing else under /docs.
const origin = 'https://dashboard.example'
const password = 'docs-test-dashboard-password-'.repeat(2)
const root = new URL('..', import.meta.url)
const handle = dashboardHandler({ publicUrl: origin, password, asset: async (file) => readFileSync(new URL(`public/${file}`, root)) })
const get = (path) => handle(new Request(origin + path, { headers: { origin } }), { clientIdentity: () => '192.0.2.1' })

test('generated docs match their Markdown and OpenAPI sources', () => {
  execFileSync(process.execPath, ['scripts/build-docs.mjs', '--check'], { cwd: root, stdio: 'pipe' })
})

test('every docs route is allowlisted with a fixed content type and the shared headers', async () => {
  const routes = new Map(docsAssets)
  assert.ok(routes.size > 60, 'guide pages, API pages, Markdown twins, llms.txt, CSS, and JS')
  for (const [path] of routes) assert.ok(assets.has(path), `${path} is in the handler allowlist`)
  const checks = [
    ['/docs', 'text/html; charset=utf-8', /<title>Introduction \| Goshen Email docs<\/title>/],
    ['/docs/', 'text/html; charset=utf-8', /<title>Introduction \| Goshen Email docs<\/title>/],
    ['/docs/quickstart', 'text/html; charset=utf-8', /<h1>Quickstart<\/h1>/],
    ['/docs/api', 'text/html; charset=utf-8', /<h1>API overview<\/h1>/],
    ['/docs/api/list-inboxes', 'text/html; charset=utf-8', /<span class="method method-get">GET<\/span><code>\/v1\/inboxes<\/code>/],
    ['/docs/api/send', 'text/html; charset=utf-8', /messages:send/],
    ['/docs/quickstart.md', 'text/markdown; charset=utf-8', /^# Quickstart\n/],
    ['/docs/api/send.md', 'text/markdown; charset=utf-8', /`POST \/v1\/inboxes\/\{inboxId\}\/messages\/send`/],
    ['/docs/llms.txt', 'text/plain; charset=utf-8', /^# Goshen Email \| Documentation\n/],
    ['/docs.css', 'text/css; charset=utf-8', /\.docs-layout/],
    ['/docs.js', 'text/javascript; charset=utf-8', /copy-button/],
  ]
  for (const [path, type, pattern] of checks) {
    const response = await get(path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('content-type'), type, path)
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'; style-src 'self'/, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.match(await response.text(), pattern, path)
  }
})

test('paths under /docs that were not generated are not served', async () => {
  for (const path of ['/docs/nope', '/docs/api/nope', '/docs/introduction.html', '/docs/../index.html', '/docs/quickstart.txt']) {
    assert.equal((await get(path)).status, 404, path)
  }
})

test('every internal link and asset reference in the docs resolves', () => {
  const publicDir = new URL('public/', root)
  const served = new Set([...assets.keys()])
  const files = readdirSync(new URL('docs/', publicDir), { recursive: true }).map(String).filter((name) => name.endsWith('.html'))
  assert.ok(files.length >= 40)
  for (const name of files) {
    const html = readFileSync(new URL(`docs/${name}`, publicDir), 'utf8')
    for (const [, href] of html.matchAll(/(?:href|src)="(\/[^"#]*)/g)) assert.ok(served.has(href), `${name} references ${href}`)
    // Headings linked from the on-page contents exist.
    for (const [, id] of html.matchAll(/class="docs-toc"[\s\S]*?href="#([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`), `${name} contents link #${id}`)
    assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, `${name} has an unexpanded placeholder`)
  }
})

test('generated Markdown tables keep one cell per column, including union types', () => {
  const publicDir = new URL('public/docs/', root)
  let tables = 0
  for (const name of readdirSync(publicDir, { recursive: true }).map(String).filter((file) => file.endsWith('.md'))) {
    const lines = readFileSync(new URL(name, publicDir), 'utf8').split('\n')
    const cells = (line) => (line.match(/(?<!\\)\|/g) ?? []).length - 1
    for (let index = 0; index < lines.length - 1; index++) {
      if (!lines[index].startsWith('|') || !/^\|( --- \|)+$/.test(lines[index + 1])) continue
      tables++
      const width = cells(lines[index])
      for (let row = index + 2; row < lines.length && lines[row].startsWith('|'); row++) assert.equal(cells(lines[row]), width, `${name}: ${lines[row]}`)
    }
  }
  assert.ok(tables > 30)
  assert.match(readFileSync(new URL('api/update-inbox.md', publicDir), 'utf8'), /`string \\\| null`/)
})

test('the API reference covers every operation in the contract', () => {
  const openapi = JSON.parse(readFileSync(new URL('../../docs/openapi.json', root), 'utf8'))
  const ids = Object.values(openapi.paths).flatMap((methods) => Object.values(methods).map((operation) => operation.operationId))
  assert.equal(ids.length, 17)
  for (const id of ids) {
    const slug = id.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())
    assert.ok(assets.has(`/docs/api/${slug}`), `${id} has a reference page`)
    assert.ok(assets.has(`/docs/api/${slug}.md`), `${id} has a Markdown twin`)
  }
  const llms = readFileSync(new URL('public/docs/llms.txt', root), 'utf8')
  for (const id of ids) assert.ok(llms.includes(`/docs/api/${id.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())}.md`), `${id} is listed in llms.txt`)
})
