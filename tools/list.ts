/**
 * Fixtures the mock ships with, so `npm run list` can print them without starting a server.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Fixture } from '../src/mock/world.ts'

const directory = fileURLToPath(new URL('../fixtures/', import.meta.url))
for (const file of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(new URL(file, `file://${directory.replace(/\\/g, '/')}`), 'utf8')) as Fixture
  console.log(`${file.replace(/\.json$/, '')}\n  ${fixture.description}\n  rounds: ${fixture.rounds?.length ?? 1}\n`)
}
