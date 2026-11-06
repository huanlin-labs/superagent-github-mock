# Changelog

## 0.1.0 — 2026-11-06

- First release.
- `src/mock/`: a GitHub REST mock on `node:http` over one fixture "world" —
  notifications, issues, pulls, issue/review comments, reviews, check runs, commit
  statuses and contents; `Link` pagination, ETag → 304, `410 Gone`, `x-poll-interval`.
- `src/shim/gh.ts`: a `gh api` forwarding shim (`--include`, `--paginate --slurp`,
  `-f`, `-X/--method`, `-H`, and gh's `gh: … (HTTP 404)` + non-zero exit). Also
  runnable as a real `gh` on `PATH`.
- `src/harness/`: subclasses the prototype's real `Commands`, overriding only
  `run()`, so the Source's own repository restriction, `--paginate --slurp`
  parsing and `CliError` translation are exercised unmodified.
- Six fixtures: Issue mention, inline review thread, bodyless approval, default
  branch CI failure → recovery, deleted Issue (410), 120-notification pagination
  with ETag.
- 33 tests: 12 HTTP contract, 11 driving the real `pollRound()`, 3 channel sends
  (idempotency marker, review-thread reply, `gone` vs rethrow), 7 pull-request
  binding cases (`claimPull` / `observePull` / `branches`).
- MIT license; DSH Skill packaging via `SKILL.md`; GitHub Actions runs the suite
  against a checked-out prototype.
