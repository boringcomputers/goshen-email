import { globSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
for (const file of globSync(['src/*.mjs', 'scripts/*.mjs', 'test/*.mjs'])) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}
