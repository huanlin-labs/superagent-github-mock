/**
 * A local HTTP server that answers GitHub's REST API from one fixture world.
 *
 * It is deliberately plain `node:http`: no dependency has to be installed to run it, and the same
 * server object is used by `tools/serve.ts` (for a person pointing `curl` at it) and by the tests.
 */
import { createServer, type Server } from 'node:http'
import { handle, withEtag, type MockRequest } from './routes.ts'
import { worldFor, type Fixture, type World } from './world.ts'

/** One request the mock answered, kept so a test can assert on what the Source asked for. */
export interface RequestRecord {
  method: string;
  /** Path plus query string, exactly as requested. */
  url: string;
  status: number;
  ifNoneMatch?: string;
  body?: unknown;
}

export interface MockHandle {
  /** `http://127.0.0.1:<port>`, the base every request is made against. */
  url: string;
  requests: RequestRecord[];
  /** Switches which round's world is served; timestamps are materialised at the switch. */
  setRound(round: number): void;
  round(): number;
  close(): Promise<void>;
}

/** Reads the whole request body, so a POST can be parsed. */
async function readBody(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Stores a POST body as JSON when it is JSON, and as a form map when `gh -f key=value` sent one. */
function parsePayload(raw: string, contentType: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  if (contentType.includes('json')) {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const params = new URLSearchParams(raw)
  return params.size ? Object.fromEntries(params) : undefined
}

/** Starts the mock on an ephemeral loopback port. */
export async function startMock(fixture: Fixture, round = 0): Promise<MockHandle> {
  let current = round
  let world: World = worldFor(fixture, current)
  const requests: RequestRecord[] = []

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://mock')
      const raw = await readBody(request)
      const payload = parsePayload(raw, String(request.headers['content-type'] ?? ''))

      // Fixture control plane, so a person can walk the scenario by hand.
      if (url.pathname === '/__mock/requests') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(requests, null, 2))
        return
      }
      if (url.pathname === '/__mock/fixture') {
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ name: fixture.name, description: fixture.description, round: current,
            rounds: fixture.rounds?.length ?? 0, requests: requests.length }, null, 2))
        return
      }
      const switchTo = /^\/__mock\/round\/(\d+)$/.exec(url.pathname)
      if (switchTo) {
        current = Number(switchTo[1])
        world = worldFor(fixture, current)
        requests.length = 0
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ round: current }))
        return
      }

      const mockRequest: MockRequest = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
        ...payload ? { payload } : {},
      }
      let answer = handle(world, fixture.repository, mockRequest)
      answer = withEtag(answer, mockRequest)
      requests.push({ method: mockRequest.method, url: url.pathname + url.search, status: answer.status,
        ...mockRequest.headers['if-none-match'] ? { ifNoneMatch: mockRequest.headers['if-none-match'] } : {},
        ...payload ? { body: payload } : {} })
      const body = answer.status === 304 ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
      response.writeHead(answer.status, { ...answer.headers, 'content-length': Buffer.byteLength(body) })
      response.end(body)
    })().catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ message: String(error) }))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setRound(next: number) {
      current = next
      world = worldFor(fixture, current)
    },
    round: () => current,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  }
}
