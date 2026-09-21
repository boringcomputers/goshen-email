// Builds the public documentation served at /docs.
//
// Sources: Markdown pages in docs/ (with a small front matter block) and the API contract in
// ../../docs/openapi.json, which produces one reference page per operation. Output: HTML pages,
// a Markdown twin for each page, docs/llms.txt for agents, and src/docs-assets.mjs, the list of
// paths the handler may serve. Everything written here is committed; `--check` fails when the
// committed files differ from what the sources produce, the same way api:check guards the contract.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { Marked } from 'marked'

const root = fileURLToPath(new URL('..', import.meta.url))
const sources = join(root, 'docs')
const publicDir = join(root, 'public')
const outDir = join(publicDir, 'docs')
const openapi = JSON.parse(readFileSync(join(root, '../../docs/openapi.json'), 'utf8'))
const check = process.argv.includes('--check')

const site = {
  name: 'Goshen Email',
  origin: 'https://goshenemail.com',
  apiBase: openapi.servers[0].url,
  defaultDomain: 'agents.goshenemail.com',
}

// Section order and the page slugs in each. Titles and descriptions come from each page's front matter.
const sections = [
  { title: 'Getting started', pages: ['introduction', 'quickstart'] },
  { title: 'Core concepts', pages: ['inboxes', 'messages', 'threads', 'labels', 'attachments', 'groups', 'quarantine', 'triage'] },
  { title: 'Guides', pages: ['authentication', 'sending', 'pagination', 'webhooks', 'custom-domains', 'dashboard', 'agents'] },
  { title: 'Integrations', pages: ['typescript', 'python', 'cli', 'mcp'] },
  { title: 'Reference', pages: ['api', 'errors', 'limits'] },
]

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const slugify = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
const kebab = (id) => id.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())
const snake = (id) => id.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase())

// Markdown rendering. Headings get ids for the on-page contents; external links open in a new tab.
function renderer() {
  const headings = []
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens)
        const id = slugify(text)
        if (depth === 2) headings.push({ id, text })
        return `<h${depth} id="${id}">${text}</h${depth}>\n`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        const external = /^https?:\/\//.test(href) && !href.startsWith(site.origin)
        return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${text}</a>`
      },
      code({ text, lang }) {
        const language = (lang || '').split(/\s+/)[0]
        return `<pre><code${language ? ` class="language-${escape(language)}"` : ''}>${escape(text)}</code></pre>\n`
      },
      table({ header, rows }) {
        const cell = (item, tag) => `<${tag}${item.align ? ` style="text-align:${item.align}"` : ''}>${this.parser.parseInline(item.tokens)}</${tag}>`
        const head = `<tr>${header.map((item) => cell(item, 'th')).join('')}</tr>`
        const body = rows.map((row) => `<tr>${row.map((item) => cell(item, 'td')).join('')}</tr>`).join('')
        return `<div class="table-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`
      },
    },
  })
  return { marked, headings }
}

function frontMatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error('Every docs page needs a front matter block with title and description')
  const meta = Object.fromEntries(match[1].split('\n').map((line) => {
    const index = line.indexOf(':')
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
  }))
  if (!meta.title || !meta.description) throw new Error('Front matter needs title and description')
  return { meta, body: match[2] }
}

// Guide pages from Markdown.
const pages = new Map()
for (const file of readdirSync(sources).filter((name) => name.endsWith('.md')).sort()) {
  const slug = file.slice(0, -3)
  const { meta, body } = frontMatter(readFileSync(join(sources, file), 'utf8'))
  pages.set(slug, { slug, path: `/docs/${slug}`, title: meta.title, description: meta.description, markdown: body })
}
for (const section of sections) for (const slug of section.pages) if (!pages.has(slug)) throw new Error(`Section lists ${slug} but docs/${slug}.md does not exist`)
for (const slug of pages.keys()) if (!sections.some((section) => section.pages.includes(slug))) throw new Error(`docs/${slug}.md is not listed in any section`)

