/**
 * Validation and dedupe tests.
 *
 * The property under test throughout: **a finding that cannot be substantiated
 * is dropped, not published with a caveat.** A comment attached to real code the
 * model never actually assessed is the failure this project exists to prevent,
 * and it is worse than publishing nothing, because it looks like a real result.
 */

import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { buildIndex } from "../../src/diff/index.js";
import { resolveAnchor } from "../../src/anchor/resolve.js";
import { anchoredText, validateFinding, validateFindings, type Candidate } from "../../src/pipeline/validate.js";
import { anchorKey, dedupe } from "../../src/pipeline/dedupe.js";
import type { AnchoredFinding, RawFinding } from "../../src/types.js";

/**
 * Build a single-hunk diff with a correct `@@` header.
 *
 * The parser rejects a miscounted header outright, so a hand-written one makes
 * these tests fail for the wrong reason. The same reason `render.test.ts` and
 * the injection tests carry their own helpers.
 */
function diff(path: string, ...lines: string[]): string {
  const oldCount = lines.filter((l) => !l.startsWith("+")).length;
  const newCount = lines.filter((l) => !l.startsWith("-")).length;
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...lines,
    "",
  ].join("\n");
}

const PATCH = diff(
  "src/loop.ts",
  " export function total(values: number[]): number {",
  "   let sum = 0;",
  "-  for (const v of values) sum += v;",
  "+  for (let i = 0; i < values.length - 1; i++) sum += values[i];",
  "   return sum;",
  " }",
);

function setup(patch = PATCH) {
  const path = /^diff --git a\/(.+?) b\//m.exec(patch)?.[1] ?? "src/loop.ts";
  const file = parseUnifiedDiff(patch, { path, status: "modified" });
  const index = buildIndex([file]);
  const prFilePaths = new Set([path]);
  return { index, prFilePaths, path };
}

/**
 * A whole added line.
 *
 * Quotes must begin at a line boundary — the resolver matches at line
 * granularity, and a mid-line fragment is not a line. The system prompt says so
 * explicitly; this constant is the same rule made concrete.
 */
const ADDED_LINE = "  for (let i = 0; i < values.length - 1; i++) sum += values[i];";

function candidate(overrides: Partial<RawFinding> = {}, quote = ADDED_LINE): Candidate {
  const { index, prFilePaths, path } = setup();
  return resolve(finding({ ...overrides, path: overrides.path ?? path }, quote), index, prFilePaths);
}

function finding(overrides: Partial<RawFinding> = {}, quote = ADDED_LINE): RawFinding {
  return {
    path: "src/loop.ts",
    buggyCodeQuote: quote,
    explanation: "The loop stops one element early, so the last value is never added to the total.",
    severity: "warning",
    suggestedCode: null,
    ...overrides,
  };
}

/** Run a finding through the real resolver, as the pipeline does. */
function resolve(
  raw: RawFinding,
  index: ReadonlyMap<string, ReturnType<typeof buildIndex> extends Map<string, infer V> ? V : never>,
  prFilePaths: ReadonlySet<string>,
): Candidate {
  const fileIndex = index.get(raw.path.normalize("NFC"));
  if (fileIndex === undefined) throw new Error(`expected an index for ${raw.path}`);

  const resolution = resolveAnchor({
    path: raw.path,
    quote: raw.buggyCodeQuote,
    index: fileIndex,
    prFilePaths,
  });
  if (!resolution.ok) throw new Error(`expected an anchor, got ${resolution.code}`);

  const text = anchoredText(resolution.anchor, index);
  if (text === null) throw new Error("expected anchored text");

  return { finding: raw, anchor: resolution.anchor, anchoredText: text };
}

describe("a well-founded finding", () => {
  it("is accepted", () => {
    const { prFilePaths, index } = setup();
    const result = validateFinding(candidate(), prFilePaths, index);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.anchor.line).toBeGreaterThan(0);
    expect(result.value.anchoredText).toContain("values.length - 1");
  });

  it("keeps the anchored text from the diff, not the model's quote", () => {
    // The diff is the source of truth. The quote is a pointer into it.
    const { prFilePaths, index } = setup();
    const result = validateFinding(candidate(), prFilePaths, index);
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.value.anchoredText).toBe("  for (let i = 0; i < values.length - 1; i++) sum += values[i];");
  });
});

