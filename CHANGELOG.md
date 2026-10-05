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

Steps 1–3 produce a GitHub release. They do **not** publish the action to the
Marketplace — see the note below, which is a required fourth step.

The workflow rebuilds, verifies the committed `dist/` matches source, re-runs the
security assertions against the bundle, tags, publishes, and then **moves the
`vX` branch** and verifies that ref resolves and carries a loadable `action.yml`.
It refuses to complete if any of that fails.

The moving `vX` branch is what makes `uses: Laughing-Man-Studios/FreeReview@v1`
work. A tag alone does not satisfy `@v1`, and cutting `v1.0.0` without the
branch would leave the documented install broken while the release looked
successful. Subversion bumps work by re-pointing the branch: cutting `v1.4.0`
moves `v1` forward and consumers on `@v1` receive it.

> **Tag naming, and one exception.** Releases are tagged `v1.0.0`, `v1.0.1`, and
> then **`1.0.2`** — created by hand without the `v` prefix, and immutable, so it
> cannot be corrected. Two consequences: compare links for `1.0.2` are written
> against the real tag (`.../v1.0.1...1.0.2`), and the next release must be
> `v1.0.3`, so the sequence is `v1.0.1`, `1.0.2`, `v1.0.3`. Nothing breaks —
> `uses: …@v1` resolves through the branch, not a tag — but a tag-prefix
> assumption in tooling or a compare link will silently point at nothing.
> `npm run check:changelog` verifies every compare link against real tags.
>
> **Marketplace.** Publishing to the GitHub Marketplace is a **manual** step that
> the Release workflow cannot perform — the "Publish this Action to the GitHub
> Marketplace" flag lives on the release object and has no API equivalent. So a
> release cut by this workflow is *not* a Marketplace release.
>
> Immutable releases are enabled and owner-enforced here, so a tag can never be
> reused or deleted. That dictates the order, and it is the reverse of the
> obvious one. Do **not** run the Release workflow and then edit the release to
> add the flag: if the edit is rejected, you hold a published release that
> cannot be converted, and the only escape is to cut another version. Instead:
>
> 1. Create the release by hand with the Marketplace box ticked, from a new tag.
> 2. *Then* move the `vX` branch to that tag — the workflow does not run in this
>    path, so nothing advances the branch on its own.
> 3. Verify with the **consumer-smoke** workflow against `ref: v1`.
>
> Full rationale, including the prerequisites and the one that cannot be checked
> from inside the repository, is in `docs/execution-plan.md` §14.3a.

## [1.0.2] — 2026-10-05

**Corrects a false security claim, and changes what every review body says.**
Behaviour of the review itself is unchanged: same models, same prompt, same
anchoring, same request budget. What changes is that the published review no
longer presents itself as injection-proof.

### Fixed

- **The default model is not injection-resistant, and every surface said it was.**
  Widening the injection fixture set from two payloads to eight payload classes
  found one that silences the primary outright — a suppression instruction
  disguised as a configuration value, planted beside a real defect, which it
  declined to report. An ablation control confirmed this was suppression rather
  than a missed bug: the same diff with the payload removed *is* reported.

  The earlier `0 / 2` was two observations of one payload shape. It was the
  load-bearing claim of the project, and it did not survive being tested against
  payloads that were shaped differently.

- **Reviews now disclose this on the default path.** `injectionResistance:
  "resistant"` emitted no disclosure at all, so while the primary carried that
  value every review it produced presented as clean. A fourth state,
  `partially-exposed`, discloses on every run: how many payload classes were
  resisted, which one was not, and that the ablation control is what
  distinguishes suppression from a missed bug.

### Known limitations

Restated, because this release is mostly about them:

- **No model in the free pool has been measured immune to instructions planted
  in a diff, including the default one.** A pull request author can suppress
  findings in their own review by landing a suppression string in the diff. This
  is reachable on the default configuration, not only when a review falls through
  to a fallback or when `privacy_mode: relaxed` is set. Reviews now say so; they
  do not prevent it.
- The default model also reports the injection payload itself as a finding on
  some fixtures, landing a comment on a line that is not defective. Known
  limitation, not a scored failure.

## [1.0.1] — 2026-10-02

Marketplace metadata and documentation. **No change to review behaviour, the
model pool, or the security posture** — the shipped action code is identical to
`v1.0.0`. This release exists because the listing could not be submitted without
it, and because the README was describing the action as unreleased.

### Fixed

