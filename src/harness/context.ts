/**
 * Builds the `SourceContext` the real `pollRound()` needs, over a running mock.
 *
 * `pollRound(ctx)` in `src/sources/github.ts` only touches the interfaces declared in
 * `src/sources/host.ts`: the deployment, `commands`, `config`, `state`, `threads`, `tickets`,
 * `triggers`, `receive`, `atomic` and `report`. Those are interfaces, not classes, so a plain object
 * implementing them is enough — the polling logic under test is the unmodified original.
 */
import { installVendoredResolution, prototypeModule } from './hooks.ts'
import { startMock, type MockHandle, type RequestRecord } from '../mock/server.ts'
import { createCommands, type MockDeployment } from './transport.ts'
import type { Fixture } from '../mock/world.ts'

installVendoredResolution()

/** One trigger the Source ingested, as the real translation functions built it. */
export interface Received {
  id: string;
  source: string;
  threads: { source: string; id: string }[];
  actor: { source: string; id: string };
  human: boolean;
  addressed?: 'mention' | 'direct';
  at: string;
  text: string;
  url?: string;
  channel?: { source: string; thread: string; address: Record<string, string> };
  meta: Record<string, unknown>;
}

/** What one call to `pollRound` produced. */
export interface RoundResult {
  round: number;
  /** The polling interval the round asked for, or the error it threw. */
  interval?: number;
  error?: string;
  received: Received[];
}

export interface Harness {
  fixture: Fixture;
  mock: MockHandle;
  ctx: Record<string, unknown>;
  received: Received[];
  health: { entry: string; health: Record<string, unknown> }[];
  results: RoundResult[];
  /** Switches the mock to `round`'s world, then runs the real `pollRound` once. */
  poll(round?: number): Promise<RoundResult>;
  /** Reads a KV record the Source wrote, such as `KV.github.since`. */
  state(key: string): unknown;
  /** Every request the mock answered, for asserting on what the Source asked for. */
  requests(): RequestRecord[];
  close(): Promise<void>;
}

/** The `KV.github` keys the Source writes, spelled as `src/kv.ts` spells them. */
export async function githubKeys(): Promise<Record<string, unknown>> {
  const { KV } = await import(prototypeModule('kv.ts')) as { KV: Record<string, any> }
  return KV.github
}

/** Opens a fixture: starts the mock and the real polling round on top of it. */
export async function harness(fixture: Fixture, options: { round?: number } = {}): Promise<Harness> {
  const mock = await startMock(fixture, options.round ?? 0)
  const deployment: MockDeployment = { repository: fixture.repository,
    github: { login: fixture.agent.login, noreply: fixture.agent.noreply, cli: 'gh' } }
  const commands = await createCommands(deployment, mock.url)
  const { pollRound } = await import(prototypeModule('sources/github.ts')) as {
    pollRound: (ctx: unknown, signal?: AbortSignal) => Promise<number>
  }
  const { KV } = await import(prototypeModule('kv.ts')) as { KV: Record<string, any> }

  const received: Received[] = []
  const health: Harness['health'] = []
  const results: RoundResult[] = []
  const records = new Map<string, unknown>()
  const threads = new Map<string, Record<string, unknown>>()

  const ctx: Record<string, unknown> = {
    deployment,
    commands,
    ready: Promise.resolve(),
    configured: () => true,
    config: (kind: string) => (kind === 'github' ? fixture.config : undefined),
    // `Engine.receive` stores a Trigger once and answers `duplicate` for a repeated id; a replay test
    // only needs the first half of that, plus the id the Source would have stored.
    receive: (trigger: Received) => {
      if (received.some(item => item.id === trigger.id)) return 'duplicate'
      received.push(trigger)
      return 'stored'
    },
    atomic: (work: () => unknown) => work(),
    state: {
      get: (key: string) => records.get(key),
      set: (key: string, value: unknown) => {
        if (value === undefined) records.delete(key)
        else records.set(key, value)
      },
      keys: () => [...records.keys()],
    },
    threads: {
      get: (key: string) => threads.get(key),
      subscribed: () => [],
      describe: (key: string, description: Record<string, unknown>) => {
        threads.set(key, { ...(threads.get(key) ?? {}), ...description })
      },
      patch: (key: string, meta: Record<string, unknown>) => {
        const thread = threads.get(key) ?? {}
        const cleaned = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined))
        threads.set(key, { ...thread, meta: { ...(thread.meta as Record<string, unknown> ?? {}), ...cleaned } })
      },
    },
    tickets: {
      get: () => undefined,
      open: () => [],
      bindThread: () => undefined,
      threadClosed: () => undefined,
    },
    triggers: {
      get: () => undefined,
      latest: (thread: string) => received.filter(item => item.threads.some(ref => `github:${ref.id}` === thread)).at(-1),
    },
    notify: () => undefined,
    report: (entry: string, state: Record<string, unknown>) => { health.push({ entry, health: state }) },
  }

  return {
    fixture,
    mock,
    ctx,
    received,
    health,
    results,
    async poll(round = mock.round()) {
      mock.setRound(round)
      const before = received.length
      try {
        const interval = await pollRound(ctx)
        const result: RoundResult = { round, interval, received: received.slice(before) }
        results.push(result)
        return result
      } catch (error) {
        const result: RoundResult = { round, error: String(error), received: received.slice(before) }
        results.push(result)
        return result
      }
    },
    state: (key: string) => records.get(key),
    requests: () => mock.requests,
    close: () => mock.close(),
  }
}

/** The keys `harness().state()` is asked for most, to keep tests readable. */
export async function stateKeys(): Promise<{ since: string; retries: string; cursor: (number: number) => string;
  stream: (id: string) => string; branchCi: string; ci: (number: number) => string }> {
  const KV = await githubKeys() as any
  return { since: KV.since, retries: KV.retries, cursor: KV.cursor, stream: KV.stream, branchCi: KV.branchCi, ci: KV.ci }
}

/** Reads a fixture file from `fixtures/`. */
export async function loadFixture(name: string): Promise<Fixture> {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const url = new URL(`../../fixtures/${name}.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as Fixture
}
