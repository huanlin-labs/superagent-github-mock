/**
 * Scenario tests: the unmodified GitHub Source, running against the mock.
 *
 * Each test opens a fixture, lets the real `pollRound()` from
 * `dsh-superagent-prototype/src/sources/github.ts` run one or more rounds on it, and asserts on the
 * Triggers it produced. Nothing in the prototype is stubbed: the repository restriction, the schema
 * validation, the pagination, the ETag handling, the 410 handling and the Trigger translation are all
 * the original code — only the transport underneath `Commands` speaks to the mock.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { harness, loadFixture, stateKeys, type Harness } from '../src/harness/context.ts'
import { prototypeModule } from '../src/harness/hooks.ts'

/** The `state` keys the Source writes, read from the prototype so the tests cannot drift. */
const keys = await stateKeys()
const { githubThreadContext } = await import(prototypeModule('sources/github-read.ts')) as {
  githubThreadContext: { read: (commands: unknown, trigger: unknown, part: string, cursor?: string) => Promise<unknown> }
}

const open: Harness[] = []
after(async () => { await Promise.all(open.map(item => item.close())) })

const start = async (name: string): Promise<Harness> => {
  const h = await harness(await loadFixture(name))
  open.push(h)
  return h
}

describe('01 issue mention', () => {
  it('turns a notification of a mentioned Issue into one Trigger with a stable id', async () => {
    const h = await start('01-issue-mention')
    const round = await h.poll(0)
    assert.equal(round.error, undefined)
    assert.equal(round.received.length, 1)

    const [trigger] = round.received
    assert.equal(trigger!.source, 'github')
    assert.deepEqual(trigger!.threads, [{ source: 'github', id: '12' }])
    assert.equal(trigger!.actor.id, 'dana', 'the actor is the Issue author')
    assert.equal(trigger!.human, true)
    assert.equal(trigger!.addressed, 'mention', 'the body mentions @superagent')
    assert.equal(trigger!.meta.kind, 'issue')
    assert.equal(trigger!.meta.number, 12)
    assert.equal(trigger!.channel?.address.number, '12', 'replies go back to the Issue')
    assert.match(trigger!.text, /Flaky test in the parser suite/)
    assert.ok(trigger!.id.length > 0)
  })

  it('reads the same Issue twice without producing a second Trigger', async () => {
    const h = await start('01-issue-mention')
    const first = await h.poll(0)
    const second = await h.poll(0)
    assert.equal(first.received.length, 1)
    // The cursor moved past the Issue, and the id is derived from the number, so a replay is a no-op.
    assert.equal(second.received.length, 0)
    assert.ok(h.state(keys.since), 'the notification cursor is recorded')
  })

  it('records the Thread label and facts the panel shows', async () => {
    const h = await start('01-issue-mention')
    await h.poll(0)
    const thread = (h.ctx.threads as { get: (key: string) => Record<string, unknown> | undefined }).get('github:12')
    assert.ok(thread, 'polling describes the Thread it read')
    // `nameThread()` patches the title onto the Thread's meta and states its label and facts.
    assert.match(String((thread!.label ?? '')), /#12 Flaky test/)
    assert.equal((thread!.meta as Record<string, unknown>).title, 'Flaky test in the parser suite')
    assert.equal(((thread!.facts as Record<string, { value: string }>).number).value, '#12')
  })
})

describe('02 inline review', () => {
  it('emits the pull request and both inline review comments, with the file and line', async () => {
    const h = await start('02-inline-review')
    const round = await h.poll(0)
    assert.equal(round.error, undefined)
    assert.deepEqual(round.received.map(trigger => trigger.meta.kind), ['pull', 'inline', 'inline'])

    const [, root, reply] = round.received
    assert.equal(root!.meta.path, 'src/parser.ts')
    assert.equal(root!.meta.line, 41)
    assert.equal(root!.meta.commentId, 7001)
    assert.match(root!.text, /^src\/parser\.ts:41\n/, 'an inline comment reads as file:line then the diff tail')
    assert.equal(reply!.meta.inReplyTo, 7001)
    assert.doesNotMatch(reply!.addressed ?? '', /mention/, 'a reply that does not mention the agent is not addressed')
    assert.equal(root!.actor.id, 'reviewer')
  })

  it('reads the review thread through the real githubThreadContext', async () => {
    const h = await start('02-inline-review')
    const round = await h.poll(0)
    const inline = round.received.find(trigger => trigger.meta.commentId === 7001)!
    const context = await githubThreadContext.read(h.ctx.commands, inline, 'thread') as
      { messages: { id: string; from: string; text: string; reply_to?: string }[] }
    assert.equal(context.messages.length, 2)
    assert.equal(context.messages[0]!.from, 'reviewer')
    assert.match(context.messages[0]!.text, /swallows the second failure/)
    assert.ok(context.messages[1]!.reply_to, 'the reply is tied to the root comment')
  })
})

describe('03 review approval', () => {
  it('passes on a bodyless approval, because a worker may be waiting for that decision', async () => {
    const h = await start('03-review-approval')
    const round = await h.poll(0)
    const review = round.received.find(trigger => trigger.meta.kind === 'review')
    assert.ok(review, 'an APPROVED review with no body still reaches the Source')
    assert.equal(review!.text, 'APPROVED review of commit 4444444444444444444444444444444444444444')
    assert.equal(review!.actor.id, 'reviewer')
  })
})

describe('04 default branch CI', () => {
  it('reports the failure and then the recovery, each with its own revision', async () => {
    const h = await start('04-ci-failure-recovery')
    const first = await h.poll(0)
    assert.equal(first.received.length, 0, 'the first observation only sets the baseline')

    const failed = await h.poll(1)
    assert.equal(failed.received.length, 1)
    assert.equal(failed.received[0]!.meta.ci, true)
    assert.equal(failed.received[0]!.meta.revision, 1)
    assert.deepEqual(failed.received[0]!.threads, [{ source: 'github', id: 'ci:main' }])
    assert.match(failed.received[0]!.text, /^CI failed 1\/3 on main at 5555555/)
    assert.equal(failed.received[0]!.human, false, 'CI has no person behind it')
    assert.equal(failed.received[0]!.channel, undefined, 'CI has nowhere to reply')

    const recovered = await h.poll(2)
    assert.equal(recovered.received.length, 1)
    assert.equal(recovered.received[0]!.meta.revision, 2, 'a rising revision keeps the ids distinct')
    assert.match(recovered.received[0]!.text, /^CI passed 3\/3 on main/)
    assert.notEqual(recovered.received[0]!.id, failed.received[0]!.id)
  })
})

describe('05 deleted Issue', () => {
  it('drops a 410 from the round instead of failing it', async () => {
    const h = await start('05-issue-gone-410')
    const round = await h.poll(0)
    assert.equal(round.error, undefined, 'a 410 is not a reason to hold the Source in error')
    assert.equal(round.received.length, 0)
    assert.equal(round.interval, 60)
    const detail = String(h.health.at(-1)?.health.detail ?? '')
    assert.match(detail, /deleted on GitHub: #13/)
  })

  it('does not queue the dropped Issue for a retry', async () => {
    const h = await start('05-issue-gone-410')
    await h.poll(0)
    assert.deepEqual(h.state(keys.retries) ?? {}, {}, 'a 410 is permanent, so nothing is retried')
  })
})

describe('06 pagination and ETag', () => {
  it('follows every notification page and takes in only this repository\'s Issues', async () => {
    const h = await start('06-pagination-etag')
    const round = await h.poll(0)
    assert.equal(round.error, undefined)
    assert.deepEqual(round.received.map(trigger => trigger.meta.number), [50, 51])

    const pages = h.requests().filter(request => /notifications\?/.test(request.url))
    assert.equal(pages.length, 4, 'one request for the ETag probe plus three pages of results')
    assert.ok(pages.some(request => request.url.includes('page=2')))
    assert.ok(pages.some(request => request.url.includes('page=3')))
  })

  it('answers 304 to the repeat request and produces nothing new', async () => {
    const h = await start('06-pagination-etag')
    await h.poll(0)
    const before = h.requests().length
    const round = await h.poll(1)
    assert.equal(round.error, undefined)
    assert.equal(round.received.length, 0, 'the two Issues were read in the first round')
    const notModified = h.requests().slice(before).filter(request => request.status === 304)
    assert.ok(notModified.length > 0, 'the unchanged comment streams answer 304, costing no rate limit')
    assert.ok(notModified.every(request => request.ifNoneMatch), 'a 304 is only reachable through If-None-Match')
  })
})
