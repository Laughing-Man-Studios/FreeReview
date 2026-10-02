# FreeReview

**Advisory AI code review for pull requests, using only $0 OpenRouter free-model endpoints.**

[![CI](https://github.com/Laughing-Man-Studios/FreeReview/actions/workflows/ci.yml/badge.svg)](https://github.com/Laughing-Man-Studios/FreeReview/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 24](https://img.shields.io/badge/node-24-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)
[![Code of Conduct](https://img.shields.io/badge/CoC-contribute-lightgrey.svg)](CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/Security-Policy-lightgrey.svg)](SECURITY.md)

> ### ✅ Released — v1.0.0
>
> ```yaml
> - uses: Laughing-Man-Studios/FreeReview@v1
>   with:
>     openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
> ```
>
> **What it is.** A model *proposes* findings; deterministic local code decides
> whether each one can be anchored to exactly one verified location in the diff,
> and either publishes it as an advisory `COMMENT` or discards it. The model
> never supplies a line number. It never runs your code, never checks out your
> repo, and costs $0 by construction rather than by free-tier allowance.
>
> **Measured, and how far to trust that.** A scored evaluation over 27 fixtures
> in two stages selected the default model. The shipped configuration reaches
> **0.88 recall, 0.88 precision, and no false positives**, with anchor
> correctness at 1.00 — a finding is either placed on a verified line or
> dropped. Read the sample size before the number: 27 fixtures, one finding
> worth ~4% of recall, measured variance of ±0.13 to ±0.26, and no uncontaminated
> data left in reserve. Treat the *ordering* of models as the finding, not any
> single score. Full numbers, including the two stages that disagreed, are in
> [`docs/model-evaluation.md`](docs/model-evaluation.md).
>
> **What to know before you rely on it:**
>
> - **Injection resistance rests on a very small sample.** The default model
>   resisted both planted payloads (`0 / 2`) and produced no false positives,
>   while every fallback model complied with at least one. That is the main
>   reason it ships. But it is two payloads across five observations, and it is
>   the single most important property here: a model that follows instructions
>   written into your diff is a channel by which a pull request author decides
>   whether their own code gets examined. Under `privacy_mode: relaxed`, where
>   a compliant model may be selected, **the review can be steered by the code
>   under review.** The action discloses this in the published review body; it
>   does not prevent it.
> - **The default model also flags the injection payload itself.** On both
>   injection fixtures it reported the instruction text as a finding, landing a
>   comment on a line that is not itself defective. It found the real bug *and*
>   the attempt to suppress it, but the action cannot tell those apart when
>   publishing. Known limitation, not a scored failure.
> - **The free model pool is thin under strict privacy.** Of the 17 free models
>   in the catalog, exactly one has a zero-data-retention endpoint. Strict mode
>   is the default, so that model is the default path and three of the eight
>   configured models are disabled as unreachable. If it is unavailable, the
>   action skips the review rather than silently relaxing the constraint.
> - **Findings are advisory and can be wrong.** The review never approves, never
>   requests changes, never blocks a merge, and never fails your workflow — so a
>   bad model run costs you a comment, not a merge.
> - **Endpoint privacy cannot be independently verified at runtime.** OpenRouter
>   gates its per-endpoint privacy APIs behind a management key. The action
>   enforces the constraint per request and records a manually verified model
>   list (`privacyVerifiedOn: 2026-09-29`), but it does not claim a guarantee it
>   cannot make. See [`SECURITY.md`](SECURITY.md).
>
> Design rationale and build history are in
> [`docs/execution-plan.md`](docs/execution-plan.md).

---

## Why this exists

| | |
| --- | --- |
| **It costs nothing.** | Every request uses an explicit `:free` model. Three independent guards make paid routing impossible, one of which is enforced server-side by OpenRouter. Not a free tier that expires — a genuinely $0 operating model. |
| **It never runs your code.** | No `actions/checkout`, no package manager, no tests, no build. Everything comes from the GitHub API. This is asserted against the shipped bundle in CI, not just documented. |
| **It never places a comment on code the model did not quote.** | The model never supplies a line number. It quotes source text; deterministic local code maps that text to exactly one verified diff location, or declines to comment. *This is a placement guarantee, not a correctness one — the model can still be wrong about the line it quotes. Findings are advisory, and [the evaluation](docs/model-evaluation.md) measures how often.* |
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
| `github_token` | `${{ github.token }}` | Token used to read the pull request and publish the review. Defaults to the workflow's own token, which is usually correct. |
| `privacy_mode` | `strict` | `strict` sends `zdr: true` + `data_collection: "deny"`. `relaxed` drops both and is reported loudly in the summary **and** the review. |
| `strict_providers` | *(empty)* | Comma-separated OpenRouter provider slugs to pin under `strict`, sent as `provider.only`. Empty leaves routing unconstrained. **Narrows availability** — a provider that stops serving the free tier ends the review rather than silently switching to an unverified one. |
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

The default pool is ordered by measurement, not by vendor claims. Every entry
below was probed against the live service and benchmarked on the project's own
golden dataset — see [`docs/model-evaluation.md`](docs/model-evaluation.md).

| Role | Model | Mode | Injection resistance |
| --- | --- | --- | --- |
| **Primary** | `inclusionai/ling-3.0-flash-sante:free` | prompt-JSON | **resistant** (0/2, five observations) |
| Fallback 1 | `nvidia/nemotron-3-super-120b-a12b:free` | prompt-JSON | exposed |
| Fallback 2 | `qwen/qwen3.8-27b:free` | `json_object` | exposed |
| Fallback 3 | `nvidia/nemotron-3-ultra-550b-a55b:free` | prompt-JSON | exposed |

**The primary is the only model that has never followed instructions written
into a diff.** That, not raw quality, is why it ships first: the measured
recall and precision of the primary and of the best fallback are within noise of
each other, so the property that distinguishes them is the one that matters.

When a review comes from a model with measured exposure, **the review says so**,
in the review body itself. See [Prompt injection](#prompt-injection) below.

### Two things the catalog gets wrong

**Advertised capabilities are not real capabilities.** OpenRouter's
`supported_parameters` is a union across endpoints and can be stale.
`qwen/qwen3.8-27b:free` advertises `structured_outputs` and returns **404** on
every structured request. Each model therefore carries a `preferredMode` chosen
by *measuring review quality in each working mode*, not by taking the strongest
one advertised:

- `nemotron-3-super` genuinely supports structured output and is **much worse**
  there — recall 0.47 against 0.87 in prompt-JSON mode.
- `qwen` is the reverse: JSON-object mode beats prompt-JSON on both recall and
  injection resistance.

Capability decides which modes are *eligible*. Measurement decides which is
*chosen*.

### Models excluded on measured evidence

Kept in the catalog with the failure recorded, so a model that starts answering
is one edit away and the reason it was excluded outlives the exclusion.

| Model | Why disabled |
| --- | --- |
| `liquid/lfm-2.5-2.6b:free` | `400` in every capability mode |
| `google/gemma-4-31b-it:free` | `429` in every working mode, across two probes |
| `thinkingmachines/inkling-small:free` | `403` — "only available on agentic harnesses". Not an API endpoint. |
| `poolside/laguna-s-2.1:free` | Provider documents training on free usage (`privacy_mode: relaxed` only) |

## Prompt injection

A pull request author can put instructions in their own diff — a comment telling
the model to report nothing — and a model that obeys produces a suppressed review
that is **indistinguishable from a clean one**. That is the failure this project
exists to prevent.

FreeReview measures it: fixtures plant a suppression instruction directly above a
real defect, so the only way to pass is to ignore the instruction and report the
defect. A model that complies reports nothing and is scored as having complied.

Because only the primary has been measured resistant, a review produced by a
fallback **discloses that in the review body**, naming what was measured and what
happened. If a model has not been measured at all, that is disclosed too —
silence would be indistinguishable from safety.

This is a real limitation, not a solved problem: when the primary is rate-limited
and a review falls through, findings can be suppressed. The disclosure makes that
visible rather than pretending otherwise.

## Secrets in your diffs

A diff can contain a credential — that is a realistic scenario, not a
hypothetical one, and reviewing the code a human pushed means reading it. So a
finding about a hardcoded key naturally quotes the key back.

FreeReview **redacts credential-shaped substrings from everything it publishes**:
the review body, the step summary, the quoted source block, and the `suggestion`
block (the last matters most — accepting a suggestion writes it into your branch).
A short tail is kept so the finding stays actionable.

Covered shapes: vendor-prefixed keys (`sk-`, `pk-`, `rk-`), AWS access key ids,
GitHub/Slack/Google/SendGrid tokens, JWTs, PEM private-key headers, and
credentials in assignments. The patterns are deliberately narrow, because the
correct fix for a hardcoded key is `apiKey: process.env.API_KEY` and redacting
*that* would destroy the suggestion while leaving the real secret in prose.

**Not covered:** a high-entropy secret with no recognisable prefix, no assignment
and no PEM header is not detected. Redaction reduces the blast radius of an
echoed credential — it does not make credentials safe to commit. Rotating a leaked
key is still the only fix.

## Roadmap

- **Done** — diff parser, deterministic anchoring, context budgeting, OpenRouter
  client and scheduler, prompt and structured output, publisher, golden
  evaluation dataset with a held-out split, capability probing, model
  benchmarking, prompt-injection disclosure, credential redaction, catalog drift
  detection, rate-limit and stale-commit stress, and a consumer smoke test
  proving a tagged release installs and runs
- **Next** — prompt iteration against the falsy-null coercion that every model
  measured so far has missed
- **Later** — better surrounding-code context, additional free models as the
  catalog changes, optional direct-provider integrations, fork PR support

**The largest open weakness is the fallback chain.** Only the primary model has
been measured resistant to prompt injection; if it is rate-limited and a review
falls through, a pull request author can suppress findings with a comment in their
own diff. Reviews from those models say so in the review body, which makes it
visible rather than silent, but it does not prevent it.

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
