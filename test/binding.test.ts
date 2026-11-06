/**
 * The pull-request half of a ticket: `claimPull` / `observePull` in `src/sources/github-pull.ts`.
 *
 * A GitHub ticket does not end because its worker said so — it ends because its pull request merged or
 * closed. These two functions are what binds a PR to a ticket and what reports that end, and they read
 * only `deployment`, `tickets`, `threads` and `atomic`, so a small stand-in for the ticket store is
 * enough to exercise the real code.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { harness, loadFixture, type Harness } from '../src/harness/context.ts'
import { prototypeModule } from '../src/harness/hooks.ts'

const pull = await import(prototypeModule('sources/github-pull.ts')) as {
  observePull: (ctx: unknown, pr: unknown) => Promise<boolean>
  claimPull: (ctx: unknown, ticketId: string, pr: unknown) => string | undefined
  agentPull: (pr: unknown, deployment: unknown) => boolean
  ticketBranch: (ticket: unknown, ref: string) => boolean
  pullsOf: (ticket: unknown, open?: boolean) => number[]
}

const open: Harness[] = []
after(async () => { await Promise.all(open.map(item => item.close())) })

const start = async (name: string): Promise<Harness> => {
  const h = await harness(await loadFixture(name))
  open.push(h)
  return h
}

/** A ticket, cut down to what the pull-request binding reads. */
function ticket(id: string, options: { follows?: { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }[];
  name?: string } = {}) {
  return {
    id,
    title: `Ticket ${id}`,
    channels: [],
    inputs: [],
    undelivered: [],
    assignments: [],
    subscriptions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
    ...options.follows ? { follows: options.follows } : {},
    ...options.name ? { execution: { name: options.name, directory: '/tmp/x', assignment: 'do it' } } : {},
  }
}

/** A SourceContext holding just the tickets, threads and deployment these two functions touch. */
function context(tickets: ReturnType<typeof ticket>[]) {
  const bound: { id: string; thread: { source: string; id: string }; own: boolean }[] = []
  const closed: { thread: { source: string; id: string }; outcome: string; at: string }[] = []
  const ctx = {
    deployment: { repository: 'acme/widgets', github: { login: 'superagent', noreply: 'agent@users.noreply.github.com', cli: 'gh' } },
    atomic: <T>(work: () => T): T => work(),
    threads: { get: () => undefined, subscribed: () => [], describe: () => undefined, patch: () => undefined },
    tickets: {
      get: (id: string) => tickets.find(item => item.id === id),
      open: () => tickets.filter(item => !(item as { ended?: unknown }).ended),
      bindThread: (id: string, thread: { source: string; id: string }, own: boolean) => { bound.push({ id, thread, own }) },
      threadClosed: (thread: { source: string; id: string }, outcome: string, at: string) => { closed.push({ thread, outcome, at }) },
    },
    triggers: { get: () => undefined, latest: () => undefined },
  }
  return { ctx, bound, closed }
}

/** A pull request as `pulls/<n>` answers it, with only the fields the binding reads. */
function pullRequest(fields: { number: number; state?: string; merged?: boolean; login?: string; ref?: string;
  repo?: string; merged_at?: string | null; closed_at?: string | null }) {
  return {
    number: fields.number,
    title: `PR ${fields.number}`,
    state: fields.state ?? 'open',
    merged: fields.merged ?? false,
    merged_at: fields.merged ? fields.merged_at ?? '2026-11-06T12:00:00.000Z' : fields.merged_at ?? null,
    closed_at: fields.closed_at ?? null,
    user: { login: fields.login ?? 'dana' },
    html_url: `https://github.com/acme/widgets/pull/${fields.number}`,
    head: { sha: 'a'.repeat(40), ref: fields.ref ?? 'fix/parser', repo: { full_name: fields.repo ?? 'acme/widgets' } },
  }
}

