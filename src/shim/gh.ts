/**
 * A stand-in for `gh` that answers `gh api …` from the local mock instead of api.github.com.
 *
 * The GitHub Source never opens an HTTP connection itself: `Commands.api()` runs
 * `this.deployment.github.cli api repos/<owner>/<name>/<path> …` as a subprocess
 * (`src/infra/commands.ts`). So the only way to drive the real Source code offline is to put something
 * on the far side of that subprocess. This module implements exactly the `gh api` surface the Source
 * uses — `--include`, `--paginate --slurp`, `-f key=value`, `-X/--method`, `-H`, and gh's habit of
 * exiting non-zero with `gh: … (HTTP <status>)` on an error — and nothing else.
 *
 * Run it directly to use it as a real `gh` on PATH:
 *
 *     node src/shim/gh.ts api repos/acme/widgets/notifications --include
 *
 * with `GITHUB_MOCK_URL` pointing at a running mock.
 */

/** What a subprocess would have produced: stdout, stderr and an exit code. */
export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** The flags of one `gh api` invocation that this shim understands. */
interface Invocation {
  path: string;
  method: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  include: boolean;
  paginate: boolean;
  slurp: boolean;
}

/** Reads `gh api` argv into the parts the request needs; unknown flags are ignored as gh would reject them later. */
export function parse(argv: string[]): Invocation {
  if (argv[0] !== 'api') throw new Error(`the mock gh supports only "api", not "${argv[0] ?? ''}"`)
  const rest = argv.slice(1)
  const first = rest.findIndex(value => !value.startsWith('-'))
  const path = first >= 0 ? rest[first]! : ''
  const invocation: Invocation = { path, method: '', headers: {}, fields: {}, include: false, paginate: false, slurp: false }
  for (let index = first + 1; index < rest.length; index += 1) {
    const flag = rest[index]!
    const next = (): string => rest[++index] ?? ''
    if (flag === '--include' || flag === '-i') invocation.include = true
    else if (flag === '--paginate') invocation.paginate = true
    else if (flag === '--slurp') invocation.slurp = true
    else if (flag === '-H' || flag === '--header') {
      const [name, ...value] = next().split(':')
      if (name && value.length) invocation.headers[name.trim().toLowerCase()] = value.join(':').trim()
    } else if (flag === '-f' || flag === '--raw-field' || flag === '-F' || flag === '--field') {
      const pair = next()
      const split = pair.indexOf('=')
      if (split > 0) invocation.fields[pair.slice(0, split)] = pair.slice(split + 1)
    } else if (flag === '-X' || flag === '--method') invocation.method = next().toUpperCase()
  }
  if (!invocation.method) invocation.method = Object.keys(invocation.fields).length ? 'POST' : 'GET'
  return invocation
}

/** The URL of one page, with the mock's base swapped for api.github.com. */
const urlOf = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

/** Extracts the `rel="next"` target of a `Link` header, the only header shape pagination needs. */
export function nextLink(link: string | null, base: string): string | undefined {
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(link ?? '')
  if (!match?.[1]) return undefined
  const target = new URL(match[1], base)
  return urlOf(base, target.pathname.replace(/^\//, '') + target.search)
}

/** Formats the headers gh prints before the body under `--include`. */
function headerBlock(response: Response): string {
  const lines = [`HTTP/2.0 ${response.status} ${response.statusText || ''}`.trim()]
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`))
  return lines.join('\n')
}

/**
 * Runs one `gh api` call against the mock and answers the way the subprocess would: the body on stdout,
 * gh's own error wording on stderr, and an exit code.
 */
export async function ghApi(argv: string[], baseUrl: string): Promise<GhResult> {
  const invocation = parse(argv)
  const url = urlOf(baseUrl, invocation.path)
  const init: RequestInit = {
    method: invocation.method,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      ...Object.keys(invocation.fields).length ? { 'content-type': 'application/json' } : {}, ...invocation.headers },
    ...Object.keys(invocation.fields).length ? { body: JSON.stringify(invocation.fields) } : {},
  }

  let response = await fetch(url, init)
  // gh exits non-zero on 304 too, which is exactly what the Source's ETag polling relies on.
  if (response.status === 304) return { stdout: '', stderr: 'gh: HTTP 304', code: 1 }
  if (!response.ok) {
    const text = await response.text()
    let message = text.trim()
    try {
      message = String((JSON.parse(text) as { message?: string }).message ?? message)
    } catch { /* keep the raw body */ }
    return { stdout: '', stderr: `gh: ${message} (HTTP ${response.status})`, code: 1 }
  }

  const pages: unknown[] = [await response.json()]
  if (invocation.paginate) {
    let next = nextLink(response.headers.get('link'), baseUrl)
    let guard = 0
    while (next && guard < 50) {
      guard += 1
      response = await fetch(next, { ...init, body: undefined, method: 'GET' })
      if (!response.ok) return { stdout: '', stderr: `gh: HTTP ${response.status}`, code: 1 }
      pages.push(await response.json())
      next = nextLink(response.headers.get('link'), baseUrl)
    }
  }

  const body = invocation.paginate
    ? JSON.stringify(invocation.slurp ? pages : pages.flat())
    : JSON.stringify(pages[0])
  const stdout = invocation.include ? `${headerBlock(response)}\n\n${body}` : body
  return { stdout, stderr: '', code: 0 }
}

/** `node src/shim/gh.ts api …` — the executable form, for putting on PATH as `gh`. */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gh.ts')) {
  const base = process.env.GITHUB_MOCK_URL ?? 'http://127.0.0.1:8787'
  const result = await ghApi(process.argv.slice(2), base)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
}
