# Security Policy

## The short version

FreeReview sends pull request diffs to a third-party inference provider
(OpenRouter). That is the whole risk, and it is not small. This document
describes exactly what happens, and what is structurally impossible.

If you cannot accept sending source code to an external provider, **do not use
this action.** That is a legitimate decision, and no configuration makes it
otherwise.

## Supported versions

| Version | Supported |
| --- | --- |
| `v1` (latest) | Yes |
| `< v1` | No — upgrade |

## What leaves the runner

Only these, and only after the eligibility gate passes:

| Sent | When | Destination |
| --- | --- | --- |
| Unified diff hunks for reviewable files | Per chunk | `openrouter.ai/api/v1/chat/completions` |
| PR title | Once, per request | Same |
| Repository owner/name and PR number | Once, per request | Same |
| Reviewed commit SHA (short form) | Once, per request | Same |

**Never sent:** the repository working tree, file contents of unchanged files,
git history, commit messages other than the current head SHA, secrets, the
`OPENROUTER_API_KEY`, the `GITHUB_TOKEN`, or any other environment variable.

Surrounding context beyond the diff is opt-in per request and fetched through
the GitHub contents API as *data*; it is never written to disk.

## What is structurally impossible

These are enforced by test assertions in CI against the shipped bundle
(`dist/index.js`), not merely by intent:

- **No code execution.** No `child_process`, no `exec`/`spawn`/`fork`, no
  `eval`, no `Function` constructor, no `node:vm`, no WebAssembly. There is no
  code path from repository content to execution.
- **No checkout.** The action does not use `actions/checkout`, `simple-git`, or
  `isomorphic-git`, and reads no git repository.
- **No filesystem writes beyond two.** Exactly two append-only writes, both to
  the GitHub-managed `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` paths. No
  `writeFileSync`, no directory creation, no deletion, no cache files.
- **No third-party runtime dependencies.** The published artifact is a single
  self-contained bundle requiring only `node:` builtins. Consumers install
  nothing, so there is no dependency on the action's own supply chain at
  install time.
- **No paid inference.** A non-`:free` model ID is rejected at config time
  before any network call. The client re-asserts `:free` per request. And
  `provider.max_price` is pinned to zero, which OpenRouter enforces by refusing
  to route — so even a misconfiguration cannot produce a bill.

## Credential redaction in published output

A diff can contain a credential — that is a realistic scenario, not a
hypothetical one, and reviewing the code a human pushed means reading it. So a
finding about a hardcoded key naturally quotes the key back.

FreeReview redacts credential-shaped substrings from everything it publishes: the
review body, the step summary, the quoted source block, and the `suggestion` block
(the last matters most, since accepting a suggestion writes it into the branch). A
short tail is kept so the finding stays actionable.

The patterns are deliberately conservative and prefix-anchored, because this runs
on every review: the correct fix for a hardcoded key is `apiKey: process.env.API_KEY`,
and redacting that would destroy the suggestion while leaving the real secret in
prose. Covered shapes are vendor-prefixed keys (`sk-`, `pk-`, `rk-`), AWS access key
ids, GitHub/Slack/Google/SendGrid tokens, JWTs, PEM private-key headers, and
credentials in assignments.

**Not covered, and not claimed to be:** a high-entropy secret with no recognised
prefix, no assignment and no PEM header is not detected. Redaction reduces the
blast radius of an echoed credential; it does not make credentials safe to commit.
Rotating a leaked key remains the only fix.

---

## Prompt injection

Repository content is untrusted and may contain text engineered to look like
instructions. Defence is layered, and no single layer is trusted:

1. **Rendering.** The diff is emitted inside a delimited block whose fence is
   longer than any fence in the content, so the model cannot terminate the
   block early. Lines resembling role markers (`system:`, `<|im_start|>`,
   headings) are neutralised.
2. **System prompt.** Establishes, before any task framing, that repository
   content is data and that nothing in it can change the task or the output
   contract.
3. **Output validation.** A finding whose explanation is near-verbatim identical
   to an injection string present in the diff is dropped.
4. **Tests.** The golden dataset carries eight injection fixtures spanning
   distinct payload classes — fenced-block escape, role-turn impersonation,
   claimed human approval, text concealed from human review, a suppression
   string disguised as configuration, and a payload phrased as a disclaimer so
   it issues no command, alongside comment and string-literal placement.