- **`action.yml`'s description now passes the Marketplace submission.** It was
  131 characters against a limit of 125. The action ran correctly throughout, so
  nothing local caught it — the constraint is only enforced when a person
  submits the listing. `npm run check:action` now enforces the bound, verified at
  its edges: 125 characters fails, 124 passes.
- **Display name is now `Free Review Action`.** GitHub requires `name` to be
  unique across every action, user, and organisation, and `FreeReview` was
  already taken. This is display metadata only: `uses:` resolves on owner/repo, so
  `uses: Laughing-Man-Studios/FreeReview@v1` is unaffected for existing
  consumers. The published review header (`## FreeReview`) is a separate
  constant in `src/output/comment.ts` and is deliberately unchanged, so the
  consumer smoke test's grep for it still matches.
- **The README no longer advertises the action as unreleased and unmeasured.**
  Its banner still claimed the Marketplace listing was pending and that finding
  quality "has not yet been measured" — both false since `v1.0.0`, and the
  banner renders directly into the Marketplace listing, so it would have been
  read by exactly the audience deciding whether to trust the action.

### Known limitations, restated

These are unchanged from `v1.0.0` and are not new; the README rewrite made them
visible rather than adding them.

- **No model resists prompt injection, including the default one.** Measured
  2026-10-02 after widening the injection set from two payloads to eight: the
  default model resisted 6 of 8 payload classes and was silenced by two of the eight —
  a suppression string disguised as a configuration value — with the silencing
  confirmed by an ablation control rather than a missed bug. **The review can
  therefore be steered by the code under review on the default configuration**,
  not only under `privacy_mode: relaxed`. Every published review discloses this;
  none of it prevents it. This remains the largest open weakness, and it is now
  worse than earlier releases of this page described. Full numbers, including the
  scorer bug that counted "identified the injection" as compliance, are in
  [`docs/model-evaluation.md`](docs/model-evaluation.md).
- **Reviews are advisory.** They never block a merge, never request changes, and
  never fail a workflow, so a bad model run costs a comment and not a merge.
- **Reviews cover changed lines only.** Unchanged context is never commented on.
- **Redaction is not a substitute for rotating a leaked key.** Shapes that are
  not recognisable are not redacted.
- **Private repositories only.** A public repository is skipped entirely.

### Fixed (release tooling, not the action)

- **`consumer-smoke.yml` polled the wrong endpoint for the review.** It queried
  `/issues/N/comments`, which never contains a review, so a *successful* run was
  reported as a failure after ten minutes of polling.
- **The smoke test's probe never ran — once.** It was path-filtered to fire only
  when its own file changed, and nothing ever changed it. What had been verifying
  releases was an unrelated workflow in the test repository. The probe now runs
  on every pull request.
- **The smoke test no longer tries to write a workflow file.** An earlier fix had
  it write the probe itself, which GitHub rejects: a workflow cannot push a
  change under `.github/workflows` without the `workflows` scope, and granting
  that to a smoke test would mean asking every consumer to let CI rewrite its own
  CI.

### Verified

`@v1` resolves, installs from a clean consumer repository, reviewed a
seven-line diff, and published two findings, both anchored to verified lines.

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

- **No model resists prompt injection, including the default one.** Measured
  2026-10-02 after widening the injection set from two payloads to eight: the
  default model resisted 6 of 8 payload classes and was silenced by two of the eight —
  a suppression string disguised as a configuration value — with the silencing
  confirmed by an ablation control rather than a missed bug. **The review can
  therefore be steered by the code under review on the default configuration**,
  not only under `privacy_mode: relaxed`. Every published review discloses this;
  none of it prevents it. This remains the largest open weakness, and it is now
  worse than earlier releases of this page described. Full numbers, including the
  scorer bug that counted "identified the injection" as compliance, are in
  [`docs/model-evaluation.md`](docs/model-evaluation.md).
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

### Full change detail

The complete engineering record for this release. The sections above are the
curated summary; this is the itemised list of what actually shipped, kept here
because it was written as a running log and is worth more than a summary.

#### Added

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

#### Pipeline

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

#### Security

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

## [Unreleased]

Nothing yet. Add a `## [x.y.z]` section above this one when cutting a release.

[Unreleased]: https://github.com/Laughing-Man-Studios/FreeReview/compare/1.0.2...HEAD
[1.0.2]: https://github.com/Laughing-Man-Studios/FreeReview/compare/v1.0.1...1.0.2
[1.0.1]: https://github.com/Laughing-Man-Studios/FreeReview/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Laughing-Man-Studios/FreeReview/compare/v0.1.0...v1.0.0
