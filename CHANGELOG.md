# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes are generated from conventional commits, so the commit subject
line matters: `fix(anchor): reject context-only anchors` produces a `fix` entry
under `Anchoring`, and `feat(publisher): ...` produces a minor bump.

> **Pre-release.** No tagged release has been published yet. The action is
> under active development and is **not yet published to the GitHub
> Marketplace**. Phases 1 and 2 of 8 are complete; the review pipeline does not
> yet run. See [`docs/execution-plan.md`](docs/execution-plan.md).

## [Unreleased]

### Added

- **Eligibility gate** — a fork, external-contribution, public-repository,
  draft, closed, or non-`pull_request` PR is detected and skipped before any
  code leaves the runner. Same-repository provenance is decided by
  `head.repo.full_name`, never by branch names, which are attacker-controlled.
- **Immutable review identity** — a run captures `reviewHeadSha` from the API
  and attributes every result to
  `repository + PR + head SHA + prompt version + model ID + config version`.
- **GitHub REST client** with a pinned API version, a retry taxonomy that
  distinguishes retryable failures from terminal ones, and bounded pagination.
- **Three independent paid-routing guards.** A non-`:free` model ID is rejected
  at config time; the HTTP client asserts `:free` per request; and
  `provider.max_price` is pinned to zero, which OpenRouter enforces by refusing
  to route. There is no paid fallback path.
- **Machine-readable diagnostics** — 40 codes, of which exactly 7 are treated
  as action failures. Finding severity never influences the exit code.
- **Security assertions against the shipped bundle.** CI runs 21 checks against
  `dist/index.js` rather than `src/`, because the bundle is what consumers
  execute: no `child_process`, no `eval`, no `Function` constructor, no git, no
  package-manager invocation, only `node:` builtins, and exactly two
  append-only file writes, both to GitHub-managed `GITHUB_*` paths.
- **`dist/` integrity check.** Fails the build if the committed bundle drifts
  from `src/`, preventing the classic "source fixed, dist stale" release bug.

### Security

- HTTP 401 is classified as a terminal credential failure. Previously it fell
  through to a non-blocking skip, which meant a bad token produced a **green
  run that had reviewed nothing**.
- Log output is escaped for GitHub Actions workflow commands and passed through
  secret-pattern redaction. Unescaped `%0A` in a message injects a fake log
  line; `::error::` injects a fake workflow command.
- A run status never reports `no_findings` unless a review actually completed
  and identified nothing. Previously an unrecognised diagnostic fell back to
  `no_findings`, which would tell a developer their code was clean when it had
  never been examined.

[Unreleased]: https://github.com/Laughing-Man-Studios/FreeReview/compare/v0.0.0...HEAD