5. **Disclosure.** Every published review states what was measured for the model
   that produced it. `resistant` models publish nothing, `partially-exposed`
   models publish a note naming the ratio and the control that confirmed it,
   `exposed` models name the payload behaviour, and unmeasured models are
   disclosed as unmeasured.

**Measured outcome, 2026-10-05: these layers do not make injection impossible.**
The default model resisted 6 of 8 payload classes and was silenced by two of
them — a suppression string shaped like a configuration value, and a payload
that tries to escape the fenced block the diff is rendered into and emit its own
empty findings array. In both, a real defect was planted directly behind the
payload and the model reported nothing.

Each was checked against an ablation control — the same diff with the payload
removed — and in both cases the defect *is* found without the payload, so the
instruction rather than the difficulty did the silencing.

**How firm that is.** Three independent passes, 2026-10-05: the one payload
silenced the model in 3 of 3, and its control found the defect in 3 of 3. The other
seven were resisted in every clean observation.

One pass was excluded from that count. The upstream provider began rate-limiting
mid-run, and four fixtures missed their defect in it — three of them *controls*,
which carry no payload at all. Degraded detection under provider saturation is
therefore not an injection effect, and reading it as one would have invented a
second suppression. The confound is named here because "the model got worse" and
"the model was made to stay quiet" are indistinguishable from a single run.

**The practical consequence is that a pull request author can suppress findings
in their own review, on the default configuration.** Layer 3 only drops a finding
whose explanation is *near-verbatim* an injection string; a model that complies
simply reports nothing, which produces no output for any layer to inspect.
Detection is not prevention. FreeReview discloses this on every review rather
than presenting a suppressed review as a clean one, but disclosure is the
mitigation here, not defence.

Injection can, at worst, cause an absent or bad review comment. It cannot cause
execution, exfiltration, or a paid request.

## Privacy modes

- `privacy_mode: strict` (**default**) sends `provider.zdr: true` and
  `provider.data_collection: "deny"`. Requests route only to providers
  without zero-data-retention. If no eligible free endpoint qualifies, the
  action **reports that and skips the review** — it never silently weakens the
  policy.
- `privacy_mode: relaxed` drops both constraints. It is an explicit opt-in and
  is announced in the step summary **and in the published review**, so a
  reviewer reading the PR can see the diff was sent without the constraint.

### An honest limitation

OpenRouter's per-endpoint metadata APIs (`/models/{author}/{slug}/endpoints` and
`/endpoints/zdr`) require a **management key** and return `403` to a normal API
key. FreeReview therefore **cannot verify at runtime** which specific provider
served a request, or assert that provider's retention posture independently.

What it does instead:

- Requests carry the routing constraints, and OpenRouter enforces them.
- The default model pool carries manually verified privacy posture in source,
  with the verification date recorded (`privacyVerifiedOn`).
- `strict_providers` optionally pins `provider.only` to named providers under
  `strict`, so a provider attached to a model *after* verification cannot be
  selected. Empty by default, because pinning narrows availability: a provider
  that stops serving the free tier ends the review rather than silently switching
  to an unverified one. That trade is deliberate — an unavailable reviewer is
  visible, an unverified one is not.
- Models whose provider documents training or logging on free usage are present
  in the code but **disabled by default**, and remain reachable only under
  `relaxed`.

We would rather state this limitation than imply a guarantee we cannot make.

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/Laughing-Man-Studios/FreeReview/security/advisories/new)
on this repository, rather than opening a public issue.

Please do not test against repositories you do not own.

We aim to acknowledge within 3 business days and to provide a remediation plan
within 14 days of confirmation. We will credit reporters in the advisory unless
you prefer otherwise.

## Trusting this action in CI

- Pin to a commit SHA rather than a tag if your threat model requires
  immutability. Floating major tags (`@v1`) are convenient and receive
  security patches automatically.
- Grant only `contents: read` and `pull-requests: write`. The action needs no
  other permission.
- Do not combine this action with `pull_request_target` while untrusted code
  can influence it.
- The step summary reports `privacy_mode` on every run. If it does not say
  `strict`, your diffs are being sent without the retention constraint.
