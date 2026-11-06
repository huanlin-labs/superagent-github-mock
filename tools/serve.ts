/**
 * Serves one fixture so a person can drive it by hand.
 *
 *     node --experimental-transform-types tools/serve.ts 01-issue-mention --port 8787
 *
 * Then, from another shell:
 *
 *     set GITHUB_MOCK_URL=http://127.0.0.1:8787
 *     node --experimental-transform-types src/shim/gh.ts api "repos/acme/widgets/notifications?all=true&per_page=50" --include
 *
 *     curl    http://127.0.0.1:8787/repos/acme/widgets/issues/12
 *     curl    http://127.0.0.1:8787/__mock/requests
 *     curl -X POST http://127.0.0.1:8787/__mock/round/1
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { handle, withEtag } from '../src/mock/routes.ts'
import { worldFor, type Fixture } from '../src/mock/world.ts'

const args = process.argv.slice(2)
const name = args[0]
if (!name) {
  console.error('usage: node tools/serve.ts <fixture-name> [--port 8787] [--round 0]')
  process.exit(2)
}
const portIndex = args.indexOf('--port')
const roundIndex = args.indexOf('--round')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8787
let round = roundIndex >= 0 ? Number(args[roundIndex + 1]) : 0

const fixture = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture
let world = worldFor(fixture, round)

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://mock')
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(Buffer.from(chunk)))
  request.on('end', () => {
    if (url.pathname.startsWith('/__mock/round/')) {
      round = Number(url.pathname.slice('/__mock/round/'.length))
      world = worldFor(fixture, round)
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ round, name: fixture.name }))
      return
    }
    if (url.pathname === '/__mock/fixture') {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ name: fixture.name, description: fixture.description, round, rounds: fixture.rounds?.length ?? 0 }, null, 2))
      return
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    let payload: Record<string, unknown> | undefined
    try {
      payload = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    } catch {
      payload = raw ? Object.fromEntries(new URLSearchParams(raw)) : undefined
    }
    const answer = withEtag(handle(world, fixture.repository, {
      method: request.method ?? 'GET', path: url.pathname, query: url.searchParams,
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
      ...payload ? { payload } : {},
    }), { method: request.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: {} })
    const body = answer.status === 304 ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body, null, 2)
    response.writeHead(answer.status, { ...answer.headers }).end(body)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`${fixture.name} on http://127.0.0.1:${port} (round ${round}) — ${fixture.description}`)
})