describe("a path outside the pull request is rejected", () => {
  // These bypass the resolver deliberately: they test the *validation* layer, so
  // they hand it a candidate that resolved successfully and then mutated the
  // path. A path override cannot survive resolveAnchor, which is the point.

  it("rejects a file not in the PR", () => {
    const { prFilePaths, index } = setup();
    const base = candidate();
    const result = validateFinding(
      { ...base, finding: { ...base.finding, path: "src/other.ts" } },
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("PATH_NOT_IN_PR");
  });

  it("rejects a traversal-shaped path", () => {
    // Inert in practice — the path is matched, never opened — but the shape
    // should never survive into a published payload.
    const { prFilePaths, index } = setup();
    const base = candidate();
    const result = validateFinding(
      { ...base, finding: { ...base.finding, path: "../../etc/passwd" } },
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(false);
  });

  it("uses the PR's file set, not the index's keys", () => {
    // A filtered-out file is still a real file in the PR. Rejecting it as "not
    // part of this pull request" would be a confusing and wrong message, so the
    // distinction has to come from the *message*, not the code — both cases
    // currently share PATH_NOT_IN_PR.
    const { index } = setup();
    const prFilePaths = new Set(["src/loop.ts", "package-lock.json"]);
    const base = candidate();
    const result = validateFinding(
      { ...base, finding: { ...base.finding, path: "package-lock.json" } },
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not the "not part of this pull request" reason — it *is* in the PR.
    expect(result.rejection.detail).not.toMatch(/not part of this pull request/);
  });

  it("rejects a finding whose path and anchor disagree", () => {
    // The comment would be rendered as being about one file while the quoted
    // code came from another. Nothing else catches this, because the anchor
    // itself resolved perfectly.
    const { prFilePaths, index } = setup();
    const base = candidate();
    const result = validateFinding(
      { ...base, finding: { ...base.finding, path: "src/loop.ts " } },
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.detail).toMatch(/name different files/);
  });
});

describe("an anchor that does not describe the quote is rejected", () => {
  it("rejects an anchor pointing at text the quote does not cover", () => {
    // A rung matched a substring, and the resolved span is somewhere the model
    // never described. Publishing would attach a confident claim to unrelated
    // code.
    const { prFilePaths, index } = setup();
    const base = candidate();
    const result = validateFinding(
      { ...base, finding: { ...base.finding, buggyCodeQuote: "   return sum;" } },
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("ANCHOR_TEXT_MISMATCH");
  });

  it("rejects an anchor that corresponds to no line at all", () => {
    const { prFilePaths, index } = setup();
    const base = candidate();
    const result = validateFinding(
      {
        ...base,
        anchor: { ...base.anchor, line: 9_999, startLine: 9_999 },
      },
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("ANCHOR_TEXT_MISMATCH");
  });
});

describe("a suggestion must fit the span it replaces", () => {
  it("keeps a suggestion on a single-line anchor", () => {
    const { prFilePaths, index } = setup();
    const result = validateFinding(
      candidate({ suggestedCode: "  for (let i = 0; i < values.length; i++) sum += values[i];" }),
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedCode).not.toBeNull();
  });

  it("drops a suggestion that spans more lines than it proposes", () => {
    // GitHub applies a suggestion across the whole anchored range. A one-line
    // replacement for a three-line span deletes the lines in between — code the
    // model never saw.
    const multi = diff(
      "src/multi.ts",
      " export function f() {",
      "+  const a = 1;",
      "+  const b = 2;",
      "+  const c = 3;",
      "+  return a + b + c;",
      " }",
    );
    const { prFilePaths, index, path } = setup(multi);

    const raw = finding(
      {
        path,
        // Three whole lines, so the anchor genuinely spans three.
        buggyCodeQuote: "  const a = 1;\n  const b = 2;\n  const c = 3;",
        explanation: "These constants are computed but the first is never validated before use.",
        suggestedCode: "  const a = validate(1);",
      },
      "  const a = 1;\n  const b = 2;\n  const c = 3;",
    );

    const result = validateFinding(resolve(raw, index, prFilePaths), prFilePaths, index);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("SUGGESTION_SPAN_TOO_SMALL");
  });
});

describe("a thin explanation is rejected", () => {
  it.each(["Looks fine.", "ok", "fine", "Good", "Looks good"])("rejects %o", (explanation) => {
    const { prFilePaths, index } = setup();
    const result = validateFinding(candidate({ explanation }), prFilePaths, index);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("EXPLANATION_TOO_THIN");
  });

  it("accepts a short but specific explanation", () => {
    // The floor guards against degenerate output, not against brevity.
    const { prFilePaths, index } = setup();
    const result = validateFinding(
      candidate({ explanation: "The loop skips the final element, so the total is one short." }),
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(true);
  });

  it("drops a suggestion containing a code fence, keeping the finding", () => {
    // GitHub's suggestion fence is exactly ```suggestion and cannot be grown the
    // way a display fence can, so a backtick run inside the suggestion would
    // terminate the block early and spill the rest into the comment as markdown.
    // The renderer cannot defend itself, so the check lives here — and it drops
    // only the suggestion, because the observation is still real.
    const { prFilePaths, index } = setup();
    const result = validateFinding(
      candidate({ suggestedCode: "  const x = 1; // ``` see docs ```" }),
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedCode).toBeNull();
    // The finding survives, with its explanation intact.
    expect(result.value.explanation).toContain("one element early");
  });

  it("keeps a suggestion containing a single or double backtick", () => {
    // Only a run of three or more can open a fenced block; one or two are
    // ordinary characters in code.
    const { prFilePaths, index } = setup();
    const result = validateFinding(
      candidate({ suggestedCode: "  const x = `a` + `b`;" }),
      prFilePaths,
      index,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedCode).toBe("  const x = `a` + `b`;");
  });
});

describe("batch validation", () => {
  it("separates accepted from rejected", () => {
    const { prFilePaths, index } = setup();
    const good = candidate();
    const bad = { ...good, finding: { ...good.finding, path: "src/other.ts" } };

    const result = validateFindings([good, bad], prFilePaths, index);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejections never carry source text", () => {
    // These records reach the step summary and the published review. The
    // privacy posture rests on untrusted diff content not being echoed back
    // where a reader will attribute it to the reviewer.
    const { prFilePaths, index } = setup();
    const result = validateFindings([candidate({ explanation: "SECRET_SOURCE_TEXT" })], prFilePaths, index);
    const serialised = JSON.stringify(result.rejected);
    expect(serialised).not.toContain("SECRET_SOURCE_TEXT");
  });
});

describe("dedupe", () => {
  function anchored(overrides: Partial<AnchoredFinding> = {}): AnchoredFinding {
    return {
      path: "src/loop.ts",
      explanation: "The loop skips the final element, so the total is one short.",
      severity: "warning",
      suggestedCode: null,
      anchor: { path: "src/loop.ts", line: 3, side: "RIGHT", rung: 0 },
      anchoredText: "  for (let i = 0; i < values.length - 1; i++) sum += values[i];",
      ...overrides,
    };
  }

  it("drops two findings at the same location", () => {
    // Chunks overlap at boundaries, so the same defect can be reported twice.
    // Two comments on one line saying the same thing is noise.
    const result = dedupe([anchored(), anchored()]);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });

  it("keeps the more severe of two duplicates", () => {
    const result = dedupe([anchored({ severity: "info" }), anchored({ severity: "critical" })]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.severity).toBe("critical");
  });

  it("keeps findings at different locations", () => {
    const result = dedupe([anchored(), anchored({ anchor: { path: "src/loop.ts", line: 4, side: "RIGHT", rung: 0 } })]);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toBe(0);
  });

  it("does not merge two genuinely different findings on one line", () => {
    // Same location, materially different explanations: a data-loss risk and a
    // naming concern are both worth saying. Merging loses one silently.
    const result = dedupe([
      anchored({ explanation: "This loop drops the last element, so totals are wrong for every input." }),
      anchored({ explanation: "The accumulator should be a float; integer division loses precision here." }),
    ]);
    expect(result.kept).toHaveLength(2);
  });

  it("does not dedupe on explanation text alone", () => {
    // Identical wording at different lines is two real findings. Only location
    // determines sameness.
    const result = dedupe([
      anchored(),
      anchored({ anchor: { path: "src/loop.ts", line: 9, side: "RIGHT", rung: 0 } }),
    ]);
    expect(result.kept).toHaveLength(2);
  });

  it("keys on the full range, not just the end line", () => {
    // A one-line comment and a multi-line range ending on the same line are
    // different comments.
    const result = dedupe([
      anchored(),
      anchored({
        anchor: { path: "src/loop.ts", line: 3, startLine: 2, side: "RIGHT", rung: 0 },
        explanation: "Something entirely different about the whole statement here instead.",
      }),
    ]);
    expect(result.kept).toHaveLength(2);
  });

  it("produces a stable key for a range", () => {
    expect(
      anchorKey(anchored({ anchor: { path: "a.ts", line: 5, startLine: 3, side: "RIGHT", rung: 0 } })),
    ).toBe("a.ts:RIGHT:3:5");
  });

  it("records the merge so the summary can disclose it", () => {
    const result = dedupe([anchored(), anchored()]);
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]).toMatchObject({ path: "src/loop.ts", line: 3 });
  });

  it("preserves input order for survivors", () => {
    const result = dedupe([
      anchored({ anchor: { path: "a.ts", line: 1, side: "RIGHT", rung: 0 } }),
      anchored({ anchor: { path: "a.ts", line: 1, side: "RIGHT", rung: 0 } }),
      anchored({ anchor: { path: "a.ts", line: 2, side: "RIGHT", rung: 0 } }),
    ]);
    expect(result.kept.map((f) => f.anchor.line)).toEqual([1, 2]);
  });

  it("handles an empty input", () => {
    expect(dedupe([]).kept).toHaveLength(0);
  });
});
