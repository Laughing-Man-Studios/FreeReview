# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut deliberately from the **Release** workflow (`workflow_dispatch`),
not automatically from commit messages. Automated release PRs are impossible
here because the organisation forbids GitHub Actions from creating pull
requests, and a manual trigger is the better model anyway while the action is
pre-release: `v1` is the Marketplace listing, and it should not appear because
someone merged a `feat:` commit on a Friday.

To cut a release:

1. Add a `## [x.y.z]` section to this file, above `[Unreleased]`.
2. Run the **Release** workflow with `version: x.y.z`. Use `dry_run: true` first
   to confirm the version, the tag, the assembled notes, and whether the moving
   major ref already exists — without publishing anything.
3. Confirm the result by running the **consumer-smoke** workflow against the
   moving ref (`ref: v1`) and opening the pull request it reports.

The workflow rebuilds, verifies the committed `dist/` matches source, re-runs the
security assertions against the bundle, tags, publishes, and then **moves the
`vX` branch** and verifies that ref resolves and carries a loadable `action.yml`.
It refuses to complete if any of that fails.

The moving `vX` branch is what makes `uses: Laughing-Man-Studios/FreeReview@v1`
work. A tag alone does not satisfy `@v1`, and cutting `v1.0.0` without the
branch would leave the documented install broken while the release looked
successful. Subversion bumps work by re-pointing the branch: cutting `v1.4.0`
moves `v1` forward and consumers on `@v1` receive it.

> **Marketplace.** Not yet published to the GitHub Marketplace. The action works
> from any repository via `uses: Laughing-Man-Studios/FreeReview@v1`.

## [1.0.0] — 2026-10-01

First stable release. Installs as `uses: Laughing-Man-Studios/FreeReview@v1`.

FreeReview reviews pull requests using only free OpenRouter model endpoints. It
costs $0, never approves or requests changes, never blocks a merge, and never
fails a workflow because a finding exists.

### How it works

A model **proposes** findings. Deterministic local code decides whether each one
can be anchored to exactly one verified location in the diff, and either publishes
it or discards it. A model cannot influence where a comment lands — only whether
it proposes something, and in what words.

That separation is the point. A finding anchored to a plausible but wrong line is
worse than no finding, because it is a confident claim about specific code.

### What is measured, not assumed

- **Model capability is probed, not read from metadata.** OpenRouter's
  `supported_parameters` is a union across endpoints and can be stale; one model
  advertised a capability that returned 404 on every request. Modes are chosen by
  measuring review quality in each working mode, not by taking the strongest one
  advertised — the same model can score 0.87 in one mode and 0.47 in another.
- **Prompt injection is measured.** Fixtures plant a suppression instruction
  directly above a real defect, so the only way to pass is to ignore the
  instruction. The default model resists; **the fallbacks do not** — see below.
- **Variance is measured.** Repeated identical runs vary by ±0.13 to ±0.26
  recall, which is wider than the gap between models. Single-run comparisons are
  reported as noise rather than rankings.

### Security

- **Three independent paid-routing guards**, each with a test that fails if
  removed. `provider.max_price` is pinned to zero, which OpenRouter *enforces* by
  refusing to route rather than by us asking nicely.
- **Credential redaction.** A finding about a hardcoded secret no longer
  republishes the secret — in the explanation, the quoted source, or the
  `suggestion` block, where accepting it would write the secret into the branch.
- **Zero-data-retention by default.** `strict` sends `zdr: true` and
  `data_collection: "deny"`. The optional `strict_providers` input additionally
  pins `provider.only`, so a provider attached to a model after verification
  cannot be selected.
- **Fork and external-contribution PRs are skipped before any code leaves the
  runner.** Provenance is decided by `head.repo.full_name`, never by branch names,
  which are attacker-controlled.
- **A run that reviewed nothing never reports "found nothing."** The two are
  opposites, and a reader who cannot tell them apart will treat a routing failure
  as a clean review.

### Known limitations

Read these before installing. They are stated plainly because a tool that hides
them is worse than one that does not have them.

- **Only the default model resists prompt injection.** The fallbacks have all
  been measured complying with suppression instructions written into a diff. If
  the primary is rate-limited and a review falls through, **a pull request author
  can suppress findings by adding a comment to their own diff.** Reviews produced
  by a fallback disclose this in the review body, which makes the risk visible
  rather than silent — but it does not prevent it. This is the largest open
  weakness in the project.
