# FreeReview

**Advisory AI code review for pull requests, using only $0 OpenRouter free-model endpoints.**

[![CI](https://github.com/Laughing-Man-Studios/FreeReview/actions/workflows/ci.yml/badge.svg)](https://github.com/Laughing-Man-Studios/FreeReview/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 24](https://img.shields.io/badge/node-24-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)
[![Code of Conduct](https://img.shields.io/badge/CoC-contribute-lightgrey.svg)](CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/Security-Policy-lightgrey.svg)](SECURITY.md)

> ### ⚠️ Pre-release — not yet published to the Marketplace
>
> **The action now reviews pull requests end to end.** Phases 0–6 of 8 are
> complete and verified live against a real repository on 2026-09-29: a real
> off-by-one was found, anchored to the correct line, and published as an
> advisory `COMMENT` review using one OpenRouter request.
>
> Phases 7–8 remain: a scored evaluation against a golden dataset, and
> hardening plus the first tagged release. The Marketplace listing is held until
> the model is selected on measured results rather than assumption.
>
> **What to know before you rely on it:**
>
> - **The free model pool is thin under strict privacy.** Of the 17 free models
>   in the catalog, exactly one has a zero-data-retention endpoint. Strict mode
>   is the default, so that model is the default path. It has no structured
>   output support, so it relies on defensive parsing rather than API-enforced
>   JSON. It is a real review; its finding quality has not yet been measured.
> - **Findings are advisory and can be wrong.** The review never blocks a merge,
>   never requests changes, and never fails your workflow.
> - **Endpoint privacy cannot be independently verified at runtime.** OpenRouter
>   gates its per-endpoint privacy APIs behind a management key. The action
>   enforces the constraint per request and records a manually verified model
>   list, but it does not claim a guarantee it cannot make. See
>   [`SECURITY.md`](SECURITY.md).
>
> Follow along in [`docs/execution-plan.md`](docs/execution-plan.md), or watch
> the repository.

---

## Why this exists

| | |
| --- | --- |
| **It costs nothing.** | Every request uses an explicit `:free` model. Three independent guards make paid routing impossible, one of which is enforced server-side by OpenRouter. Not a free tier that expires — a genuinely $0 operating model. |
| **It never runs your code.** | No `actions/checkout`, no package manager, no tests, no build. Everything comes from the GitHub API. This is asserted against the shipped bundle in CI, not just documented. |
| **It never places a comment on code the model did not quote.** | The model never supplies a line number. It quotes source text; deterministic local code maps that text to exactly one verified diff location, or declines to comment. *This is a placement guarantee, not a correctness one — the model can still be wrong about the line it quotes. Findings are advisory, and Phase 7 measures how often.* |
| **Privacy is enforced, not implied.** | By default, requests carry `provider.zdr: true` and `provider.data_collection: "deny"`. If no eligible endpoint qualifies, the action **skips the review** rather than quietly relaxing the constraint. |

The incumbents — CodeRabbit, Copilot, Sourcery — all cost money, and all of
them see your code. If either of those is a problem, this is built for it.

## How it works

```
Pull request opened
  → eligibility gate        fork? public? draft? closed?          skip, exit 0
  → capture HEAD SHA        immutable review identity
  → fetch diff              GitHub API only, never a checkout
  → size gate               skip if the PR exceeds the budget
  → filter + chunk          bounded, token-budgeted hunks
  → quota preflight         read remaining daily allowance first
  → model call              one call per chunk, capability-gated
  → validate + anchor       ← every finding must resolve uniquely
  → deduplicate
  → re-check HEAD SHA       discard if a commit landed meanwhile
  → publish                 one COMMENT review, advisory
```

The design principle, unchanged from the original plan:

> The LLM proposes findings. Deterministic local code decides whether those
> findings are structurally valid, uniquely anchorable, deduplicated, current,
> and safe to publish.

## Requirements

- A **private** repository
- Pull requests from a branch in the **same** repository
- A free OpenRouter account (works with or without credits — see [Quota](#quota-and-cost))
- Node 24 runner (all GitHub-hosted runners)

## Usage

```yaml
# .github/workflows/ai-review.yml
name: AI Review

on:
  pull_request:
    types: [opened, reopened, synchronize]

# Cancel a superseded review when a new commit lands. This matters a lot
# against a 50-request/day budget: without it, every push to an open PR burns
# another review's worth of quota.
concurrency:
  group: ai-code-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

# The only permissions required. Do not add more.
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: Laughing-Man-Studios/FreeReview@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          github_token: ${{ github.token }}
```

`github_token` is not optional in practice: GitHub does not expose
`GITHUB_TOKEN` to an action invoked with `uses:`, so it has to be wired
explicitly. Setting `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` on the
step works equally well.

**Do not add `actions/checkout`.** The action obtains everything it needs
through the API and is specifically designed never to materialise your code.

Add `if: github.event.pull_request.draft == false` if you don't want drafts
reviewed at all.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `openrouter_api_key` | *required* | OpenRouter API key. Read from the environment, never logged. |
| `privacy_mode` | `strict` | `strict` sends `zdr: true` + `data_collection: "deny"`. `relaxed` drops both and is reported loudly in the summary **and** the review. |
| `primary_model` | bundled | An explicit `:free` model ID. Non-`:free` IDs are rejected before any network call. |
| `fallback_models` | bundled | Comma-separated `:free` IDs to try in order when the primary is unavailable. |
| `max_changed_lines` | `2000` | Skip (non-blocking) if the PR exceeds this many changed lines. |
| `max_input_tokens` | `24000` | Hard per-request input budget. Chunks are packed to fit. |
| `max_output_tokens` | `1500` | Output budget reserved for the structured response. Counts against the context window. |
| `max_requests_per_run` | `8` | Hard cap including retries and fallbacks. Tuned so a worst-case PR costs ~6 reviews/day of the 50/day allowance. |
| `max_concurrency` | `2` | Concurrent requests. Capped at 4. |
| `max_findings_per_chunk` | `5` | Maximum findings accepted per chunk. |
| `include_suggestions` | `false` | Attach ` ```suggestion ` blocks. Off by default — prove the findings are useful before optimising patches. |
| `debug_payloads` | `false` | Log full prompts and responses. **Exposes your source code in workflow logs.** |

## Outputs

| Output | Description |
| --- | --- |
| `status` | `reviewed`, `no_findings`, `skipped_*`, or `failed`. |
| `findings_count` | Inline findings published. |
| `unanchored_count` | Model findings that could not be uniquely anchored, and were therefore **not** published inline. |
| `files_reviewed` | Files included in model context. |
| `model_used` | Model that produced the published findings. |
| `requests_used` | OpenRouter requests spent, including retries and fallbacks. |
| `review_url` | URL of the published review. |

## Why wasn't my PR reviewed?

The step summary at the bottom of every run lists a **diagnostic code** for each
reason. This is the complete list of ways a review gets skipped:

| Code | Meaning | Fix |
| --- | --- | --- |
| `UNSUPPORTED_PR_SOURCE` | Fork or external-contribution PR | Open a branch in the same repository. Deliberate: reviewing a fork means sending third-party code to a third party. |
| `PUBLIC_REPOSITORY` | Base repository is public | By design. Public code needs no external review; the action declines rather than assume consent. |
| `DRAFT_PR` | Pull request is a draft | Mark ready, or add `if: github.event.pull_request.draft == false`. |
| `PR_CLOSED` / `PR_ALREADY_MERGED` | Not open | Nothing to review. |
| `PR_TOO_LARGE` | Exceeds `max_changed_lines` | Raise the input, or review a smaller PR. Splitting a large PR is usually better anyway. |
| `CONTEXT_TOO_LARGE` | Chunks cannot fit the token budget | Lower `max_input_tokens` or split the PR. |
| `NO_REVIEWABLE_FILES` | Everything was filtered | Only binaries, generated files, or lockfiles changed. |
| `OPENROUTER_QUOTA_EXHAUSTED` | Daily allowance spent | The 50/day allowance resets at UTC midnight. Check `GET /api/v1/key` → `free_model_daily_requests.remaining`. |
| `NO_ELIGIBLE_MODEL` / `NO_ELIGIBLE_PROVIDER` | No free model satisfies the config | Under `strict`, the ZDR + no-data-collection combination may have no free endpoint. Try `privacy_mode: relaxed`, or check the free-model catalog. |
| `OPENROUTER_RATE_LIMITED` | 20 requests/minute cap hit | Lower `max_concurrency`. |
| `STALE_HEAD_SHA` | A commit landed during review | Working as intended — results for the old commit were discarded. Re-run on the new head. |
| `UNSUPPORTED_EVENT` | Triggered on something other than `pull_request` | Use `on: pull_request`. |

`status` will be `failed` (exit 1) only for a genuine misconfiguration:
`CONFIG_INVALID`, `MISSING_CREDENTIALS`, `INVALID_GITHUB_CONTEXT`,
`DIFF_PARSE_FAILED`, `OPENROUTER_AUTH_FAILED`, `INTERNAL_ERROR`.

## Quota and cost

OpenRouter's allowance for free models on an account with **under $10** of
credits is **50 requests per day** and **20 per minute**. With $10+ credits it
rises to 1,000/day. **Failed requests count too**, so retries are tightly
bounded.

| PR size | Requests |
| --- | --- |
| 1 file, 1 hunk | 1 |
| 3 files, ~200 lines | 1–2 |
| 8 files, ~900 lines | 4 |
| 20 files, ~2000 lines | 8 (the per-run cap) |

Defaults are tuned so a worst-case PR costs 8 requests — about **6 PRs/day** at
the cap, ~25/day for typical PRs. The action reads your remaining allowance from
`GET /api/v1/key` *before* starting, reserves the last 10 of the 50, and reports
exhaustion rather than silently producing a partial review.

## Exit codes

The exit status is **reviewer operational health**, never finding severity.

| Outcome | Exit |
| --- | --- |
| Findings published (any severity, including `critical`) | 0 |
| No findings | 0 |
| Any `skipped_*` reason above | 0 |
| Misconfiguration or internal error | 1 |

A run that found a security vulnerability and a run that found nothing both
succeed. This is the point: an advisory reviewer must not be able to block a
merge, or it becomes a merge gate with a hallucination rate.

## Privacy

By default every request carries:

```json
"provider": { "zdr": true, "data_collection": "deny" }
```

Only providers without prompt retention are eligible. If none qualifies among
free models, the action reports that and skips — it never silently downgrades
the policy.

`privacy_mode: relaxed` drops both constraints. It is an explicit opt-in,
announced in the step summary *and* in the published review body, so the person
whose code was sent to a third party can see it happened.

**An honest limitation:** OpenRouter's per-endpoint privacy APIs require a
management key, so this action **cannot** verify at runtime which provider
served a request. It enforces the routing constraints and delegates to
OpenRouter; the default model pool carries manually verified provider posture in
source. See [`SECURITY.md`](SECURITY.md) for the full threat model.

## Models

The default pool is a starting point, not a quality ranking. The authoritative
ordering is whatever the project's own golden-dataset evaluation measures —
see [`docs/model-evaluation.md`](docs/model-evaluation.md) once published.

| Model | Context | Structured output | Note |
| --- | --- | --- | --- |
| `qwen/qwen3.8-27b:free` | 262K | JSON Schema | Benchmarked default |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262K | JSON Schema | Primary structured-output fallback |
| `liquid/lfm-2.5-2.6b:free` | 64K | JSON Schema | Fallback |
| `google/gemma-4-31b-it:free` | 262K | `response_format` only | Cannot use `json_schema`; uses JSON-object mode |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | none | Prompt-JSON mode with defensive parsing |
| `poolside/laguna-s-2.1:free` | 262K | none | **Disabled by default** — provider documents training on free usage |
| `thinkingmachines/inkling-small:free` | 1M | none | **Disabled by default** — provider logs and retains free prompts |

Disabled models remain in the code and are reachable under
`privacy_mode: relaxed`.

## Roadmap

- **Now** — diff parser, deterministic anchoring, context budgeting, OpenRouter
  client and scheduler, prompt and structured output, publisher
- **Then** — golden evaluation dataset with a held-out split, model
  benchmarking, prompt tuning
- **Later** — better surrounding-code context, additional free models as the
  catalog changes, optional direct-provider integrations, fork PR support

See [`docs/execution-plan.md`](docs/execution-plan.md).

## Development

```bash
asdf install nodejs 24.21.0     # matches runs.using: node24
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run check:dist              # fails if the committed bundle is stale
```

`dist/` is committed because GitHub Actions executes it directly. CI fails if it
drifts from `src/`. Do **not** use `asdf latest nodejs` — it may resolve to a
version `runs.using` does not support.

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Documentation

- [`docs/execution-plan.md`](docs/execution-plan.md) — implementation plan, and
  the corrections made to the original design
- [`docs/plan.md`](docs/plan.md) — the original design record and rationale
- [`SECURITY.md`](SECURITY.md) — threat model and disclosure process
- [`CHANGELOG.md`](CHANGELOG.md) — release notes
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — invariants that must not be broken

## License

[MIT](LICENSE)