describe('pull request binding', () => {
  it('reports a merge once, to the ticket that follows the pull request', async () => {
    const h = await start('02-inline-review')
    const follows = [{ thread: 'github:40', own: true }]
    const { ctx, closed, bound } = context([ticket('t1', { follows })])

    const ended = await pull.observePull(ctx, pullRequest({ number: 40, state: 'closed', merged: true }))
    assert.equal(ended, true, 'a merged pull request has ended')
    assert.deepEqual(closed, [{ thread: { source: 'github', id: '40' }, outcome: 'merged', at: '2026-11-06T12:00:00.000Z' }])
    assert.equal(bound.length, 0, 'ending a pull request binds nothing new')
    assert.ok(h.mock, 'the mock is only there so the harness loads a real fixture')
  })

  it('reports a close without a merge as `closed`', async () => {
    const { ctx, closed } = context([ticket('t1', { follows: [{ thread: 'github:40', own: true }] })])
    assert.equal(await pull.observePull(ctx, pullRequest({ number: 40, state: 'closed' })), true)
    assert.equal(closed[0]!.outcome, 'closed')
  })

  it('auto-binds an open agent pull request whose branch is the ticket\'s name', async () => {
    const { ctx, bound } = context([ticket('t1', { name: 'tidy-parser' })])
    const pr = pullRequest({ number: 41, login: 'superagent', ref: 'agent/tidy-parser' })

    assert.equal(pull.agentPull(pr, ctx.deployment), true, 'the agent account opened it from this repository')
    assert.equal(await pull.observePull(ctx, pr), false)
    assert.deepEqual(bound, [{ id: 't1', thread: { source: 'github', id: '41' }, own: true }])
  })

  it('leaves a human pull request on an unrelated branch alone', async () => {
    const { ctx, bound, closed } = context([ticket('t1', { name: 'tidy-parser' })])
    assert.equal(await pull.observePull(ctx, pullRequest({ number: 42, login: 'dana', ref: 'feature/other' })), false)
    assert.equal(bound.length, 0)
    assert.equal(closed.length, 0)
  })

  it('refuses to bind a pull request that belongs to neither the ticket\'s origin nor its branch', async () => {
    const { ctx } = context([ticket('t1', { name: 'tidy-parser' })])
    const refused = pull.claimPull(ctx, 't1', pullRequest({ number: 43, login: 'dana', ref: 'feature/other' }))
    assert.match(String(refused), /does not belong to this ticket/)
    assert.match(String(refused), /agent\/tidy-parser|DSH_SUPERAGENT_NAME/)
  })

  it('binds the pull request a ticket was actually opened from', async () => {
    const { ctx, bound } = context([ticket('t1', { name: 'tidy-parser' })])
    // The origin trigger is a PR trigger for #40, so #40 belongs to this ticket whatever its branch.
    ctx.triggers.get = () => ({ id: 'trigger-1', source: 'github', meta: { isPr: true, number: 40 } })
    assert.equal(pull.claimPull(ctx, 't1', pullRequest({ number: 40, login: 'dana', ref: 'someone/else' })), undefined)
    assert.deepEqual(bound, [{ id: 't1', thread: { source: 'github', id: '40' }, own: false }])
  })

  it('reads the followed pull requests of a ticket, skipping closed ones', () => {
    const followed = ticket('t1', { follows: [
      { thread: 'github:40', own: true, closed: { at: '2026-11-06T12:00:00.000Z', outcome: 'merged' } },
      { thread: 'github:41', own: false },
      { thread: 'feishu:chat', own: false },
    ] })
    assert.deepEqual(pull.pullsOf(followed, true), [41], 'only the open GitHub thread counts as open')
    assert.deepEqual(pull.pullsOf(followed), [40, 41], 'a closed thread still names its pull request')
    assert.equal(pull.ticketBranch(ticket('t2', { name: 'tidy-parser' }), 'agent/tidy-parser'), true)
    assert.equal(pull.ticketBranch(ticket('t2', { name: 'tidy-parser' }), 'agent/other'), false)
  })
})
