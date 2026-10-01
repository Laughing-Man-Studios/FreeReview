# Second-opinion review of Stage A ground truth

> **Status: complete, and superseded in part.** The review below was run on 14
> fixtures on 2026-09-30 and found **8 of 14 flawed**; all 8 were corrected in
> `62f59b7`. Counts in this document ("14 fixtures", "held-out split is 4 of 14")
> describe the set *as it was then*, and are left unedited so the record of what
> was reviewed stays accurate.
>
> What changed afterwards, and is recorded in
> [`model-evaluation.md`](model-evaluation.md):
>
> - Stage A is now **17** fixtures. The first baseline run found three more
>   ground-truth errors, and two held-out fixtures were demoted to development
>   because their labels had to be revised after model output on them was seen.
> - **Stage B** (10 held-out fixtures) was authored as separate uncontaminated
>   data, cross-examined in
>   [`second-opinion-stage-b-review.md`](second-opinion-stage-b-review.md) — where
>   **5 of 6 were found flawed**, including one that scored a model obeying
>   injection as compliant.
> - **All held-out data is now spent.** Stage A's four and Stage B's ten have both
>   been scored. Thresholds can no longer be discovered on a clean set, which is
>   why `eval/thresholds.json` was never written.
> - The `duplicate-quote-two-files` question in (e) below is now partly answered:
>   the shipped `dedupe` merges findings at one *location*, and the scorer was
>   changed to apply the action's own dedupe so precision describes what a reader
>   sees. Re-scoring showed the two agreed on every run.

## Why this exists

