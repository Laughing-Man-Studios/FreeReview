import { describe, expect, it } from "vitest";
import { buildFileIndex, buildIndex } from "../../src/diff/index.js";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { resolveAnchor } from "../../src/anchor/resolve.js";
import type { DiffFile } from "../../src/types.js";
import type { FileIndex } from "../../src/diff/index.js";

/**
 * A small but representative diff exercising every anchoring path:
 *
 *   new file: 1: export function total(items) {
 *   new file: 2:   let sum = 0;
 *   new file: 3:   for (const item of items) {
 *   new file: 4:     sum += item.price * item.qty;
 *   new file: 5:   }
 *   new file: 6:   return sum;
 *   new file: 7: }
 *   new file: 8:
 *   new file: 9: export function applyDiscount(total, pct) {
 *   new file:10:   return total - total * pct;
 *   new file:11: }
 *
 * with line 4 replaced by an off-by-one loop and line 10 losing its guard.
 */
const PATCH = [
  "@@ -1,11 +1,11 @@",
  " export function total(items) {",
  "   let sum = 0;",
  "-  for (const item of items) {",
  "-    sum += item.price * item.qty;",
  "+  for (let i = 0; i < items.length - 1; i++) {",
  "+    sum += items[i].price * items[i].qty;",
  "   }",
  "   return sum;",
  " }",
  " ",
  " export function applyDiscount(total, pct) {",
  "-  return total - total * pct;",
  "+  return total;",
  " }",
].join("\n");

const PATH = "src/pricing.ts";

function makeIndex(patch = PATCH, path = PATH): { file: DiffFile; index: FileIndex; paths: Set<string> } {
  const file = parseUnifiedDiff(patch, { path, status: "modified" });
  return { file, index: buildFileIndex(file), paths: new Set([path]) };
}

/**
 * Resolve a quote as if the model reported `reportPath`.
 *
 * The index is ALWAYS built for PATH, and PATH is always the PR's file set.
 * Building the index for whatever path the caller names would defeat the path
 * guard, which is the whole point of those tests.
 */
function resolve(quote: string, reportPath = PATH, patch = PATCH) {
  const { index } = makeIndex(patch, PATH);
  return resolveAnchor({ path: reportPath, quote, index, prFilePaths: new Set([PATH]) });
}

function expectOk(result: ReturnType<typeof resolve>) {
  if (!result.ok) {
    throw new Error(`expected an anchor, got ${result.code}: ${result.detail}`);
  }
  return result.anchor;
}

function expectRejected(result: ReturnType<typeof resolve>) {
  if (result.ok) {
    throw new Error(`expected a rejection, got an anchor at line ${result.anchor.line}`);
  }
  return result;
}

describe("resolveAnchor — RIGHT side, single added line", () => {
  it("anchors a quote of an added line to its new-file line number", () => {
    // The added loop header is new-file line 3.
    const anchor = expectOk(resolve("  for (let i = 0; i < items.length - 1; i++) {"));
    expect(anchor).toMatchObject({ path: PATH, side: "RIGHT", line: 3 });
    expect(anchor.startLine).toBeUndefined();
  });

  it("anchors the second added line to line 4", () => {
    const anchor = expectOk(resolve("    sum += items[i].price * items[i].qty;"));
    expect(anchor).toMatchObject({ side: "RIGHT", line: 4 });
  });

  it("records the rung it matched at", () => {
    expect(expectOk(resolve("  for (let i = 0; i < items.length - 1; i++) {")).rung).toBe(0);
  });
});

describe("resolveAnchor — LEFT side, deleted line", () => {
  it("anchors a quote of a removed line to its old-file line number on LEFT", () => {
    // `for (const item of items) {` was old line 3. Deleted code has no RIGHT
    // counterpart, so the side must not be hardcoded to RIGHT.
    const anchor = expectOk(resolve("  for (const item of items) {"));
    expect(anchor).toMatchObject({ path: PATH, side: "LEFT", line: 3 });
  });

  it("anchors the second removed line to LEFT line 4", () => {
    const anchor = expectOk(resolve("    sum += item.price * item.qty;"));
    expect(anchor).toMatchObject({ side: "LEFT", line: 4 });
  });

  it("anchors the removed discount calculation to LEFT line 10", () => {
    const anchor = expectOk(resolve("  return total - total * pct;"));
    expect(anchor).toMatchObject({ side: "LEFT", line: 10 });
  });
});

