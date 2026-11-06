/**
 * The outbound half of the Source: `sendGithub` in `src/sources/github-channel.ts`.
 *
 * Every reply carries a hidden `<!-- dsh-superagent:<id> -->` marker, because a send can fail after
 * GitHub already accepted it and a retry must not post twice. That promise is only testable against
 * something that keeps what it was sent — which is exactly what the mock is.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { harness, loadFixture, type Harness } from '../src/harness/context.ts'
import { prototypeModule } from '../src/harness/hooks.ts'

const { sendGithub } = await import(prototypeModule('sources/github-channel.ts')) as {
  sendGithub: (host: { commands: unknown }, message: Record<string, unknown>) => Promise<'sent' | 'gone'>
}

const open: Harness[] = []
after(async () => { await Promise.all(open.map(item => item.close())) })

const start = async (name: string): Promise<Harness> => {
  const h = await harness(await loadFixture(name))
  open.push(h)
  return h
}

/** The message shape `Outbox` hands the Channel: where to reply, what to say, and its own id. */
const reply = (number: number, url: string, text: string, id = `reply-${number}`): Record<string, unknown> => ({
  id,
  kind: 'reply',
  text,
  ticketId: 'ticket-1',
  channel: { source: 'github', thread: `github:${number}`, address: { number: String(number), url } },
})

const posts = (h: Harness): { url: string; body?: Record<string, unknown> }[] =>
  h.requests().filter(request => request.method === 'POST') as never

describe('channel replies', () => {
  it('posts an Issue comment once, with the idempotency marker inside it', async () => {
    const h = await start('01-issue-mention')
    const message = reply(12, 'https://github.com/acme/widgets/issues/12', 'Looking into it.', 'reply-issue-12')

    assert.equal(await sendGithub({ commands: h.ctx.commands }, message), 'sent')
    assert.equal(posts(h).length, 1)
    assert.equal(posts(h)[0]!.url, '/repos/acme/widgets/issues/12/comments')
    assert.match(String(posts(h)[0]!.body!.body), /^Looking into it\.\n\n<!-- dsh-superagent:reply-issue-12 -->$/)

    // A retry of the same Outbox message must not post a second comment.
    assert.equal(await sendGithub({ commands: h.ctx.commands }, message), 'sent')
    assert.equal(posts(h).length, 1, 'the marker makes the send idempotent')
  })

  it('answers an inline review comment in its own thread', async () => {
    const h = await start('02-inline-review')
    const url = 'https://github.com/acme/widgets/pull/40#discussion_r7001'
    const message = reply(40, url, 'Fixed in the next push.', 'reply-review-7001')

    assert.equal(await sendGithub({ commands: h.ctx.commands }, message), 'sent')
    const [post] = posts(h)
    assert.equal(post!.url, '/repos/acme/widgets/pulls/40/comments/7001/replies',
      'a review-thread reply goes to the thread root, not to the PR conversation')
    assert.match(String(post!.body!.body), /<!-- dsh-superagent:reply-review-7001 -->/)

    assert.equal(await sendGithub({ commands: h.ctx.commands }, message), 'sent')
    assert.equal(posts(h).length, 1)
  })

  it('answers `gone` for a deleted Issue, and throws for anything retryable', async () => {
    const h = await start('05-issue-gone-410')
    const message = reply(13, 'https://github.com/acme/widgets/issues/13', 'Closing this out.')
    // A 410 means the target can never receive the reply, so Outbox drops it instead of retrying.
    assert.equal(await sendGithub({ commands: h.ctx.commands }, message), 'gone')
    assert.equal(posts(h).length, 0)

    // A path the mock does not serve is a 404, which the Channel must rethrow: a private repository
    // can answer 404 while access is being repaired, and that reply is still worth retrying.
    await assert.rejects(
      () => sendGithub({ commands: h.ctx.commands }, reply(999, 'https://github.com/acme/widgets/issues/999', 'x')),
      /404/,
    )
  })
})
