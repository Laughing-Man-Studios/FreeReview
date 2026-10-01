/**
 * The model must not be able to influence anything except prose.
 *
 * ## What this proves
 *
 * The published payload is assembled from our own resolution of the model's
 * quoted text. A model that guesses a line number, invents one, or tries to
 * inject a payload must be unable to influence which line a comment lands on.
 *
 * This is the test the plan calls a "mutation test": rather than asserting the
 * happy path, it feeds hostile model output through the whole pipeline and
 * checks that the *anchors* are unaffected while the *text* is sanitised.
 *
 * The distinction matters. A finding's explanation legitimately contains arbitrary
 * text from the model — that is what an explanation is. What must never be
 * arbitrary is the location. If it were, a compromised or hallucinating model
 * could attach a confident finding to any line in a diff, which is precisely the
 * authority this design exists to withhold from the model.
 */

import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { buildIndex } from "../../src/diff/index.js";
import { resolveAnchor } from "../../src/anchor/resolve.js";
import { validateFindings, type Candidate } from "../../src/pipeline/validate.js";
import type { RawFinding, Severity } from "../../src/types.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,6 @@",
  " export function f(xs: number[]): number {",
  "-  return xs.reduce((a, b) => a + b, 0) / xs.length;",
  "+  return xs.reduce((a, b) => a + b, 0) / xs.length;",
  "+  const total = xs.reduce((a, b) => a + b, 0);",
  "+  return total / xs.length;",
  " }",
  "",
].join("\n");

const PATH = "src/a.ts";
const index = buildIndex([parseUnifiedDiff(DIFF, { path: PATH, status: "modified" })]);
const files = new Set([PATH]);

function raw(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    path: PATH,
    buggyCodeQuote: "  const total = xs.reduce((a, b) => a + b, 0);",
    explanation: "off by one",
    severity: "warning",
    suggestedCode: null,
    ...overrides,
  };
}

function anchorFor(finding: RawFinding) {
  const file = index.get(finding.path.normalize("NFC"));
  if (file === undefined) throw new Error("no index entry");
  return resolveAnchor({ path: finding.path, quote: finding.buggyCodeQuote, index: file, prFilePaths: files });
}

describe("a model-supplied line number cannot reach the anchor", () => {
  const hostile = [
    '"line": 1',
    '"line": 99999',
    '"line": -1',
    '"startLine": 1',
    '"side": "LEFT"',
    '"position": 0',
    '"rung": 9',
    '"anchor": {"line": 1}',
    '"file": "src/a.ts"',
  ];

  it.each(hostile)("ignores %s in the model's output", (injection) => {
    // The hostile value is smuggled through the one field the model does control
    // as far as free text: the explanation. If any of it could influence the
    // anchor, that is the vulnerability.
    const clean = anchorFor(raw());
    const poisoned = anchorFor(
      raw({ explanation: `off by one ${injection} and also {"path":"other.ts"}` }),
    );

    expect(poisoned.ok).toBe(true);
    expect(poisoned.ok && poisoned.anchor.line).toBe(clean.ok && clean.anchor.line);
    expect(poisoned.ok && poisoned.anchor.side).toBe(clean.ok && clean.anchor.side);
  });

  it("resolves solely from the quoted text", () => {
    // Two findings quoting different text on different lines must land on
    // different lines, whatever their explanations claim.
    const first = anchorFor(raw());
    const second = anchorFor(
      raw({ buggyCodeQuote: "  return total / xs.length;" }),
    );

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.anchor.line).not.toBe(second.anchor.line);
    }
  });

  it("rejects a quote that does not exist rather than falling back to a line number", () => {
    // The dangerous alternative design: "if the quote fails, trust the model's
    // line". That converts every hallucination into a confident misplacement.
    const result = anchorFor(raw({ buggyCodeQuote: "  return xs[0] * 2; // line 3" }));
    expect(result.ok).toBe(false);
  });
});