// API reference pages from the OpenAPI document.
const operations = []
for (const [path, methods] of Object.entries(openapi.paths)) {
  for (const [method, operation] of Object.entries(methods)) operations.push({ path, method: method.toUpperCase(), ...operation })
}
const operationTitle = (operation) => ({
  listInboxes: 'List inboxes', createInbox: 'Create an inbox', getInbox: 'Get an inbox', updateInbox: 'Update an inbox',
  deleteInbox: 'Delete an inbox', finishInboxSetup: 'Finish inbox setup', listMessages: 'List messages', searchMessages: 'Search messages',
  getMessage: 'Get a message', send: 'Send a message', reply: 'Reply to a message', updateMessageLabels: 'Update message labels',
  getAttachment: 'Get an attachment', listThreads: 'List threads', getThread: 'Get a thread', updateThreadLabels: 'Update thread labels',
  getUsage: 'Get usage',
})[operation.operationId] ?? operation.operationId
const operationGroup = (operation) => operation.path.includes('/threads') ? 'Threads' : operation.path.includes('/messages') ? 'Messages' : operation.path.startsWith('/v1/inboxes') ? 'Inboxes' : 'Account'
const apiGroups = ['Inboxes', 'Messages', 'Threads', 'Account']

function typeLabel(schema) {
  if (!schema || typeof schema !== 'object') return 'any'
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf)
    if (variants.every((item) => item.type === 'null' || item.enum)) return variants.map(typeLabel).join(' | ')
    return variants.map((item) => (item.type === 'null' ? 'null' : typeLabel(item))).join(' | ')
  }
  if (schema.enum) return schema.enum.map((value) => (value === null ? 'null' : `"${value}"`)).join(' | ')
  if (schema.type === 'array') return `${typeLabel(schema.items)}[]`
  if (schema.type === 'object' || schema.properties) return 'object'
  if (schema.type === 'string' && schema.format) return schema.format === 'date-time' ? 'string (ISO 8601)' : `string (${schema.format})`
  return schema.type ?? 'any'
}
function constraints(schema) {
  const notes = []
  if (schema.minLength !== undefined && schema.maxLength !== undefined) notes.push(`${schema.minLength}–${schema.maxLength} characters`)
  else if (schema.maxLength !== undefined) notes.push(`up to ${schema.maxLength.toLocaleString('en-US')} characters`)
  else if (schema.minLength !== undefined) notes.push(`at least ${schema.minLength} characters`)
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.maximum < 1e15) notes.push(`${schema.minimum}–${schema.maximum}`)
  else if (schema.minimum !== undefined) notes.push(`at least ${schema.minimum}`)
  if (schema.minItems !== undefined) notes.push(`at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`)
  if (schema.maxItems !== undefined) notes.push(`up to ${schema.maxItems} items`)
  if (schema.default !== undefined) notes.push(`default ${JSON.stringify(schema.default)}`)
  return notes.join(', ')
}
// One row per property, nested properties indented by depth. Deep trees stop at three levels.
function schemaRows(schema, depth = 0, prefix = '') {
  if (!schema || typeof schema !== 'object') return []
  const variants = schema.anyOf ?? schema.oneOf
  if (variants) {
    const objects = variants.filter((item) => item.properties)
    if (!objects.length) return []
    // Merge variant properties; the row's type shows where they differ.
    const merged = { type: 'object', properties: {}, required: [] }
    for (const item of objects) Object.assign(merged.properties, item.properties)
    return schemaRows(merged, depth, prefix)
  }
  if (schema.type === 'array') return schemaRows(schema.items, depth, prefix)
  if (!schema.properties) return []
  const required = new Set(schema.required ?? [])
  const rows = []
  for (const [name, property] of Object.entries(schema.properties)) {
    rows.push({ name: prefix + name, depth, type: typeLabel(property), required: required.has(name), notes: constraints(property), description: property.description ?? '' })
    if (depth < 2) rows.push(...schemaRows(property, depth + 1, ''))
  }
  return rows
}
function rowsTable(rows, { requiredColumn = true } = {}) {
  if (!rows.length) return '<p class="muted">None.</p>'
  return `<div class="table-scroll"><table class="schema"><thead><tr><th>Field</th><th>Type</th>${requiredColumn ? '<th>Required</th>' : ''}<th>Notes</th></tr></thead><tbody>${rows.map((row) =>
    `<tr><td class="depth-${row.depth}"><code>${escape(row.name)}</code></td><td><code>${escape(row.type)}</code></td>${requiredColumn ? `<td>${row.required ? 'Yes' : ''}</td>` : ''}<td>${escape([row.notes, row.description].filter(Boolean).join('. '))}</td></tr>`).join('')}</tbody></table></div>`
}
function paramsTable(params) {
  if (!params.length) return '<p class="muted">None.</p>'
  return `<div class="table-scroll"><table class="schema"><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead><tbody>${params.map((param) =>
    `<tr><td><code>${escape(param.name)}</code></td><td><code>${escape(typeLabel(param.schema))}</code></td><td>${param.required ? 'Yes' : ''}</td><td>${escape([constraints(param.schema ?? {}), param.description ?? ''].filter(Boolean).join('. '))}</td></tr>`).join('')}</tbody></table></div>`
}

