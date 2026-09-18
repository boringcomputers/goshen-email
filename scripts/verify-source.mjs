import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('SOURCE.json', root), 'utf8'))
const modified = new Set(manifest.modified)
let unchanged = 0
for (const [path, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(await readFile(new URL(path, root))).digest('hex')
  if (actual !== expected && !modified.has(path)) throw new Error(`Undeclared source change: ${path}`)
  if (actual === expected) unchanged++
}
for (const path of modified) if (!Object.hasOwn(manifest.files, path)) throw new Error(`Unknown modified source: ${path}`)
// CLAUDE.md imports AGENTS.md instead of restating it, so the repository rules stay in one file.
const claude = await readFile(new URL('CLAUDE.md', root), 'utf8')
if (!claude.split(/\r?\n/).includes('@AGENTS.md')) throw new Error('CLAUDE.md must import AGENTS.md with a line containing only "@AGENTS.md"')
console.log(`${unchanged} files match Bezalel ${manifest.revision}; ${modified.size} declared modifications; CLAUDE.md imports AGENTS.md`)
