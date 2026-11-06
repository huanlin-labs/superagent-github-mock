---
name: superagent-github-mock
description: "Offline mock of the GitHub REST API for dsh-superagent's GitHub Source: local HTTP server, gh forwarding shim, six fixtures, and tests that drive the unmodified pollRound(). | dsh-superagent GitHub Source 的离线 mock：本地 HTTP 服务、gh 转发 shim、六个 fixture，以及直接跑未改动 pollRound() 的测试。"
version: "0.1.0"
user-invocable: true
allowed-tools: Read, Bash
---

# superagent-github-mock

Use this skill when the user wants to **test or debug the GitHub Source of dsh-superagent
without network access, a GitHub token, or a signed-in `gh`** — for example "write a fixture
for a new webhook shape", "why does my poll not see this comment", or "show me what a
410 does to the round".

This is a **DSH Skill** that runs a Node program. It is **not** a Cordis native plugin and
installs no service.

## Install

```bash
git clone https://github.com/huanlin-labs/superagent-github-mock.git ~/.dsh/skills/superagent-github-mock
cd ~/.dsh/skills/superagent-github-mock
npm i zod@4.4.3 @deepseek-ai/schemastery   # or reuse an existing copy; see README §限制
```

Then point it at a prototype checkout, either with `SUPERAGENT_SRC=/path/to/dsh-superagent-prototype`
or by writing that path into `prototype.path`. The directory must contain `src/sources/github.ts`.
Requires **Node ≥ 24** (it runs TypeScript directly).

## Commands

```bash
npm test                     # 34 checks: mock contract, real pollRound, channel sends, PR binding
npm run list                 # what the six fixtures are
npm run dump                 # per-round Triggers, health lines and every request the Source made
npm run serve 01-issue-mention -- --port 8787     # then curl / follow Link headers by hand
```

`src/shim/gh.ts` also runs as a stand-in `gh` on `PATH`:

```bash
GITHUB_MOCK_URL=http://127.0.0.1:8787 node src/shim/gh.ts api "repos/acme/widgets/notifications?all=true" --include
```

## What to change for a new scenario

1. Copy a fixture in `fixtures/` and describe the world (`issues`, `pulls`, comments,
   reviews, checks, statuses, notifications). Timestamps may be written as `"+30s"`.
2. Start it: `npm run dump <your-fixture>` — that prints what the real `pollRound()` produced.
3. Add assertions to `test/pollRound.test.ts` (Trigger shape) or `test/contract.test.ts`
   (HTTP shape only, no prototype needed).

## Notes

- The mock answers only the paths the Source polls; anything else is 404, as GitHub does.
- Replies carry a `<!-- dsh-superagent:<id> -->` marker; the mock stores it, which is how the
  idempotency test works.
- No `tsc` in this project: TypeScript is annotated and erased by Node, never type-checked.