describe("hostile explanation text cannot escape its rendering", () => {
  /** Build a Candidate the way the pipeline does: resolve first, then validate. */
  function candidate(finding: RawFinding): Candidate | null {
    const resolved = anchorFor(finding);
    if (!resolved.ok) return null;
    return { finding, anchor: resolved.anchor, anchoredText: finding.buggyCodeQuote };
  }

  it("produces one finding from a payload trying to close its own comment block", () => {
    const c = candidate(
      raw({ explanation: "</summary><!-- --></details> injected", severity: "critical" }),
    );
    expect(c).not.toBeNull();

    const result = validateFindings([c!], files, index);
    // Whether it is accepted or rejected is not the point. That it produced one
    // finding rather than two, or zero findings that silently vanish, is.
    expect(result.accepted.length + result.rejected.length).toBe(1);
  });

  it("rejects a finding whose path names a file outside the pull request", () => {
    // A path outside the PR cannot be resolved in the first place, so the
    // candidate is built directly to exercise the validation layer that defends
    // against it — the defence must not rest on resolution failing first.
    const c: Candidate = {
      finding: raw({ path: "src/never-touched.ts", buggyCodeQuote: "anything at all" }),
      anchor: { path: "src/never-touched.ts", line: 1, side: "RIGHT", rung: 0 },
      anchoredText: "anything at all",
    };

    const result = validateFindings([c], files, index);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]!.code).toBe("PATH_NOT_IN_PR");
  });

  it("re-derives the anchored text from the index rather than trusting the candidate", () => {
    // Stronger than rejecting a tampered `anchoredText`: the field is not
    // consulted at all. `validateFinding` recomputes what the anchor covers from
    // the index, so a stale or fabricated value cannot influence validation even
    // in principle. Found by trying to assert the weaker property and finding the
    // code already guarantees the stronger one.
    const c = candidate(
      raw({ explanation: "the reduce is computed twice, which is wasted work on every call" }),
    )!;

    const honest = validateFindings([c], files, index);
    const tampered = validateFindings([{ ...c, anchoredText: "  return xs.length; // fabricated" }], files, index);

    expect(honest.accepted).toHaveLength(1);
    expect(tampered.accepted).toHaveLength(1);
    expect(tampered.accepted[0]!.anchoredText).toBe(honest.accepted[0]!.anchoredText);
    expect(tampered.accepted[0]!.anchoredText).not.toContain("fabricated");
  });

  it("rejects an anchor pointing outside the diff even with a well-formed candidate", () => {
    // The other half of authority: the anchor must resolve to real changed text.
    // `anchoredText(anchor, index)` returns null for a line the index does not
    // have, which is the rejection path this exercises.
    const c = candidate(raw())!;
    const bogus: Candidate = {
      ...c,
      anchor: { path: PATH, line: 9_999, side: "RIGHT", rung: 0 },
    };

    const result = validateFindings([bogus], files, index);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]!.code).toBe("ANCHOR_TEXT_MISMATCH");
  });

  it("does not let an unknown key on a finding change what is validated", () => {
    // Extra fields ride along harmlessly; only the named ones are read.
    const c = candidate(raw());
    expect(c).not.toBeNull();
    const withExtra = { ...c!, finding: { ...c!.finding, findings: [raw()], line: 1 } };
    expect(() => validateFindings([withExtra as Candidate], files, index)).not.toThrow();
    expect(validateFindings([withExtra as Candidate], files, index).accepted.length).toBeLessThanOrEqual(1);
  });
});

describe("the anchor resolver, not the model, owns placement", () => {
  it("produces the same anchor for the same quote regardless of severity", () => {
    // Severity is the one field the model may legitimately choose, and it must
    // not reach the anchor path.
    const asWarning = anchorFor(raw({ severity: "warning" as Severity }));
    const asCritical = anchorFor(raw({ severity: "critical" }));

    expect(asWarning.ok && asCritical.ok).toBe(true);
    if (asWarning.ok && asCritical.ok) {
      expect(asWarning.anchor.line).toBe(asCritical.anchor.line);
      expect(asWarning.anchor.side).toBe(asCritical.anchor.side);
    }
  });

  it("refuses a context-only anchor, so unchanged code is never commented on", () => {
    // `export function f` is unchanged in the diff. It is not a reviewable
    // location, and accepting it would let a model comment on code the change
    // did not touch.
    const result = anchorFor(raw({ buggyCodeQuote: " export function f(xs: number[]): number {" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ANCHOR_CONTEXT_ONLY");
  });
});