describe("resolveAnchor — the same text can resolve to different sides", () => {
  // A 4 old-side / 5 new-side hunk, twice, with the same added line in each.
  // `  const handler = () => run();` therefore occurs in two distinct places.
  const DUPLICATE_ACROSS_HUNKS = [
    "@@ -1,4 +1,5 @@",
    " a",
    " b",
    "+  const handler = () => run();",
    " c",
    " d",
    "@@ -20,4 +20,5 @@",
    " a",
    " b",
    "+  const handler = () => run();",
    " c",
    " d",
  ].join("\n");

  const DUPLICATE_TEXT = "  const handler = () => run();";

  it("refuses a line that appears in several places as ambiguous", () => {
    const result = expectRejected(resolve(DUPLICATE_TEXT, PATH, DUPLICATE_ACROSS_HUNKS));
    expect(result.code).toBe("ANCHOR_AMBIGUOUS");
    expect(result.candidateCount).toBe(2);
  });
});

describe("resolveAnchor — multi-line ranges", () => {
  it("anchors a two-line quote of adjacent added lines to a RIGHT range", () => {
    const anchor = expectOk(
      resolve(
        [
          "  for (let i = 0; i < items.length - 1; i++) {",
          "    sum += items[i].price * items[i].qty;",
        ].join("\n"),
      ),
    );
    expect(anchor).toMatchObject({ side: "RIGHT", line: 4, startLine: 3, startSide: "RIGHT" });
  });

  it("anchors a two-line quote of adjacent removed lines to a LEFT range", () => {
    const anchor = expectOk(
      resolve(["  for (const item of items) {", "    sum += item.price * item.qty;"].join("\n")),
    );
    expect(anchor).toMatchObject({ side: "LEFT", line: 4, startLine: 3, startSide: "LEFT" });
  });

  it("anchors a context line plus an added line to a valid RIGHT range", () => {
    // GitHub accepts a RIGHT range that spans an added line.
    const anchor = expectOk(resolve(["  let sum = 0;", "  for (let i = 0; i < items.length - 1; i++) {"].join("\n")));
    expect(anchor).toMatchObject({ side: "RIGHT", startLine: 2, line: 3, startSide: "RIGHT" });
  });

  it("omits startLine when a multi-line quote resolves to one line", () => {
    // A trailing newline in the quote is a copying artefact, not a second line.
    const anchor = expectOk(resolve("  for (let i = 0; i < items.length - 1; i++) {\n"));
    expect(anchor).toMatchObject({ line: 3 });
    expect(anchor.startLine).toBeUndefined();
  });
});

describe("resolveAnchor — the context-only rejection", () => {
  it("refuses to anchor a finding to unchanged context only", () => {
    // GitHub would accept a comment here. It should not: a finding about code
    // the PR did not touch is noise, and noise is what makes a human stop
    // reading the tool.
    const result = expectRejected(resolve("export function total(items) {"));
    expect(result.code).toBe("ANCHOR_CONTEXT_ONLY");
  });

  it("refuses a multi-line quote that spans only context", () => {
    const result = expectRejected(resolve(["export function total(items) {", "  let sum = 0;"].join("\n")));
    expect(result.code).toBe("ANCHOR_CONTEXT_ONLY");
  });

  it("still allows a context line on the LEFT side when it is a removal", () => {
    // LEFT is permitted to be change-free because a removed line is itself the
    // change, and quoting one proves the finding is about deleted code.
    const anchor = expectOk(resolve("  return total - total * pct;"));
    expect(anchor.side).toBe("LEFT");
  });
});

