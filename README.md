# FreeReview

**Advisory AI code review for pull requests, using only $0 OpenRouter free-model endpoints.**

FreeReview reviews a pull request's diff, asks a free-tier LLM whether the changed
code contains concrete defects, then **validates and anchors every proposed
finding locally** before publishing it as an inline review comment.

It never approves, never requests changes, never blocks a merge, and never fails a
workflow because a bug was found. It never checks out, builds, installs, tests, or
executes PR-controlled code.

> **Status: Phase 0 (foundations) complete.** The action currently loads and
> validates its configuration and exits without performing a review. The review
> pipeline is being assembled — see [`docs/execution-plan.md`](docs/execution-plan.md).

---

## The core idea

> The LLM proposes findings. Deterministic local code decides whether those
> findings are structurally valid, uniquely anchorable, deduplicated, current, and
> safe to publish.

A free-tier 27B model will happily hallucinate a line number, quote code that
isn't in your diff, or return three copies of the same finding. Every one of those
is caught locally, and anything that cannot be verified is **declined rather than
guessed**.

Three independent controls guarantee the $0 promise:

1. Non-`:free` model IDs are rejected at config time, before any network call.
2. The HTTP client asserts `:free` on every request.
3. `provider.max_price` is pinned to zero, which OpenRouter enforces by refusing
   to route. There is no paid fallback path.

---

## Usage

Requires a **private** repository and a pull request from a branch in the **same**
repository. Fork PRs are detected and skipped without sending any code anywhere.

```yaml
# .github/workflows/ai-review.yml
name: AI Review

on:
  pull_request:
    types: [opened, reopened, synchronize]

# Only used to cancel a superseded review when a new commit lands, which
# matters a lot against a 50-request/day budget.
concurrency:
  group: ai-code-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: Rogibb111/FreeReview@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

**Do not add `actions/checkout`.** This action obtains everything it needs through
the GitHub API and is specifically designed never to materialise your code.

---

## Privacy

By default (`privacy_mode: strict`) every request carries:

```json
"provider": { "zdr": true, "data_collection": "deny" }
```

Your diff is only routed to providers that do not retain prompts. If no eligible
free endpoint satisfies that, the action **reports the fact and skips the review**
— it never silently weakens the policy.

`privacy_mode: relaxed` drops both constraints. It is an explicit opt-in and is
reported loudly in the step summary *and* in the published review, so the person
whose code was sent to a third party can see that it happened.

> Endpoint-level privacy metadata is **not queryable at runtime** — OpenRouter's
> per-endpoint APIs require a management key. The default model pool therefore
> carries manually verified privacy posture in source, and runtime enforcement is
> delegated to OpenRouter's routing constraints.

---

## Cost and quota

OpenRouter's free-model allowance for an account with under $10 of credits is
**50 requests per day** and **20 per minute**. Failed requests count too.

| PR size | Requests |
| --- | --- |
| 1 file, 1 hunk | 1 |
| 3 files, ~200 lines | 1–2 |
| 8 files, ~900 lines | 4 |
| 20 files, ~2000 lines | 8 (the per-run cap) |

Defaults are tuned so a worst-case PR costs 8 requests, and the action reserves
the last 10 of the 50 daily allowance. It reads your remaining quota from
`GET /api/v1/key` before starting, and reports exhaustion rather than silently
producing a partial review.

---

## Exit codes

The exit status is **reviewer operational health**, never finding severity.

| Outcome | Exit |
| --- | --- |
| Findings published (any severity) | 0 |
| No findings | 0 |
| Fork PR / public repo / draft / closed | 0 |
| PR too large, quota exhausted, upstream unavailable | 0 |
| Stale commit, discarded review | 0 |
| Invalid config, missing credential, internal error | 1 |

---

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

Local `.tool-versions` pins Node 24 because `action.yml` declares
`runs.using: node24`. There is no `node26` option; `asdf latest nodejs` will
suggest one and it will be rejected by GitHub.

## Documentation

- [`docs/execution-plan.md`](docs/execution-plan.md) — the implementation plan,
  including the corrections made to the original design
- [`docs/plan.md`](docs/plan.md) — the original design record and rationale