// Example values for request bodies, so each reference page shows a request a reader can copy.
const exampleValues = {
  username: 'research', domain: undefined, displayName: 'Research agent', group: 'agents', to: ['recipient@example.net'], cc: undefined, bcc: undefined,
  subject: 'Quote request', text: 'Hello, could you send the current quote?', html: undefined, idempotencyKey: '2f7c1c1e-6d1a-4a3b-9b0e-0c9b3f5c8a11',
  replyAll: false, attachments: undefined, labels: undefined, addLabels: ['reviewed'], removeLabels: ['unread'],
}
const examplePath = { inboxId: `research@${site.defaultDomain}`, messageId: '<20260920.12345@agents.goshenemail.com>', threadId: '0b8d0e7f-3444-4bb7-a250-c2793dd5944d', attachmentId: '4f40dbb7-c2aa-4288-af1e-2966ca55b6b7' }
function exampleBody(schema) {
  if (!schema?.properties) return undefined
  const body = {}
  for (const [name, property] of Object.entries(schema.properties)) {
    const required = (schema.required ?? []).includes(name)
    const value = exampleValues[name]
    if (value !== undefined && (required || ['group', 'subject', 'text', 'displayName', 'addLabels', 'removeLabels'].includes(name))) body[name] = value
    else if (required && property.type === 'string') body[name] = 'value'
  }
  return Object.keys(body).length ? body : undefined
}
function curlExample(operation) {
  const path = operation.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(examplePath[name] ?? name))
  const query = (operation.parameters ?? []).filter((param) => param.in === 'query' && param.required).map((param) => `${param.name}=${param.name === 'query' ? 'invoice' : 'value'}`)
  const url = `${site.apiBase}${path}${query.length ? `?${query.join('&')}` : ''}`
  const body = exampleBody(operation.requestBody?.content?.['application/json']?.schema)
  const lines = [`curl "${url}" \\`, `  -H "Authorization: Bearer $BEZALEL_API_KEY"`]
  if (operation.method !== 'GET') lines[lines.length - 1] += ' \\'
  if (operation.method !== 'GET') lines.push(`  -X ${operation.method}${body ? ' \\' : ''}`)
  if (body) lines.push(`  -H "Content-Type: application/json" \\`, `  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}'`)
  return lines.join('\n')
}
const sdkMethod = {
  listInboxes: 'inboxes.list', createInbox: 'inboxes.create', getInbox: 'inboxes.get', updateInbox: 'inboxes.update', deleteInbox: 'inboxes.delete', finishInboxSetup: 'inboxes.finishSetup',
  listMessages: 'messages.list', searchMessages: 'messages.search', getMessage: 'messages.get', send: 'messages.send', reply: 'messages.reply', updateMessageLabels: 'messages.updateLabels',
  getAttachment: 'messages.getAttachment', listThreads: 'threads.list', getThread: 'threads.get', updateThreadLabels: 'threads.updateLabels',
  getUsage: 'account.usage',
}
const cliCommand = Object.fromEntries(Object.entries({
  'inboxes list': 'listInboxes', 'inboxes create': 'createInbox', 'inboxes get': 'getInbox', 'inboxes delete': 'deleteInbox', 'inboxes finish-setup': 'finishInboxSetup', 'inboxes update': 'updateInbox',
  'messages list': 'listMessages', 'messages search': 'searchMessages', 'messages get': 'getMessage', 'messages send': 'send', 'messages reply': 'reply', 'messages labels': 'updateMessageLabels',
  'messages attachment': 'getAttachment', 'threads list': 'listThreads', 'threads get': 'getThread', 'threads labels': 'updateThreadLabels',
  'account usage': 'getUsage',
}).map(([command, id]) => [id, command]))
function sdkInput(operation) {
  const input = {}
  for (const param of operation.parameters ?? []) if (param.in === 'path' || param.required) input[param.name] = examplePath[param.name] ?? (param.name === 'query' ? 'invoice' : 'value')
  Object.assign(input, exampleBody(operation.requestBody?.content?.['application/json']?.schema) ?? {})
  return input
}
const toPython = (value) => JSON.stringify(value).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')
function sdkExamples(operation) {
  const input = sdkInput(operation)
  const method = sdkMethod[operation.operationId]
  const tsArgs = Object.keys(input).length ? JSON.stringify(input, null, 2).replace(/"(\w+)":/g, '$1:').replace(/"/g, "'") : ''
  const pyArgs = Object.entries(input).map(([key, value]) => `${snake(key)}=${toPython(value)}`).join(', ')
  const pyMethod = method.replace(/\.(\w+)/, (_, name) => '.' + snake(name))
  const cliArgs = Object.entries(input).filter(([, value]) => typeof value !== 'object').map(([key, value]) => `--${kebab(key)} ${JSON.stringify(String(value))}`).join(' ')
  const cliJson = Object.values(input).some((value) => typeof value === 'object') ? ` --json '${JSON.stringify(input)}'` : ''
  return [
    { label: 'TypeScript', lang: 'ts', code: `const result = await email.${method}(${tsArgs})` },
    { label: 'Python', lang: 'python', code: `result = email.${pyMethod}(${pyArgs})` },
    { label: 'CLI', lang: 'sh', code: `bezalel-email ${cliCommand[operation.operationId]}${cliJson || (cliArgs ? ' ' + cliArgs : '')}` },
  ]
}

function apiPageHtml(operation) {
  const params = operation.parameters ?? []
  const body = operation.requestBody?.content?.['application/json']?.schema
  const response = operation.responses?.['200']?.content?.['application/json']?.schema
  // The summary is the page's lede; a longer description, when the contract has one, follows the endpoint.
  const description = operation.description && operation.description !== operation.summary ? operation.description : ''
  const examples = sdkExamples(operation)
  const headings = [{ id: 'request', text: 'Request' }, { id: 'response', text: 'Response' }, { id: 'examples', text: 'Examples' }]
  const html = `
<p class="endpoint"><span class="method method-${operation.method.toLowerCase()}">${operation.method}</span><code>${escape(operation.path)}</code></p>
${description ? `<p>${escape(description)}</p>` : ''}
<p class="scope">Requires an API key with the <code>${escape(operation['x-required-scope'])}</code> scope. MCP tool: <code>${snake(operation.operationId)}</code>. SDK: <code>email.${sdkMethod[operation.operationId]}()</code>. CLI: <code>bezalel-email ${cliCommand[operation.operationId]}</code>.</p>
<h2 id="request">Request</h2>
${params.some((param) => param.in === 'path') ? `<h3>Path parameters</h3>${paramsTable(params.filter((param) => param.in === 'path'))}` : ''}
${params.some((param) => param.in === 'query') ? `<h3>Query parameters</h3>${paramsTable(params.filter((param) => param.in === 'query'))}` : ''}
${body ? `<h3>Body</h3>${rowsTable(schemaRows(body))}` : ''}
<h2 id="response">Response</h2>
${response ? rowsTable(schemaRows(response), { requiredColumn: false }) : '<p>An empty JSON body with status 200.</p>'}
<p>Errors return <code>{ "error": { "code", "message", "transient" } }</code> with a 4xx or 5xx status. See <a href="/docs/errors">Errors</a>.</p>
<h2 id="examples">Examples</h2>
<h3>curl</h3>
<pre><code class="language-sh">${escape(curlExample(operation))}</code></pre>
${examples.map((example) => `<h3>${example.label}</h3><pre><code class="language-${example.lang}">${escape(example.code)}</code></pre>`).join('\n')}
`
  return { html, headings }
}
function apiPageMarkdown(operation) {
  const params = operation.parameters ?? []
  const body = operation.requestBody?.content?.['application/json']?.schema
  const response = operation.responses?.['200']?.content?.['application/json']?.schema
  // Union and enum type labels contain "|", which would split a Markdown table cell.
  const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ')
  const rows = (items) => items.length ? ['| Field | Type | Required | Notes |', '| --- | --- | --- | --- |', ...items.map((row) => `| ${'  '.repeat(row.depth)}\`${cell(row.name)}\` | \`${cell(row.type)}\` | ${row.required ? 'Yes' : ''} | ${cell([row.notes, row.description].filter(Boolean).join('. '))} |`)].join('\n') : 'None.'
  const paramRows = (items) => items.map((param) => ({ name: param.name, depth: 0, type: typeLabel(param.schema), required: param.required, notes: constraints(param.schema ?? {}), description: param.description ?? '' }))
  return [
    `# ${operationTitle(operation)}`, '', operation.summary ?? '', '', `\`${operation.method} ${operation.path}\``, '',
    ...(operation.description && operation.description !== operation.summary ? [operation.description, ''] : []),
    `Requires scope \`${operation['x-required-scope']}\`. MCP tool \`${snake(operation.operationId)}\`. SDK \`email.${sdkMethod[operation.operationId]}()\`. CLI \`bezalel-email ${cliCommand[operation.operationId]}\`.`, '',
    '## Request', '',
    ...(params.some((param) => param.in === 'path') ? ['### Path parameters', '', rows(paramRows(params.filter((param) => param.in === 'path'))), ''] : []),
    ...(params.some((param) => param.in === 'query') ? ['### Query parameters', '', rows(paramRows(params.filter((param) => param.in === 'query'))), ''] : []),
    ...(body ? ['### Body', '', rows(schemaRows(body)), ''] : []),
    '## Response', '', response ? rows(schemaRows(response)) : 'An empty JSON body with status 200.', '',
    'Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.', '',
    '## Examples', '', '```sh', curlExample(operation), '```', '',
    ...sdkExamples(operation).flatMap((example) => [`### ${example.label}`, '', '```' + example.lang, example.code, '```', '']),
  ].join('\n')
}

const apiPages = operations.map((operation) => ({
  slug: `api/${kebab(operation.operationId)}`, path: `/docs/api/${kebab(operation.operationId)}`, title: operationTitle(operation),
  description: operation.summary ?? '', group: operationGroup(operation), operation,
}))

// Layout shared by every page.
const header = `<header class="site-header">
  <a href="/" aria-label="${site.name} home" class="brand">
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" class="brand-icon"><path d="M14 2C7.4 2 2 6.7 2 12.5c0 3.2 1.6 6 4.2 7.9L5 26l6.1-3.1c.9.2 1.9.3 2.9.3 6.6 0 12-4.7 12-10.5S20.6 2 14 2z" fill="var(--color-ink)"></path><circle cx="9.5" cy="12.5" r="1.8" fill="#FFFFFF"></circle><circle cx="14" cy="12.5" r="1.8" fill="#FFFFFF"></circle><circle cx="18.5" cy="12.5" r="1.8" fill="#FFFFFF"></circle></svg>
    <span class="brand-name">${site.name}</span>
  </a>
  <nav aria-label="Main navigation" class="site-nav">
    <a href="/#product" class="site-header-product">Product</a>
    <a href="/docs" class="site-header-product" aria-current="page">Docs</a>
    <a href="/docs/api" class="site-header-product">API reference</a>
  </nav>
  <div class="nav-actions">
    <a href="/app" class="site-header-log-in">Log in</a>
    <a href="/app" class="site-header-start-free"><span class="site-header-start-free-2">Get started</span></a>
  </div>
</header>`

function sidebar(currentPath) {
  const link = (page) => `<li><a href="${page.path}"${page.path === currentPath ? ' aria-current="page"' : ''}>${escape(page.title)}</a></li>`
  const guideSections = sections.map((section) => `<section><h2>${escape(section.title)}</h2><ul>${section.pages.map((slug) => link(pages.get(slug))).join('')}</ul></section>`)
  const groups = apiGroups.map((group) => `<section><h2>API: ${group}</h2><ul>${apiPages.filter((page) => page.group === group).map(link).join('')}</ul></section>`)
  return `<nav class="docs-nav" aria-label="Documentation"><button type="button" class="docs-nav-toggle" aria-expanded="false" aria-controls="docs-nav-list">Menu</button><div id="docs-nav-list" class="docs-nav-list">${guideSections.join('')}${groups.join('')}</div></nav>`
}

// Flat reading order for previous/next links.
const order = [...sections.flatMap((section) => section.pages.map((slug) => pages.get(slug))), ...apiPages]
function pageHtml(page, content, headings) {
  const index = order.indexOf(page)
  const previous = order[index - 1], next = order[index + 1]
  const toc = headings.length ? `<aside class="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>${headings.map((heading) => `<li><a href="#${heading.id}">${heading.text}</a></li>`).join('')}</ul></aside>` : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#FFFFFF">
  <meta name="description" content="${escape(page.description)}">
  <title>${escape(page.title)} | ${site.name} docs</title>
  <link rel="icon" href="/images/solenne.svg" type="image/svg+xml">
  <link rel="alternate" type="text/markdown" href="${page.path}.md">
  <link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/site-header.css">
  <link rel="stylesheet" href="/docs.css">
  <script src="/docs.js" defer></script>
</head>
<body>
  <a href="#docs-content" class="skip-link">Skip to content</a>
  ${header}
  <div class="docs-layout">
    ${sidebar(page.path)}
    <main id="docs-content" class="docs-content">
      <p class="docs-crumbs">${escape(page.group ? `API reference / ${page.group}` : sections.find((section) => section.pages.includes(page.slug)).title)}</p>
      <h1>${escape(page.title)}</h1>
      <p class="lede">${escape(page.description)}</p>
      ${content}
      <nav class="docs-pager" aria-label="Previous and next">
        ${previous ? `<a href="${previous.path}" rel="prev"><span>Previous</span>${escape(previous.title)}</a>` : '<span></span>'}
        ${next ? `<a href="${next.path}" rel="next"><span>Next</span>${escape(next.title)}</a>` : '<span></span>'}
      </nav>
      <p class="docs-footer">Markdown for agents: <a href="${page.path}.md">${page.path}.md</a> · <a href="/docs/llms.txt">/docs/llms.txt</a> · <a href="${site.apiBase}/openapi.json" rel="noopener">OpenAPI</a></p>
    </main>
    ${toc}
  </div>
</body>
</html>
`
}

// Render everything into memory first so --check can compare without writing.
const output = new Map()
for (const page of pages.values()) {
  const { marked, headings } = renderer()
  const content = marked.parse(page.markdown.replaceAll('{{API_BASE}}', site.apiBase).replaceAll('{{DEFAULT_DOMAIN}}', site.defaultDomain))
  output.set(`docs/${page.slug}.html`, pageHtml(page, content, headings))
  output.set(`docs/${page.slug}.md`, `# ${page.title}\n\n${page.description}\n\n${page.markdown.replaceAll('{{API_BASE}}', site.apiBase).replaceAll('{{DEFAULT_DOMAIN}}', site.defaultDomain).trim()}\n`)
}
for (const page of apiPages) {
  const { html, headings } = apiPageHtml(page.operation)
  output.set(`docs/${page.slug}.html`, pageHtml(page, html, headings))
  output.set(`docs/${page.slug}.md`, apiPageMarkdown(page.operation) + '\n')
}
output.set('docs/llms.txt', [
  `# ${site.name} | Documentation`, '',
  `> ${site.name} is the email inbox API for AI agents. Each agent gets a real address, threaded conversations, attachments, and an API key scoped to one account or one mailbox. The same inboxes are available as MCP tools, and a dashboard gives the people running the agents oversight.`, '',
  '## Instructions for AI agents', '',
  '- For Markdown of any page, append `.md` to the page URL.',
  `- The OpenAPI 3.1 document is at ${site.apiBase}/openapi.json.`,
  `- The hosted MCP server is ${site.apiBase}/mcp with an account API key in the Authorization header.`, '',
  '## Docs', '',
  ...sections.flatMap((section) => section.pages.map((slug) => { const page = pages.get(slug); return `- [${page.title}](${site.origin}${page.path}.md): ${page.description}` })), '',
  '## API reference', '',
  ...apiPages.map((page) => `- API reference > ${page.group} [${page.title}](${site.origin}${page.path}.md): ${page.description}`), '',
].join('\n'))

// The handler serves only listed paths. /docs and /docs/api resolve to the first page of each part.
const routes = new Map()
const contentType = (file) => file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
for (const file of output.keys()) routes.set(file.endsWith('.html') ? `/${file.slice(0, -5)}` : `/${file}`, [file, contentType(file)])
routes.set('/docs', ['docs/introduction.html', 'text/html; charset=utf-8'])
routes.set('/docs/', ['docs/introduction.html', 'text/html; charset=utf-8'])
routes.set('/docs/api/', ['docs/api.html', 'text/html; charset=utf-8'])
routes.set('/docs.css', ['docs.css', 'text/css; charset=utf-8'])
routes.set('/docs.js', ['docs.js', 'text/javascript; charset=utf-8'])
const assetEntries = [...routes].sort((a, b) => a[0].localeCompare(b[0]))
const assetsModule = ['// Generated by scripts/build-docs.mjs. Do not edit; run pnpm docs:generate.', 'export const docsAssets = [',
  ...assetEntries.map(([route, entry]) => `  [${JSON.stringify(route)}, ${JSON.stringify(entry)}],`), ']', ''].join('\n')

// Every internal link must resolve to a served path.
const served = new Set(routes.keys())
for (const [file, html] of output) {
  if (!file.endsWith('.html')) continue
  for (const match of html.matchAll(/href="(\/[^"#]*)/g)) {
    const href = match[1]
    if (!served.has(href) && !['/', '/app', '/#product', '/images/solenne.svg', '/tokens.css', '/site-header.css', '/fonts/InterVariable.woff2'].includes(href) && !href.startsWith('/#')) throw new Error(`${file} links to ${href}, which is not served`)
  }
}

const files = new Map([...output].map(([file, text]) => [join(publicDir, file), text]))
files.set(join(root, 'src/docs-assets.mjs'), assetsModule)
if (check) {
  const drift = []
  for (const [file, text] of files) if (!existsSync(file) || readFileSync(file, 'utf8') !== text) drift.push(relative(root, file))
  for (const name of existsSync(outDir) ? readdirSync(outDir, { recursive: true }) : []) {
    const file = join(outDir, String(name))
    if (!files.has(file) && /\.(html|md|txt)$/.test(file)) drift.push(relative(root, file) + ' (stale)')
  }
  if (drift.length) { console.error(`Docs output is out of date. Run pnpm docs:generate.\n${drift.join('\n')}`); process.exit(1) }
  console.log(`${output.size} docs files match their sources`)
} else {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true })
  for (const [file, text] of files) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
  console.log(`Wrote ${output.size} docs files and src/docs-assets.mjs`)
}