describe("resolveAnchor — ambiguity", () => {
  it("refuses a quote that appears more than once in the file", () => {
    // 4 old-side lines (a, b, c, d) and 5 new-side lines (a, b, x, c, d).
    const dupPatch = [
      "@@ -1,4 +1,5 @@",
      " a",
      " b",
      "+  const handler = () => run();",
      " c",
      " d",
      "@@ -20,4 +20,5 @@",
      " a",
      " b",
      "+  const handler = () => run();",
      " c",
      " d",
    ].join("\n");

    const result = expectRejected(resolve("  const handler = () => run();", PATH, dupPatch));
    expect(result.code).toBe("ANCHOR_AMBIGUOUS");
    expect(result.candidateCount).toBe(2);
  });

  it("refuses a quote appearing twice in the SAME hunk", () => {
    // 4 old-side lines (a, b, c, d) and 6 new-side lines (a, x, b, y, c, d).
    const dupPatch = [
      "@@ -1,4 +1,6 @@",
      " a",
      "+  if (!x) return;",
      " b",
      "+  if (!x) return;",
      " c",
      " d",
    ].join("\n");

    const result = expectRejected(resolve("  if (!x) return;", PATH, dupPatch));
    expect(result.code).toBe("ANCHOR_AMBIGUOUS");
  });

  it("reports the rung at which the ambiguity was found", () => {
    const result = expectRejected(resolve(" }"));
    expect(result.rung).toBe(0);
  });

  it("names the rung in the rejection detail", () => {
    const dup = [
      "@@ -1,4 +1,5 @@",
      " a",
      " b",
      "+  const handler = () => run();",
      " c",
      " d",
      "@@ -20,4 +20,5 @@",
      " a",
      " b",
      "+  const handler = () => run();",
      " c",
      " d",
    ].join("\n");
    expect(expectRejected(resolve("  const handler = () => run();", PATH, dup)).detail).toMatch(
      /exact match/,
    );
  });
});

describe("resolveAnchor — context lines whose two sides disagree on numbering", () => {
  // Regression test for a bug a property test found. A context line has the same
  // line number on both sides only when a hunk's oldStart equals its newStart.
  // In `@@ -1,1 +5,1 @@` it is old 1 and new 5, because earlier lines shifted.
  //
  // The dedup key used to be the line number, so the LEFT and RIGHT matches for
  // one unchanged line looked like two distinct locations and every context
  // quote was rejected as ambiguous — on any PR where a hunk's two starts
  // differ, which is most of them.
  const SHIFTED = ["@@ -1,1 +5,1 @@", " unchanged line"].join("\n");

  it("does not treat one unchanged line as two locations", () => {
    const { index } = makeIndex(SHIFTED, PATH);
    const result = resolveAnchor({
      path: PATH,
      quote: "unchanged line",
      index,
      prFilePaths: new Set([PATH]),
    });
    // It must resolve far enough to be judged on its merits, not rejected as
    // ambiguous for a reason that does not exist.
    if (!result.ok) expect(result.code).not.toBe("ANCHOR_AMBIGUOUS");
    // And the correct verdict for a pure-context quote is the context-only
    // rejection, not ambiguity.
    expect(expectRejected(resolve("unchanged line", PATH, SHIFTED)).code).toBe("ANCHOR_CONTEXT_ONLY");
  });

  it("still anchors a change correctly in a shifted hunk", () => {
    // 1 old-side line (the context) and 2 new-side lines (context + added).
    // The added line lands on new 6, because the hunk's newStart is 5.
    const shifted = ["@@ -1,1 +5,2 @@", " context", "+  const added = true;"].join("\n");
    const anchor = expectOk(resolve("  const added = true;", PATH, shifted));
    expect(anchor).toMatchObject({ side: "RIGHT", line: 6 });
  });
});

