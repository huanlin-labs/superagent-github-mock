/**
 * Contract tests: the mock on its own, over real HTTP.
 *
 * These do not touch the prototype. They pin the GitHub shapes the Source depends on — pagination,
 * ETags, 410, and the `gh api` output the shim imitates — so that when a scenario test fails, it is
 * clear whether the mock or the Source changed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { startMock } from '../src/mock/server.ts'
import { ghApi } from '../src/shim/gh.ts'
import type { Fixture } from '../src/mock/world.ts'

const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture

const get = async (url: string, headers: Record<string, string> = {}): Promise<Response> => fetch(url, { headers })

test('01: a notification carries the poll interval and the API address of its Issue', async () => {
  const mock = await startMock(fixture('01-issue-mention'))
  try {
    const response = await get(`${mock.url}/repos/acme/widgets/notifications?all=true&per_page=50`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-poll-interval'), '60')
    const list = await response.json() as { subject: { url: string } }[]
    assert.equal(list.length, 1)
    assert.match(list[0]!.subject.url, /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/issues\/12$/)

    const issue = await (await get(`${mock.url}/repos/acme/widgets/issues/12`)).json() as { title: string; user: { login: string } }
    assert.equal(issue.user.login, 'dana')
    assert.match(issue.title, /Flaky test/)
  } finally { await mock.close() }
})

test('01: a path outside the configured repository is 404, as GitHub would answer', async () => {
  const mock = await startMock(fixture('01-issue-mention'))
  try {
    assert.equal((await get(`${mock.url}/repos/someone/else/issues/12`)).status, 404)
    assert.equal((await get(`${mock.url}/repos/acme/widgets/issues/999`)).status, 404)
  } finally { await mock.close() }
})

test('02: an inline review comment keeps its file, line and diff hunk', async () => {
  const mock = await startMock(fixture('02-inline-review'))
  try {
    const comments = await (await get(`${mock.url}/repos/acme/widgets/pulls/40/comments?per_page=100`)).json() as
      { id: number; path: string; line: number; diff_hunk: string; in_reply_to_id?: number }[]
    assert.equal(comments.length, 2)
    assert.equal(comments[0]!.path, 'src/parser.ts')
    assert.equal(comments[0]!.line, 41)
    assert.match(comments[0]!.diff_hunk, /^@@ -38,7 \+38,9 @@/)
    assert.equal(comments[1]!.in_reply_to_id, 7001)

    // An Issue number that is really a pull request answers through `issues/<n>` too, with `pull_request` set.
    const asIssue = await (await get(`${mock.url}/repos/acme/widgets/issues/40`)).json() as { pull_request?: unknown }
    assert.ok(asIssue.pull_request, 'issues/<n> must mark pull requests')
    const conversation = await (await get(`${mock.url}/repos/acme/widgets/issues/40/comments?per_page=100`)).json() as unknown[]
    assert.deepEqual(conversation, [])
  } finally { await mock.close() }
})

test('03: an approval review keeps its state, its commit and an empty body', async () => {
  const mock = await startMock(fixture('03-review-approval'))
  try {
    const reviews = await (await get(`${mock.url}/repos/acme/widgets/pulls/41/reviews?per_page=100`)).json() as
      { state: string; body: null; commit_id: string }[]
    assert.equal(reviews.length, 1)
    assert.equal(reviews[0]!.state, 'APPROVED')
    assert.equal(reviews[0]!.body, null)
    assert.equal(reviews[0]!.commit_id, '4444444444444444444444444444444444444444')
  } finally { await mock.close() }
})

test('04: check runs and commit statuses answer for a commit, and the default branch resolves to it', async () => {
  const mock = await startMock(fixture('04-ci-failure-recovery'), 1)
  try {
    const repo = await (await get(`${mock.url}/repos/acme/widgets`)).json() as { default_branch: string }
    assert.equal(repo.default_branch, 'main')
    const head = await (await get(`${mock.url}/repos/acme/widgets/commits/main`)).json() as { sha: string }
    assert.equal(head.sha, '5555555555555555555555555555555555555555')

    const checks = await (await get(`${mock.url}/repos/acme/widgets/commits/${head.sha}/check-runs?per_page=100`)).json() as
      { total_count: number; check_runs: { name: string; conclusion: string }[] }
    assert.equal(checks.total_count, 2)
    assert.deepEqual(checks.check_runs.map(run => `${run.name}:${run.conclusion}`), ['build:success', 'unit:failure'])

    const statuses = await (await get(`${mock.url}/repos/acme/widgets/commits/${head.sha}/statuses?per_page=100`)).json() as
      { context: string; state: string }[]
    assert.deepEqual(statuses.map(status => `${status.context}:${status.state}`), ['ci/legacy:success'])
  } finally { await mock.close() }
})

test('05: a deleted Issue answers 410, not 404, so the Source can drop it instead of failing the round', async () => {
  const mock = await startMock(fixture('05-issue-gone-410'))
  try {
    const response = await get(`${mock.url}/repos/acme/widgets/issues/13`)
    assert.equal(response.status, 410)
    const body = await response.json() as { message: string }
    assert.match(body.message, /deleted/i)
  } finally { await mock.close() }
})

test('06: 120 notifications arrive over three pages linked by rel="next"', async () => {
  const mock = await startMock(fixture('06-pagination-etag'))
  try {
    const first = await get(`${mock.url}/repos/acme/widgets/notifications?all=true&per_page=50`)
    assert.equal((await first.json() as unknown[]).length, 50)
    const link = first.headers.get('link') ?? ''
    assert.match(link, /rel="next"/)

    let pages = 1
    let next = /<([^>]+)>/.exec(link)![1]!
    while (next) {
      const response = await get(next)
      const items = await response.json() as unknown[]
      assert.ok(items.length > 0, `page ${pages + 1} must carry items`)
      pages += 1
      const more = /<([^>]+)>\s*;\s*rel="next"/.exec(response.headers.get('link') ?? '')
      next = more ? more[1]! : ''
    }
    assert.equal(pages, 3)
  } finally { await mock.close() }
})

test('06: an unchanged list answers 304 when the request repeats its ETag', async () => {
  const mock = await startMock(fixture('06-pagination-etag'), 1)
  try {
    const url = `${mock.url}/repos/acme/widgets/issues/comments?&sort=updated&direction=asc&per_page=100&since=2000-01-01T00:00:00.000Z`
    const first = await get(url)
    assert.equal(first.status, 200)
    const etag = first.headers.get('etag')
    assert.ok(etag, 'a GET list must carry an ETag')

    const second = await get(url, { 'if-none-match': etag! })
    assert.equal(second.status, 304)
    assert.equal(await second.text(), '')
  } finally { await mock.close() }
})

test('shim: `gh api --include` prints a status line and headers before the body', async () => {
  const mock = await startMock(fixture('01-issue-mention'))
  try {
    const result = await ghApi(['api', 'repos/acme/widgets/notifications?all=true&per_page=50', '--include'], mock.url)
    assert.equal(result.code, 0)
    const [headers, body] = result.stdout.split('\n\n')
    assert.match(headers!, /^HTTP\/2\.0 200/)
    assert.match(headers!, /x-poll-interval: 60/i)
    assert.match(headers!, /etag:/i)
    assert.ok(JSON.parse(body!) as unknown)
  } finally { await mock.close() }
})

test('shim: `--paginate --slurp` answers one array per page, as `Commands.pages` expects', async () => {
  const mock = await startMock(fixture('06-pagination-etag'))
  try {
    const result = await ghApi(['api', 'repos/acme/widgets/notifications?all=true&per_page=50', '--paginate', '--slurp'], mock.url)
    const pages = JSON.parse(result.stdout) as unknown[][]
    assert.equal(pages.length, 3)
    assert.deepEqual(pages.map(page => page.length), [50, 50, 20])
  } finally { await mock.close() }
})

test('shim: an HTTP failure becomes gh\'s own wording on stderr with a non-zero exit code', async () => {
  const mock = await startMock(fixture('05-issue-gone-410'))
  try {
    const missing = await ghApi(['api', 'repos/acme/widgets/issues/13'], mock.url)
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /^gh: .*\(HTTP 410\)$/)

    const notFound = await ghApi(['api', 'repos/acme/widgets/issues/999'], mock.url)
    assert.equal(notFound.code, 1)
    assert.match(notFound.stderr, /\(HTTP 404\)/)
  } finally { await mock.close() }
})

test('shim: a 304 exits non-zero, which is how ETag polling reaches `CliError.code`', async () => {
  const mock = await startMock(fixture('06-pagination-etag'), 1)
  try {
    const path = 'repos/acme/widgets/issues/comments?&sort=updated&direction=asc&per_page=100&since=2000-01-01T00:00:00.000Z'
    const first = await ghApi(['api', path, '--include'], mock.url)
    const etag = /etag:\s*(.+)/i.exec(first.stdout.split('\n\n')[0]!)?.[1]?.trim()
    assert.ok(etag)
    const second = await ghApi(['api', path, '--include', '-H', `If-None-Match: ${etag}`], mock.url)
    assert.equal(second.code, 1)
    assert.equal(second.stderr, 'gh: HTTP 304')
  } finally { await mock.close() }
})
