/**
 * Lets this project import the real `dsh-superagent` sources without installing anything.
 *
 * `src/sources/github.ts` and its neighbours import two packages by bare name: `zod`, and
 * `@deepseek-ai/schemastery` (through `src/deployment.ts`). Both are vendored under `node_modules/`,
 * but Node resolves a bare specifier from the *importing file's* directory — and the prototype lives
 * outside this project, so it would look for `zod` beside its own sources and fail.
 *
 * A resolve hook closes that gap: for files under the prototype it maps those two specifiers onto the
 * vendored copies. Nothing inside the prototype is modified.
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The project root, one level above `src/`. */
export const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Where the prototype's `src/` lives. Resolved in this order, first hit wins:
 *
 * 1. `$SUPERAGENT_SRC` — the directory that contains `src/sources/github.ts`;
 * 2. a `prototype.path` file next to this project (one line, the same directory);
 * 3. a sibling checkout named `dsh-superagent-prototype`.
 *
 * A local machine pointer lives in `prototype.path` (git-ignored) rather than in the source, so the
 * published tree carries no absolute path from anyone's disk.
 */
function locatePrototype(): string {
  const candidates: string[] = []
  if (process.env.SUPERAGENT_SRC) candidates.push(process.env.SUPERAGENT_SRC)
  const pointer = join(root, 'prototype.path')
  if (existsSync(pointer)) {
    // Tolerant of a pasted example file: comments and blank lines are dropped, the last line wins.
    const line = readFileSync(pointer, 'utf8').split(/\r?\n/).map(text => text.trim())
      .filter(text => text && !text.startsWith('#')).at(-1)
    if (line) candidates.push(line)
  }
  candidates.push(join(root, '..', 'dsh-superagent-prototype'), join(root, '..', '..', 'dsh-superagent-prototype'))
  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(join(candidate, 'src', 'sources', 'github.ts'))) return candidate
  }
  throw new Error([
    'Cannot find the dsh-superagent prototype to mock.',
    'Point this project at it, with either:',
    '  - the SUPERAGENT_SRC environment variable, or',
    '  - a prototype.path file here holding one line: the prototype directory,',
    '  - or a sibling checkout named dsh-superagent-prototype.',
    'The directory must contain src/sources/github.ts.',
  ].join('\n'))
}

/** The prototype checkout this project reads modules from. */
export const prototypeRoot = locatePrototype()

/** Packages the prototype imports by name, mapped onto a copy that exists on this machine. */
export const VENDORED: Record<string, string> = Object.fromEntries(
  Object.entries({
    zod: 'zod',
    '@deepseek-ai/schemastery': '@deepseek-ai/schemastery',
  }).flatMap(([specifier, relative]) => {
    // Preferred: the copy vendored beside this project. Fallback: the one the local DSH profile has,
    // which is the same version, so a fresh checkout still runs without installing anything.
    const candidates = [
      join(root, 'node_modules', relative),
      join(process.env.DSH_PROFILE_NODE_MODULES ?? 'C:/Users/zhaorui-wu/.dsh/profiles/desktop/node_modules', relative),
    ]
    const found = candidates.find(candidate => existsSync(join(candidate, 'package.json')))
    return found ? [[specifier, found]] : []
  }),
)

/** The ESM entry of a package directory, read from its own `package.json`. */
export function entryOf(directory: string): string {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
    exports?: Record<string, string | Record<string, string>>; module?: string; main?: string
  }
  const exported = manifest.exports?.['.']
  const relative = typeof exported === 'string' ? exported : exported?.import ?? exported?.default ?? manifest.module ?? manifest.main
  return pathToFileURL(join(directory, relative ?? 'index.js')).href
}

let installed = false

/** Registers the resolve hook once per process; safe to call from every entry point. */
export function installVendoredResolution(): void {
  if (installed) return
  installed = true
  registerHooks({
    resolve(specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => { url: string }) {
      const directory = VENDORED[specifier]
      // Only answers for the prototype: this project's own imports resolve normally.
      if (directory && context.parentURL?.includes('/dsh-superagent-prototype/')) {
        return { url: entryOf(directory), shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

/** Absolute `file:` URL of a module inside the prototype's `src/`. */
export function prototypeModule(relative: string): string {
  const path = `${prototypeRoot.replace(/\\/g, '/')}/src/${relative}`
  return pathToFileURL(path).href
}
