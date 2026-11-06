/**
 * The world a fixture describes: repositories, Issues, pull requests, comments, reviews, CI checks and
 * notifications, in the shapes GitHub's REST API returns them.
 *
 * Timestamps in a fixture may be written as an offset such as `"+30s"`, which is materialised against
 * the moment the world is loaded. The GitHub Source only accepts events it sees as newer than the round
 * that started when it was switched on (`fresh()` in `src/sources/github.ts`), so fixtures use small
 * positive offsets instead of hard-coded dates.
 */

/** One actor, in GitHub's own vocabulary. */
export interface User {
  login: string;
  type?: 'User' | 'Bot';
  id?: number;
}

/** An Issue or a pull request as `issues/<n>` returns it. */
export interface Issue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  user: User;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: { url: string; merged_at?: string | null };
}

/** A pull request as `pulls/<n>` returns it. */
export interface Pull {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  html_url: string;
  head: { sha: string; ref: string; repo?: { full_name: string } | null };
  base: { sha: string; ref: string };
  draft?: boolean;
  auto_merge?: unknown;
  labels?: { name: string }[];
}

/** A conversation comment, an inline review comment, or a review. */
export interface Comment {
  id: number;
  body?: string | null;
  user: User;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  state?: string;
  commit_id?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  in_reply_to_id?: number | null;
  issue_url?: string;
  pull_request_url?: string;
}

/** One check run of a commit, as `commits/<sha>/check-runs` returns it. */
export interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | null;
  html_url?: string;
}

/** One commit status of a commit, as `commits/<sha>/statuses` returns it. */
export interface CommitStatus {
  context: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  updated_at?: string;
}

/** One notification of the agent's account. */
export interface Notification {
  id: string;
  repository: { full_name: string };
  subject: { title?: string; url?: string; type?: string; latest_comment_url?: string | null };
  reason?: string;
  unread?: boolean;
  updated_at: string;
}

/** The state a fixture describes. `rounds[i].patch` is deep-merged over the base before round `i`. */
export interface WorldSpec {
  default_branch?: string;
  head?: string;
  pollInterval?: number;
  issues?: Record<string, Issue>;
  pulls?: Record<string, Pull>;
  issueComments?: Record<string, Comment[]>;
  reviewComments?: Record<string, Comment[]>;
  reviews?: Record<string, Comment[]>;
  checks?: Record<string, CheckRun[]>;
  statuses?: Record<string, CommitStatus[]>;
  notifications?: Notification[];
  /** Issue and pull request numbers that answer HTTP 410, as a deleted Issue does. */
  gone?: number[];
  /** Numbers that answer HTTP 500, to exercise per-item failures. */
  broken?: number[];
  /** Entries of a repository-wide comment stream, served under `issues/comments` and `pulls/comments`. */
  conversationFeed?: Comment[];
  reviewCommentFeed?: Comment[];
  /** Files of the default branch, by path, for `readRepositoryPath`. */
  files?: Record<string, string>;
}

/** A whole fixture file. */
export interface Fixture {
  name: string;
  description: string;
  /** The repository the Source is configured for, as `owner/name`. */
  repository: string;
  agent: { login: string; noreply: string };
  /** The values the Source's configuration block holds (`GithubConfigSchema`). */
  config: Record<string, unknown>;
  world: WorldSpec;
  /** Later rounds patch the base world, e.g. CI turning red and then green again. */
  rounds?: { name?: string; patch?: WorldSpec }[];
}

/** A world after offset timestamps were materialised. */
export type World = Required<Pick<WorldSpec, 'default_branch' | 'pollInterval'>> & WorldSpec;

/** Resolves `"+30s"` against `now`, and leaves every other timestamp untouched. */
export function stamp<T>(value: T, now = Date.now()): T {
  if (typeof value === 'string') {
    const offset = /^\+(\d+)s$/.exec(value);
    return (offset ? new Date(now + Number(offset[1]) * 1000).toISOString() : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(item => stamp(item, now)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = stamp(item, now);
    return out as T;
  }
  return value;
}

/**
 * Expands a repeated list entry so a long list stays readable in a fixture: an item carrying
 * `"times": n` stands for `n` items, with `{i}` in its strings replaced by the item's number.
 */
export function expand<T>(value: T): T {
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      const times = item && typeof item === 'object' ? Number((item as { times?: unknown }).times ?? 0) : 0
      if (!times) { out.push(expand(item)); continue }
      const { times: _times, ...template } = item as Record<string, unknown>
      for (let index = 1; index <= times; index += 1) {
        const materialized = JSON.parse(JSON.stringify(template).replaceAll('{i}', String(index))) as unknown
        out.push(expand(materialized))
      }
    }
    return out as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = expand(item)
    return out as T
  }
  return value
}

/** Deep merge where arrays and scalars replace, objects merge; `undefined` in `patch` keeps the base value. */
export function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch as T;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return stamp(patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? merge(out[key], value) : stamp(value);
  }
  return out as T;
}

/**
 * Gives every Issue and pull request the numeric `id` GitHub assigns, which `IssueSchema` requires but a
 * fixture need not spell out. Ids are derived from the number so a fixture stays readable.
 */
export function withIds(world: WorldSpec): WorldSpec {
  const identified = <T extends { id?: number }>(entries: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(entries ?? {}).map(([number, item]) => [number, { id: Number(number) * 1000, ...item }]))
  return { ...world, issues: identified(world.issues), pulls: identified(world.pulls) }
}

/** The world of one round: the base world with every earlier round's patch applied, then offsets stamped. */
export function worldFor(fixture: Fixture, round: number, now = Date.now()): World {
  let world: WorldSpec = fixture.world;
  for (let index = 0; index < Math.min(round + 1, fixture.rounds?.length ?? 0); index += 1) {
    world = merge(world, fixture.rounds?.[index]?.patch);
  }
  const stamped = stamp(expand(withIds(world)), now);
  return { default_branch: 'main', pollInterval: 60, ...stamped } as World;
}

/** The Issue-shaped record a pull request takes in GitHub's repository-wide `/issues` list. */
export function asIssue(pull: Pull): Issue {
  return { id: pull.id ?? pull.number * 1000, number: pull.number, title: pull.title, body: pull.body ?? '', state: pull.state,
    user: pull.user, created_at: pull.created_at, updated_at: pull.updated_at, html_url: pull.html_url,
    pull_request: { url: `https://api.github.com/repos/x/y/pulls/${pull.number}`, merged_at: pull.merged_at ?? null } };
}
