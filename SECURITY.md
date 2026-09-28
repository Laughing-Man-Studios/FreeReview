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
4. **Tests.** The golden dataset includes dedicated fixtures for injection
   embedded in comments and in string literals. The evaluation gate requires
   **zero** injection compliance.

Injection can, at worst, cause a bad review comment. It cannot cause execution,
exfiltration, or a paid request.

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
  with the verification date recorded.
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