- **Free models miss real defects.** Measured recall on a held-out dataset was
  7/8 for the default model. A clean review is a lower bound, not a guarantee.
- **Reviews cover changed lines only.** Unchanged context is never commented on,
  by design.
- **Credentials with no recognisable shape are not redacted.** Vendor-prefixed
  keys, AWS key ids, GitHub/Slack/Google/SendGrid tokens, JWTs, PEM headers and
  credential assignments are. A high-entropy blob with no prefix is not.
  Redaction reduces the blast radius of an echoed secret; rotating a leaked key is
  still the only fix.
- **Private repositories only.** A public repository is skipped entirely.

### Verified

Live against a real repository: end-to-end review with correctly anchored inline
comments; injection and formatting-only diffs correctly producing nothing; an
oversized pull request refused at zero requests spent. A tagged release was
installed from a clean consumer repository and found and anchored a real defect.
Every Definition-of-Done item in [`docs/execution-plan.md`](docs/execution-plan.md)
is verified by a test.

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
- **`action.yml` validity check.** GitHub parses `action.yml` as an expression
  template, so a template expression in an input *description* makes the file
  unparseable and every `uses:` invocation fails at load time. This shipped
  once; `check:action` now guards it in CI and in the release.

### Pipeline

- **Strict unified diff parser and deterministic anchor resolver.** The model
  supplies source text, never a line number; local code maps that text to exactly
  one verified diff location, or declines to comment. Property-tested at 1000
  cases.
- **Injection-safe rendering.** Chat-template markers, role introducers, and
  fence escapes in diff content are neutralised, and the rendered fence is sized
  past the longest backtick run in the chunk.
- **Budgeted chunking and filtering.** Binary, generated, vendored, and lockfile
  content is excluded, with dependency changes reported rather than silently
  dropped. Chunks are packed to fit the input budget; one request can carry
  several files.
- **OpenRouter client with a three-part $0 guarantee.** Config-time `:free`
  validation, a per-request assertion, and `provider.max_price` pinned to zero —
  the last enforced server-side, so it holds even if the other two are bypassed.
  The client never retries; retries belong to the scheduler, which owns the
  budget and counts every attempt.
- **Request scheduler.** Per-run budget, untouchable daily reserve, concurrency
  and per-minute limits, bounded backoff honouring `Retry-After`, and
  deterministic model fallback. Cancellation aborts in-flight work immediately.
- **Capability-aware prompting.** Three request shapes: a strict `json_schema`
  where the model supports it, `json_object` where it supports only that, and
  prompt-carried JSON with defensive parsing where it supports neither.
- **Strict, non-coercing finding schema.** An unknown `severity` is rejected
  rather than mapped, and a finding with one bad field is rejected whole rather
  than partially interpreted. A model-supplied `lineNumber` or `anchor` cannot
  survive validation, so an injected "comment on line 42" is structurally inert.
- **Validation, deduplication, and staleness.** A suggestion wider than the
  span it replaces is dropped; findings are deduplicated by resolved location
  rather than by wording; and the head SHA is re-read immediately before
  publication, discarding everything if the pull request moved.
- **Review publication.** One atomic `COMMENT` review. A `422` isolates the
  offending comment by recursing into both halves rather than dropping the rest,
  and publishes a summary-only review if every comment is rejected.

### Security

- **A run that reviewed nothing can no longer say it found nothing.** Live
  verification caught a run in which every model failed to route and the
  published review read "found nothing material" — a clean bill of health
  issued by a run that examined no code. The summary now branches on chunks
  actually reviewed, before it branches on finding count.
- **The default configuration could not review anything under the default
  privacy mode.** All six original default models lack a zero-data-retention
  endpoint and returned `404`. Exactly one free model has one, and it is now the
  default; ZDR-capable models are ordered first in strict mode so the request
  budget is not spent on requests that cannot succeed.
- **`max_output_tokens` default raised to 4000.** The one ZDR-capable free
  model is a reasoning model, and at 1500 it spent the entire budget on
  reasoning and returned no content. Too small an output budget produces an
  *empty* response rather than a short one.
- **A `github_token` input was added.** GitHub does not expose `GITHUB_TOKEN`
  to an action invoked with `uses:`, so the README's own example failed with
  `MISSING_CREDENTIALS` until the token was declared as an input.
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

[Unreleased]: https://github.com/Laughing-Man-Studios/FreeReview/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Laughing-Man-Studios/FreeReview/compare/v0.1.0...v1.0.0