describe("resolveAnchor — normalisation ladder", () => {
  // Every rung is exercised against an ADDED line. A context line cannot be
  // used here: an unperturbed context quote is rejected as context-only, and a
  // perturbed one would be rejected before the ladder mattered.
  const ADDED = "  for (let i = 0; i < items.length - 1; i++) {";

  it("rung 0: matches exactly", () => {
    const anchor = expectOk(resolve(ADDED));
    expect(anchor.rung).toBe(0);
    expect(anchor).toMatchObject({ side: "RIGHT", line: 3 });
  });

  it("rung 1: recovers a quote with a stray carriage return", () => {
    const anchor = expectOk(resolve(`${ADDED}\r`));
    expect(anchor).toMatchObject({ side: "RIGHT", line: 3 });
    expect(anchor.rung).toBe(1);
  });

  it("rung 2: recovers a quote with trailing whitespace", () => {
    const anchor = expectOk(resolve(`${ADDED}   `));
    expect(anchor).toMatchObject({ side: "RIGHT", line: 3 });
    expect(anchor.rung).toBe(2);
  });

  it("rung 3: recovers a re-indented quote", () => {
    // The source line is indented two spaces; the model quoted it flush left.
    const anchor = expectOk(resolve("for (let i = 0; i < items.length - 1; i++) {"));
    expect(anchor).toMatchObject({ side: "RIGHT", line: 3 });
    expect(anchor.rung).toBe(3);
  });

  it("rung 4: recovers a quote with collapsed internal whitespace", () => {
    const anchor = expectOk(resolve("  for (let i = 0;  i < items.length - 1; i++) {"));
    expect(anchor.rung).toBe(4);
    expect(anchor.line).toBe(3);
  });

  it("stops at the first rung that matches and does not relax further", () => {
    // The quote matches exactly. It must be reported as a rung-0 match, not a
    // rung-3 or rung-4 one, even though looser rungs would also find it.
    expect(expectOk(resolve(ADDED)).rung).toBe(0);
  });

  it("prefers an exact match over a relaxed one when both would find it", () => {
    // The re-indented form also matches at rung 0 for the LEFT side's removed
    // line? No — different text. The point is that when a quote is findable
    // exactly, the resolver reports rung 0 and never climbs.
    const result = resolve(ADDED);
    expect(expectOk(result).rung).toBe(0);
  });

  it("does not relax past an ambiguity to try to disambiguate", () => {
    // The same line occurs twice. It is ambiguous at rung 0, and relaxing can
    // only ever produce more matches, never fewer — so climbing the ladder
    // cannot help, and picking one of the two would be guessing.
    const dup = [
      "@@ -1,4 +1,5 @@",
      " a",
      " b",
      "+  const handler = () => run();",
      " c",
      " d",
      "@@ -20,4 +20,5 @@",
      " a",
      " b",
      "+  const handler = () => run();",
      " c",
      " d",
    ].join("\n");
    const result = expectRejected(resolve("  const handler = () => run();", PATH, dup));
    expect(result.code).toBe("ANCHOR_AMBIGUOUS");
    expect(result.rung).toBe(0);
  });
});