The Stage A golden dataset is a set of claims about **what the reviewer should
find in a given diff**. I wrote those claims. The anchoring mechanics are
machine-verified — `npm run validate:fixtures` runs every expected quote through
the real resolver and fails on any disagreement with the stated line and side —
but the *semantic* question ("is this actually a defect? should it be critical
or a warning? should this produce no finding at all?") cannot be checked by any
test in the repository.

A wrong label is worse than a missing fixture. It makes the evaluation
confidently report a correct reviewer as broken, and it does so in a way that
looks like evidence.

So this is a deliberate cross-examination by a model that did not write the
labels.

## How to run it

Copy the block below into a different coding harness, with a different model.
Give it repository access. The prompt is self-contained.

Before sending, run this yourself — it costs nothing and no requests:

```bash
npm run validate:fixtures   # mechanical: every quote anchors where we claim
```

That proves placement. It proves nothing about whether the finding *should* be
there.

---

## The prompt

```
You are reviewing the ground truth of a golden dataset for a code-review tool.

BACKGROUND

FreeReview is a GitHub Action that reviews pull requests using free LLM
endpoints. A model proposes findings; deterministic local code decides whether
each finding can be anchored to exactly one verified diff location, and either
publishes it or discards it.

The evaluation harness scores the model by comparing its output against
hand-authored ground truth. So the ground truth IS the measuring instrument.
If a label is wrong, every future measurement is wrong, and it is wrong in a
direction that looks like evidence.

I authored the labels. You did not. Your job is to disagree with me where I am
wrong, not to confirm that I am right. A review that concludes "all 14
fixtures look correct" is a useless outcome — it is indistinguishable from a
lazy one, and I would rather you find three real problems than twenty
polite ones.

REPOSITORY LAYOUT

  eval/lib/fixtures.ts          the fixtures and their ground truth (source of truth)
  eval/lib/render.ts            diff generation; @@ headers are derived, not authored
  eval/validate-fixtures.ts     the mechanical checks
  eval/fixtures/stage-a/<id>/   committed artefacts: pr.diff, head.json, fixture.json
  src/anchor/resolve.ts         the anchor resolver
  src/pipeline/validate.ts      post-parse validation
  src/pipeline/filter.ts        which files are excluded from review

WHAT IS ALREADY MACHINE-VERIFIED — do not spend effort re-checking

  - Every `expectedFindings[].quote` anchors to its stated `line` and `side`.
  - Every generated diff parses with the real strict parser.
  - `@@` header counts are derived from the hunk body, so they cannot be wrong.
  - Committed artefacts match their source module.
  - No fixture forbids a substring of its own expected finding.

So do not check arithmetic. Check JUDGEMENT.

WHAT I WANT YOU TO ATTACK

For each of the 14 fixtures:

1. Is the expected defect REAL? Construct the failing input, state, or timing
   that makes it fail. If you cannot, the label is wrong.
2. Is it caused BY THE DIFF? A defect that exists identically on both sides is
   not a reviewable finding — the reviewer is asked to comment on changed code.
   Check this specifically; it is the error I already made once.
3. Is the severity right? I use: critical = security / data loss / crash /
   severe correctness; warning = credible but not clearly critical; info =
   materially useful and grounded. Would a senior engineer block a merge?
4. Are the `forbiddenFindings` right — is anything there genuinely worth
   reporting? A false negative here inflates my precision score.
5. Is anything MISSING — a second real defect in the same diff that I labelled
   nothing about?
6. Would the expected explanation's `explanationMentions` actually be produced
   by a competent reviewer describing the real failure? These are matched
   case-insensitively, so synonyms matter.

SPECIFIC CALLS I AM LEAST CONFIDENT ABOUT — attack these hardest

a) `renamed-file-with-hunks` (regression split)
   My rationale claims the new `/^.../.test(value)` "throws a TypeError" on a
   non-string, whereas the old `value.includes('@')` "is safe for every input".
   I now think this is BACKWARDS: `RegExp.prototype.test` coerces its argument
   via String(), so it does not throw, whereas `.includes` on a number does
   throw because the method does not exist. If you agree, this fixture's
   rationale is wrong and needs re-authoring — and it is worth saying whether
   the underlying fixture should exist at all.

b) `injection-in-string-literal` (development split)
   The file is a prompt template that deliberately contains text telling a
   reviewer to report no findings. I label this as a correctness fixture
   expecting ZERO findings, on the reasoning that this is what a prompt template
   legitimately contains. Counter-argument: a file shipping an injection payload
   is arguably a real finding. Is my framing honest, or am I grading a model as
   correct for ignoring something it should have flagged?

c) `resource-leak-unclosed-handle` (HELD OUT — please do not be gentle)
   I rewrote this after the resolver rejected the original: the original pointed
   at a descriptor that leaked, but the leak was pre-existing, so the change did
   not cause it. The rewrite makes the diff remove a `try/finally`, so the change
   DOES introduce the leak. Is that now a legitimate finding, or have I just
   reframed the fixture to make it pass? Note this is held-out, so if it is wrong
   the held-out set is contaminated by my error.

d) `insufficient-evidence-no-finding` (HELD OUT)
   The most valuable fixture in the set, because it is the only kind that
   catches a reviewer crying wolf. It forbids reporting that 429-retries are
   correct, that excluding 501 is correct, and that the attempt cap prevents a
   storm. Is a model that reports the hardcoded `501` as a magic number making
   a fair complaint, or is it exactly the false positive I want to suppress?

e) `duplicate-quote-two-files` (development split)
   I expect TWO findings, one per file, for the identical defect in two files.
   The alternative reading is that this is one defect reported once. Which
   produces a better reviewer?

f) `lockfile-plus-small-source-change` (regression split)
   The `filter(Boolean)` change is labelled `warning`: dropping empty entries
   silently shifts positional meaning. Is that material enough to report, or is
   a reasonable reviewer entitled to skip it? If the latter, my warning is a
   false positive I am training the model to avoid.

g) Severities across the set. I have six `critical` and four `warning`. Is that
   distribution defensible for a tool whose entire premise is that findings are
   advisory? A tool that cries wolf at `critical` gets muted.

ALSO WORTH AN OPINION ON

  - `explanationMentions` is matched case-insensitively as substrings. Is that
    too strict (a correct explanation using different vocabulary scores zero) or
    too loose (a keyword-stuffed explanation scores full marks)?
  - Four of fourteen fixtures expect zero findings. Is that the right balance,
    or is the dataset now weighted toward suppression?
  - Is requiring an empty `findings` array the right success condition for a
    zero-finding fixture, given the model might reasonably return prose?
  - The held-out split is 4 of 14. Is that enough to support a claim, given it
    is four fixtures and therefore four binary-ish outcomes?

OUTPUT FORMAT

Start with a one-paragraph verdict: is this dataset sound enough to tune a
prompt against, and what is the single most important thing to fix.

Then, per fixture, only where you disagree:

  <fixture-id>
  VERDICT:      real-and-correct | real-but-severity-wrong | not-caused-by-diff |
                not-a-defect | missing-a-finding | forbidden-wrong | other
  DISAGREE:     one paragraph, specific
  PROPOSED:     the concrete change to the fixture, or "none"

Then a short section: judgement calls you think I got RIGHT, and why. This
matters as much as the disagreements — I need to know which parts are load
bearing before I change anything.

Finally, anything you think I have not considered at all.

CONSTRAINTS

  - Do not rewrite the fixtures. Propose changes; I will make them.
  - Do not comment on TypeScript style, module structure, or the code quality
    of the harness. That is not what is under review.
  - Do not be agreeable. If a fixture is fine, say so once and move on; spend
    your effort on the ones you think are wrong.
  - If you believe a fixture should be DELETED rather than fixed, say so.
```

---

## What I will do with the result

Any disagreement I find convincing becomes a fixture change, and
`npm run eval:generate` re-materialises the artefacts so the drift check stays
honest. Changes will be committed separately from evaluation results, so the
dataset's history shows that ground truth was revised *before* the first
measured run rather than after.

If the second opinion contradicts me on a held-out fixture, I will treat that
fixture as contaminated regardless of who is right, because my having reasoned
about it in advance is itself the contamination.
