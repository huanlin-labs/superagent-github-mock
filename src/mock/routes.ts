/**
 * The GitHub REST surface the `github` Source polls, answered from a fixture world.
 *
 * Every route here exists because `src/sources/github.ts`, `github-read.ts`, `github-pull.ts` or
 * `github-channel.ts` calls it; `README.md` maps each one back to the line that reads it. Anything
 * else answers 404, which is also what the Source expects from a path GitHub does not serve.
 */
import { createHash } from 'node:crypto'
import { asIssue, type Comment, type World } from './world.ts'

/** A response the mock produced, before it becomes HTTP. */
export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  /** A JSON value, or a string for raw-content reads. */
  body: unknown;
}

export interface MockRequest {
  method: string;
  /** The path with the leading `/repos/<owner>/<repo>` prefix intact, as it arrived. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** The request body of a POST, already parsed when it was JSON. */
  payload?: Record<string, unknown>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): MockResponse =>
  ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body })

const error = (status: number, message: string): MockResponse =>
  json({ message, documentation_url: 'https://docs.github.com/rest', status }, status)

/** Splits `.../commits/heads/abc` style paths correctly: every segment may itself contain `/`. */
const segments = (path: string): string[] => path.replace(/^\/+/, '').split('/')

/** GitHub's page cap: `per_page` defaults to 30 and never exceeds 100. */
function paging(query: URLSearchParams): { page: number; per_page: number } {
  const asked = Number(query.get('per_page') ?? 30)
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1)
  return { page, per_page: Number.isFinite(asked) ? Math.min(100, Math.max(1, asked)) : 30 }
}

/** Returns the requested page and a `Link: <...>; rel="next"` header when more items follow. */
function paginate<T>(items: T[], request: MockRequest): { items: T[]; headers: Record<string, string> } {
  const { page, per_page } = paging(request.query)
  const start = (page - 1) * per_page
  const slice = items.slice(start, start + per_page)
  if (start + per_page >= items.length) return { items: slice, headers: {} }
  // GitHub sends an absolute URL built from the host the request arrived on, so a person following the
  // link by hand stays on this mock instead of being sent to api.github.com.
  const origin = `http://${request.headers.host ?? 'mock'}`
  const next = new URL(request.path, origin)
  const link = `<${origin}${next.pathname}?${new URLSearchParams({ ...Object.fromEntries(request.query), page: String(page + 1) })}>; rel="next"`
  return { items: slice, headers: { link } }
}

/** Applies `since` to a list the way GitHub does: only records updated at or after it. */
function sinceFilter<T extends { updated_at?: string; created_at?: string; submitted_at?: string }>(items: T[], request: MockRequest): T[] {
  const since = request.query.get('since')
  if (!since) return items
  const at = Date.parse(since)
  if (!Number.isFinite(at)) return items
  return items.filter(item => Date.parse(item.updated_at ?? item.submitted_at ?? item.created_at ?? '') >= at)
}

const byUpdated = (a: { updated_at?: string }, b: { updated_at?: string }): number =>
  (a.updated_at ?? '').localeCompare(b.updated_at ?? '')

/** An ETag over the serialized body, so repeating an unchanged request can answer 304. */
const etagOf = (body: string): string => `W/"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`

/**
 * Answers one API call. `repository` is the `owner/name` the Source is configured for; a request for
 * another repository is answered by the same world only when the fixture names it, otherwise 404.
 */