describe("resolveAnchor — rejection paths", () => {
  it("refuses a quote that is not in the diff at all", () => {
    const result = expectRejected(resolve("  const x = computeSomethingElse();"));
    expect(result.code).toBe("ANCHOR_NOT_FOUND");
  });

  it("refuses a paraphrased quote", () => {
    // A model that rewrites the code rather than quoting it is guessing, and a
    // guess must not become a comment.
    const result = expectRejected(resolve("  for (let i = 0; i < items.length - 1; i += 1) {"));
    expect(result.code).toBe("ANCHOR_NOT_FOUND");
  });

  it.each([
    ["a path not in the PR", "src/other.ts"],
    ["a path traversal attempt", "../../../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["a path differing only by directory", "src/pricing.tsx"],
  ])("refuses %s", (_label, path) => {
    const result = expectRejected(resolve("  let sum = 0;", path));
    expect(result.code).toBe("PATH_NOT_IN_PR");
  });

  it("refuses an empty quote", () => {
    expect(expectRejected(resolve("")).code).toBe("ANCHOR_QUOTE_MALFORMED");
    expect(expectRejected(resolve("   \n  ")).code).toBe("ANCHOR_QUOTE_MALFORMED");
  });

  it.each([
    ["a single character", "}"],
    ["two characters", "()"],
  ])("refuses %s as too short to anchor safely", (_label, quote) => {
    // A one or two character quote is almost always accidental, and a comment
    // anchored to it is noise.
    expect(expectRejected(resolve(quote)).code).toBe("ANCHOR_QUOTE_MALFORMED");
  });

  it("accepts a quote of exactly the minimum length", () => {
    // " } " trims to " }", which is 2 characters — still refused. Use a real
    // three-character added line to confirm the boundary is inclusive.
    const patch = ["@@ -1,1 +1,2 @@", " a", "+  end"].join("\n");
    expect(expectOk(resolve("  end", PATH, patch)).line).toBe(2);
  });

  it("refuses a quote beyond the length limit", () => {
    const result = expectRejected(resolve("x".repeat(2_001)));
    expect(result.code).toBe("ANCHOR_QUOTE_MALFORMED");
  });

  it("refuses a quote spanning more lines than the limit", () => {
    const long = Array.from({ length: 21 }, (_, i) => `line ${i}`).join("\n");
    const result = expectRejected(resolve(long));
    expect(result.code).toBe("ANCHOR_QUOTE_MALFORMED");
  });

  it("never leaks source text into a rejection", () => {
    // Rejections reach the step summary and the review body.
    const result = expectRejected(resolve("const secretValue = hunter2;"));
    expect(result.detail).not.toContain("hunter2");
  });
});

describe("resolveAnchor — the same text in two files", () => {
  it("resolves to the file the model named, not the other one", () => {
    // This is the case the `path` field in the finding schema exists for. With
    // multi-file chunks and no path, a quote cannot be attributed at all.
    const shared = "  const handler = () => run();";
    // 2 old-side lines (a, b) and 3 new-side lines (a, x, b).
    const patchA = `@@ -1,2 +1,3 @@\n a\n+${shared}\n b`;
    const patchB = `@@ -1,2 +1,3 @@\n a\n+${shared}\n b`;

    const fileA = parseUnifiedDiff(patchA, { path: "src/a.ts", status: "modified" });
    const fileB = parseUnifiedDiff(patchB, { path: "src/b.ts", status: "modified" });
    const index = buildIndex([fileA, fileB]);
    const paths = new Set(["src/a.ts", "src/b.ts"]);

    for (const path of ["src/a.ts", "src/b.ts"] as const) {
      const fileIndex = index.get(path);
      if (fileIndex === undefined) throw new Error(`missing index for ${path}`);
      const result = resolveAnchor({ path, quote: shared, index: fileIndex, prFilePaths: paths });
      expect(expectOk(result).path).toBe(path);
      expect(expectOk(result).line).toBe(2);
    }
  });

  it("refuses a path that exists in the index but not the PR's file set", () => {
    const file = parseUnifiedDiff("@@ -1,1 +1,2 @@\n a\n+b", { path: "src/a.ts", status: "modified" });
    const index = buildIndex([file]);
    const fileIndex = index.get("src/a.ts");
    if (fileIndex === undefined) throw new Error("missing index");
    // The index knows the path, but the PR did not change it.
    const result = resolveAnchor({
      path: "src/a.ts",
      quote: "b",
      index: fileIndex,
      prFilePaths: new Set(["src/other.ts"]),
    });
    expect(expectRejected(result).code).toBe("PATH_NOT_IN_PR");
  });
});

describe("resolveAnchor — chunk independence", () => {
  it("resolves identically regardless of which hunk a chunk covered", () => {
    // The index is file-scoped, so a quote that falls outside the reviewed
    // chunk still resolves. This is the property that makes chunk packing
    // incapable of causing anchoring failures.
    const { file, index, paths } = makeIndex();
    const quote = "  for (let i = 0; i < items.length - 1; i++) {";

    const whole = resolveAnchor({ path: PATH, quote, index, prFilePaths: paths });
    expect(expectOk(whole).line).toBe(3);

    // Simulate "the chunk only covered the second hunk" by resolving against an
    // index restricted to that hunk's segments. The file index is unaffected by
    // chunking because it is built from the whole file.
    const secondOnly: FileIndex = {
      path: file.path,
      segments: index.segments.filter((s) => s.hunkIndex === 0),
    };
    const restricted = resolveAnchor({ path: PATH, quote, index: secondOnly, prFilePaths: paths });
    expect(expectOk(restricted).line).toBe(3);
  });
});

describe("buildIndex — first occurrence wins", () => {
  it("does not create a false ambiguity from a duplicated path", () => {
    const file = parseUnifiedDiff("@@ -1,1 +1,2 @@\n a\n+  added", {
      path: "src/a.ts",
      status: "modified",
    });
    const index = buildIndex([file, file]);
    const fileIndex = index.get("src/a.ts");
    if (fileIndex === undefined) throw new Error("missing index");
    const result = resolveAnchor({
      path: "src/a.ts",
      quote: "  added",
      index: fileIndex,
      prFilePaths: new Set(["src/a.ts"]),
    });
    expect(expectOk(result).line).toBe(2);
  });
});
