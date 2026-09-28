# Contributing

Thanks for considering it. This project is early and the design decisions are
load-bearing, so PRs that explain *why* are far more valuable than PRs that
just change code.

## Status

Pre-release. Phases 1–2 of 8 are in progress and **the action does not yet
perform a review**. See [`docs/execution-plan.md`](docs/execution-plan.md) for
the phase breakdown and exit conditions. Issues and PRs are welcome now.

## Before you start

- For anything beyond a small fix, open an issue first. Several core decisions
  (private-repo-only, no persistent caching, fork PRs out of scope) are
  deliberate. Check that your idea does not conflict with one.
- Search existing issues. The action emits machine-readable diagnostic codes and
  most reports are a known code.

## Development setup

Requires **Node 24**. The repo pins it via ASDF:

```bash
asdf install nodejs 24.21.0
npm install
```

Do not use `asdf latest nodejs` — that may resolve to a version newer than
`runs.using` supports, and GitHub will reject the action. `node24` is the only
current option; there is no `node26`.

## The gate

Everything must pass. This is the same list CI runs:

```bash
npm run typecheck        # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run lint             # eslint, type-aware
npm test                 # unit + property + integration + security
npm run build            # tsup -> dist/index.js
npm run check:dist       # fails if the committed bundle is stale
```

**`dist/` is committed and must be rebuilt in the same PR as any `src/` change.**
CI enforces this. A PR that changes `src/` without rebuilding `dist/` will fail.

## Invariants that must not be broken

These are load-bearing. If your change touches one, say so explicitly in the PR
description and expect it to be discussed.

1. **Advisory only.** The action publishes findings. It never uses `APPROVE` or
   `REQUEST_CHANGES`, never blocks a merge, and never fails a workflow because
   a bug was found. The exit code is reviewer *operational health*.
2. **Never executes PR-controlled code.** Enforced by assertions in
   `tests/security/bundle.test.ts` against the shipped bundle. No
   `child_process`, `eval`, `Function`, git, or package-manager invocation.
3. **No paid routing, ever.** Three independent guards: config-time `:free`
   regex, per-request `:free` assertion, and `provider.max_price` pinned to
   zero. All three stay.
4. **Anchors are resolved locally, never taken from the model.** The model
   quotes source text; deterministic code maps that text to a diff location. A
   finding that cannot be uniquely anchored is declined, not guessed.
5. **The status a human reads must never overclaim.** `no_findings` means a
   review ran and found nothing. It is never a fallback for "the review did not
   run". A test asserts this exhaustively.
6. **Bump `PROMPT_VERSION` on any prompt, schema, or severity change.** Even
   for something that looks cosmetic — that judgement is what turns out to be
   wrong three iterations later.

## Commit messages

Conventional Commits, for a readable history and so release notes can be
summarised accurately when a release is cut.

```
feat(anchor): support multi-line ranges with mixed sides
fix(parser): reject findings with a missing path field
docs(readme): document the quota budget
test(property): assert ladder monotonicity
chore(deps): bump vitest to 3.2.7
```

Scopes in use: `diff`, `anchor`, `parser`, `schema`, `prompts`, `config`,
`github`, `llm`, `publisher`, `scheduler`, `eval`, `deps`.

## Cutting a release

Releases are manual, via the **Release** workflow (`workflow_dispatch`). This is
deliberate: the organisation forbids GitHub Actions from creating pull requests,
and more importantly a human should decide when `v1` ships, because `v1` is the
Marketplace listing.

1. Add a `## [x.y.z]` section to `CHANGELOG.md`, above `[Unreleased]`.
2. Run **Release** with `dry_run: true` to confirm version, tag, and notes.
3. Run it again without `dry_run`.

The workflow rebuilds from source, verifies the committed `dist/` matches, reruns
the bundle security assertions, then tags and publishes. It will not publish if
any check fails.

## Tests

- **Unit** — per module, no network.
- **Property** (`fast-check`, `tests/property/`) — the invariant evidence. If
  you touch anchoring or deduplication, add or update a property test. The
  central one is that *any anchor the resolver produces is on a real,
  commentable line of the stated file and side*.
- **Integration** (`msw`) — mocked GitHub and OpenRouter. No network, ever.
- **Security** — against `dist/index.js`, not `src/`.

Golden dataset fixtures live in `tests/golden-dataset/{development,regression,held-out}`.
**Do not read the `held-out` split while tuning a prompt.** It exists to detect
overfitting and is only meaningful if it stays untouched until a release gate.

## Adding a model

1. Verify via `GET /api/v1/models` that it exists, is `:free` with
   `pricing.prompt === "0"`, and declares the capabilities you claim.
2. Record its provider's data-retention posture in
   `src/config.ts`, with the date you verified it. This cannot be checked at
   runtime — the endpoints API requires a management key.
3. Add it to `DEFAULT_MODELS` with the correct capability flags, or model
   selection will build a request shape the endpoint rejects.
4. Note in a PR that `qwen/qwen3.8-27b:free` is the benchmarked default and
   that a new model needs a golden-dataset evaluation before it is promoted.

Watch out: a model exposing `response_format` but **not** `structured_outputs`
cannot be used with `json_schema` alongside `require_parameters: true` — that
excludes every endpoint and yields a 503. Those models select `JSON_OBJECT`
mode instead.

## Reporting bugs

Include the diagnostic code from the step summary. The summary lists every code
the run recorded, and most causes map to exactly one code.

## Code of conduct

Be decent. Assume good faith, especially in review of other people's work.