export function handle(world: World, repository: string, request: MockRequest, now = Date.now()): MockResponse {
  const parts = segments(request.path)
  const method = request.method.toUpperCase()

  // /repos/<owner>/<repo>
  if (parts[0] !== 'repos') return error(404, 'Not Found')
  const owner = parts[1]
  const name = parts[2]
  const rest = parts.slice(3)
  if (`${owner}/${name}` !== repository) return error(404, 'Not Found')

  // /repos/<o>/<r>                     — pollBranchCi reads `default_branch` from here.
  if (rest.length === 0) {
    if (method !== 'GET') return error(405, 'Method Not Allowed')
    return json({ full_name: repository, default_branch: world.default_branch, private: false })
  }

  if (rest[0] === 'notifications' && rest.length === 1) {
    if (method !== 'GET') return error(405, 'Method Not Allowed')
    const items = sinceFilter([...(world.notifications ?? [])], request).sort((a, b) => byUpdated(b, a))
    const page = paginate(items, request)
    return json(page.items, 200, { 'x-poll-interval': String(world.pollInterval), ...page.headers })
  }

  if (rest[0] === 'issues' && rest.length === 1) {
    // Repository-wide Issues *and* pull requests, oldest first, as `issues?state=all&sort=updated` does.
    const all = [...Object.values(world.issues ?? {}), ...Object.values(world.pulls ?? {}).map(asIssue)]
      .filter(item => (world.gone ?? []).includes(item.number) === false)
    const items = sinceFilter(all, request).sort(byUpdated)
    const page = paginate(items, request)
    return json(page.items, 200, page.headers)
  }

  if (rest[0] === 'issues' && rest[1] === 'comments' && rest.length === 2) {
    const items = sinceFilter([...(world.conversationFeed ?? [])], request).sort(byUpdated)
    const page = paginate(items, request)
    return json(page.items, 200, page.headers)
  }

  if (rest[0] === 'pulls' && rest[1] === 'comments' && rest.length === 2) {
    const items = sinceFilter([...(world.reviewCommentFeed ?? [])], request).sort(byUpdated)
    const page = paginate(items, request)
    return json(page.items, 200, page.headers)
  }

  if (rest[0] === 'issues' && rest.length >= 2) {
    const number = Number(rest[1])
    if (!Number.isFinite(number)) return error(404, 'Not Found')
    if ((world.gone ?? []).includes(number)) return error(410, 'This issue was deleted')
    if ((world.broken ?? []).includes(number)) return error(500, 'Server Error')
    const issue = world.issues?.[String(number)] ?? (world.pulls?.[String(number)] ? asIssue(world.pulls[String(number)]!) : undefined)
    if (!issue) return error(404, 'Not Found')
    if (rest.length === 2) {
      if (method !== 'GET') return error(405, 'Method Not Allowed')
      // Issues and pull requests share one number sequence; `issues/<n>` answers for both.
      const pull = world.pulls?.[String(number)]
      return json(pull ? { ...issue, ...pull, pull_request: { url: `${issue.html_url}` } } : issue)
    }
    if (rest[2] === 'comments') {
      const path = request.path
      if (method === 'POST') {
        const comments = world.issueComments?.[String(number)] ?? []
        const body = String(request.payload?.body ?? '')
        const comment: Comment = { id: 900000 + comments.length + 1, body, user: { login: 'superagent' },
          html_url: `${issue.html_url}#issuecomment-${900000 + comments.length + 1}`, created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(), issue_url: `http://mock${path.replace(/\/comments$/, '')}` }
        comments.push(comment)
        if (!world.issueComments) world.issueComments = {}
        world.issueComments[String(number)] = comments
        return json(comment, 201)
      }
      const items = sinceFilter([...(world.issueComments?.[String(number)] ?? [])], request).sort(byUpdated)
      const page = paginate(items, request)
      return json(page.items, 200, page.headers)
    }
    return error(404, 'Not Found')
  }

  if (rest[0] === 'pulls' && rest.length >= 2) {
    if (rest[1] === 'comments' && rest.length === 3) {
      // `pulls/comments/<id>`: github-channel.ts reads a review comment before replying in its thread.
      const id = Number(rest[2])
      const all = [...Object.values(world.reviewComments ?? {}).flat(), ...(world.reviewCommentFeed ?? [])]
      const comment = all.find(item => item.id === id)
      return comment ? json(comment) : error(404, 'Not Found')
    }
    const number = Number(rest[1])
    if (!Number.isFinite(number)) return error(404, 'Not Found')
    if ((world.gone ?? []).includes(number)) return error(410, 'This pull request was deleted')
    if ((world.broken ?? []).includes(number)) return error(500, 'Server Error')
    const pull = world.pulls?.[String(number)]
    if (!pull) return error(404, 'Not Found')
    if (rest.length === 2) return json(pull)
    if (rest[2] === 'comments') {
      // `pulls/<n>/comments/<root>/replies`: github-channel.ts answers an inline review comment.
      if (rest.length === 5 && rest[4] === 'replies') {
        if (method !== 'POST') return error(405, 'Method Not Allowed')
        const comments = world.reviewComments?.[String(number)] ?? []
        const reply: Comment = { id: 800000 + comments.length + 1, body: String(request.payload?.body ?? ''),
          user: { login: 'superagent' }, in_reply_to_id: Number(rest[3]),
          html_url: `${pull.html_url}#discussion_r${800000 + comments.length + 1}`, created_at: new Date(now).toISOString() }
        comments.push(reply)
        if (!world.reviewComments) world.reviewComments = {}
        world.reviewComments[String(number)] = comments
        return json(reply, 201)
      }
      const items = sinceFilter([...(world.reviewComments?.[String(number)] ?? [])], request).sort(byUpdated)
      const page = paginate(items, request)
      return json(page.items, 200, page.headers)
    }
    if (rest[2] === 'reviews') {
      const items = [...(world.reviews?.[String(number)] ?? [])].sort(byUpdated)
      const page = paginate(items, request)
      return json(page.items, 200, page.headers)
    }
    return error(404, 'Not Found')
  }

  if (rest[0] === 'commits' && rest.length >= 3) {
    const sha = rest[1]
    if (rest[2] === 'check-runs') {
      // pullChecks asks with `--paginate --slurp`: several pages, each `{ check_runs: [...] }`.
      const runs = world.checks?.[sha ?? ''] ?? world.checks?.['*'] ?? []
      const page = paginate(runs.slice(), request)
      return json({ total_count: runs.length, check_runs: page.items }, 200, page.headers)
    }
    if (rest[2] === 'statuses') {
      const statuses = world.statuses?.[sha ?? ''] ?? world.statuses?.['*'] ?? []
      const page = paginate(statuses.slice(), request)
      return json(page.items, 200, page.headers)
    }
    return error(404, 'Not Found')
  }

  if (rest[0] === 'commits' && rest.length === 2) {
    // `commits/<branch>`: pollBranchCi resolves the default branch to the commit it points at.
    const ref = rest[1] ?? ''
    const sha = world.head ?? (world.checks && Object.keys(world.checks)[0]) ?? 'a'.repeat(40)
    if (ref !== world.default_branch && ref !== sha) return error(404, 'No commit found for SHA')
    return json({ sha, commit: { message: 'fixture' } })
  }

  if (rest[0] === 'contents') {
    // readRepositoryPath: a file is raw text, a directory is a list of entries.
    const path = rest.slice(1).join('/')
    const files = world.files ?? {}
    if (path in files) return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: files[path] ?? '' }
    const prefixes = Object.keys(files).filter(key => key.startsWith(`${path}/`))
    if (!prefixes.length) return error(404, 'Not Found')
    const entries = [...new Set(prefixes.map(key => key.slice(path.length + 1).split('/')[0] ?? ''))]
      .filter(Boolean)
      .map(entry => ({ name: entry, type: prefixes.some(key => key === `${path}/${entry}`) ? 'file' : 'dir' }))
    return json(entries)
  }

  return error(404, 'Not Found')
}

/** Answers with an ETag so a repeat request carrying `If-None-Match` gets the 304 GitHub sends. */
export function withEtag(response: MockResponse, request: MockRequest): MockResponse {
  if (response.status !== 200 || typeof response.body === 'string') return response
  if (request.method.toUpperCase() !== 'GET') return response
  const serialized = JSON.stringify(response.body)
  const etag = etagOf(serialized)
  const headers = { ...response.headers, etag }
  const asked = request.headers['if-none-match']
  if (asked && asked.split(',').map(value => value.trim()).includes(etag)) {
    return { status: 304, headers: { ...headers, 'content-length': '0' }, body: null }
  }
  return { ...response, headers }
}
