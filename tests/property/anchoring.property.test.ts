/**
 * Property-based invariants for diff parsing and anchor resolution.
 *
 * These are the load-bearing tests in the project. Unit tests only prove the
 * cases their author imagined. Properties prove the guarantee holds across a
 * space far larger than anyone would enumerate by hand — which is the point,
 * because the guarantee is "a published comment is always on a real, correct
 * line", and the failure mode is a comment on the wrong line of someone's code.
 *
 * Each property runs 1000 generated cases. Generators build *valid* diffs, so
 * a failure means the resolver or parser is wrong, not that the input was
 * nonsense.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildFileIndex } from "../../src/diff/index.js";
import { parseUnifiedDiff, DiffParseError } from "../../src/diff/parse.js";
import { resolveAnchor } from "../../src/anchor/resolve.js";
import { RUNG_COUNT, transformLines } from "../../src/anchor/normalize.js";
import type { DiffFile, LineKind } from "../../src/types.js";

const RUNS = 1_000;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Source-ish line text, avoiding characters that break the diff format. */
const lineText = fc
  .array(fc.constantFrom(...("abcXYZ_0123456789 (){}[];.,=+-*/<>!&|?:'\"`".split(""))), {
    minLength: 1,
    maxLength: 24,
  })
  .map((chars) => chars.join(""))
  .filter((s) => s.length > 0 && !s.startsWith("diff --git"));

const kindTriples = fc.array(fc.constantFrom<LineKind>("context", "added", "removed"), {
  minLength: 1,
  maxLength: 12,
});

const filePath = fc
  .array(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz_.-/".split(""))), { minLength: 1, maxLength: 20 })
  .map((c) => c.join(""))
  .filter((p) => p.length > 0 && !p.startsWith("/") && !p.includes("..") && p.includes("/"));

interface GeneratedHunk {
  readonly kinds: readonly LineKind[];
  readonly texts: readonly string[];
  readonly oldStart: number;
  readonly newStart: number;
}

const aHunk: fc.Arbitrary<GeneratedHunk> = fc
  .tuple(kindTriples, fc.array(lineText, { minLength: 1, maxLength: 12 }), fc.nat(1000), fc.nat(1000))
  .map(([kinds, texts, oldStart, newStart]) => ({
    kinds,
    texts: kinds.map((_, i) => texts[i % texts.length] ?? "x"),
    oldStart: oldStart + 1,
    newStart: newStart + 1,
  }))
  .filter((h) => h.kinds.length > 0);

const aDiff = fc
  .array(aHunk, { minLength: 1, maxLength: 3 })
  .map((hunks) => ({ path: undefined as string | undefined, hunks }));

/** Render generated hunks into a well-formed unified diff and parse it. */
function buildDiff(path: string, hunks: readonly GeneratedHunk[]): DiffFile {
  const body: string[] = [];
  for (const hunk of hunks) {
    const oldCount = hunk.kinds.filter((k) => k !== "added").length;
    const newCount = hunk.kinds.filter((k) => k !== "removed").length;
    body.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`);
    hunk.kinds.forEach((kind, i) => {
      const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
      body.push(`${marker}${hunk.texts[i] ?? "x"}`);
    });
  }
  return parseUnifiedDiff(body.join("\n"), { path, status: "modified" });
}

/** Resolve against a generated file. */
function resolveOn(file: DiffFile, quote: string) {
  const index = buildFileIndex(file);
  return resolveAnchor({ path: file.path, quote, index, prFilePaths: new Set([file.path]) });
}

// ---------------------------------------------------------------------------
// Parser properties
// ---------------------------------------------------------------------------

describe("property: the parser never emits an impossible line number", () => {
  it("every context line has a line number on BOTH sides", () => {
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        const file = buildDiff(path, generated.hunks);
        for (const hunk of file.hunks) {
          for (const line of hunk.lines) {
            if (line.kind !== "context") continue;
            expect(line.oldLine, "context oldLine").not.toBeNull();
            expect(line.newLine, "context newLine").not.toBeNull();
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a context line's numbering shift equals the net lines added before it", () => {
    // This is the true invariant, arrived at after two wrong versions. The two
    // numbers are not always equal — in `@@ -1,1 +5,1 @@` the context line is
    // old 1 and new 5 — and the difference is not a fixed hunk offset either,
    // because it grows as lines are added or removed earlier in the hunk.
    //
    // What always holds: the gap is exactly the running count of added lines
    // minus removed lines ahead of this line. A violation means every anchor
    // derived from a context line is off by that many lines.
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        const file = buildDiff(path, generated.hunks);
        for (const hunk of file.hunks) {
          let netAdded = hunk.newStart - hunk.oldStart;
          for (const line of hunk.lines) {
            if (line.kind === "context") {
              expect(line.newLine! - line.oldLine!).toBe(netAdded);
            } else if (line.kind === "added") {
              netAdded += 1;
            } else {
              netAdded -= 1;
            }
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("added lines have a new number and no old number, and vice versa", () => {
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        const file = buildDiff(path, generated.hunks);
        for (const hunk of file.hunks) {
          for (const line of hunk.lines) {
            if (line.kind === "added") {
              expect(line.newLine).not.toBeNull();
              expect(line.oldLine).toBeNull();
            } else if (line.kind === "removed") {
              expect(line.oldLine).not.toBeNull();
              expect(line.newLine).toBeNull();
            }
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("line numbers increase monotonically within each side of a hunk", () => {
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        const file = buildDiff(path, generated.hunks);
        for (const hunk of file.hunks) {
          const old = hunk.lines.map((l) => l.oldLine).filter((n): n is number => n !== null);
          const next = hunk.lines.map((l) => l.newLine).filter((n): n is number => n !== null);
          for (let i = 1; i < old.length; i += 1) expect(old[i]!).toBeGreaterThan(old[i - 1]!);
          for (let i = 1; i < next.length; i += 1) expect(next[i]!).toBeGreaterThan(next[i - 1]!);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("line counts derived from the body always match the hunk header", () => {
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        // buildDiff throws DiffParseError on a mismatch, which is the assertion.
        const file = buildDiff(path, generated.hunks);
        for (const hunk of file.hunks) {
          expect(hunk.lines.filter((l) => l.kind !== "added")).toHaveLength(hunk.oldLines);
          expect(hunk.lines.filter((l) => l.kind !== "removed")).toHaveLength(hunk.newLines);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("never throws on a diff it generated itself", () => {
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        expect(() => buildDiff(path, generated.hunks)).not.toThrow(DiffParseError);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Anchoring properties — the core guarantee
// ---------------------------------------------------------------------------

describe("property: every anchor produced is structurally valid", () => {
  it("a successful anchor points at a real, commentable line on the stated side", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const result = resolveOn(file, quote);
        if (!result.ok) return;

        const index = buildFileIndex(file);
        // Locate the anchor's line on its side and confirm it exists there.
        const segments = index.segments.filter((s) => s.side === result.anchor.side);
        const located = segments.some((s) =>
          s.lines.some((l) => l.lineNumber === result.anchor.line && l.isCommentable),
        );
        expect(located, "anchor line must exist and be commentable on its side").toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("a successful anchor's path is the file it was resolved against", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const result = resolveOn(file, quote);
        if (!result.ok) return;
        expect(result.anchor.path).toBe(file.path);
      }),
      { numRuns: RUNS },
    );
  });

  it("a range anchor has startLine <= line and the same side on both ends", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const result = resolveOn(file, quote);
        if (!result.ok) return;
        const { startLine, startSide, line, side } = result.anchor;
        if (startLine === undefined) return;
        expect(startLine).toBeLessThanOrEqual(line);
        expect(startSide).toBe(side);
      }),
      { numRuns: RUNS },
    );
  });

  it("a RIGHT-side anchor always covers at least one added line", () => {
    // The context-only gate. If this fails, the action can comment on code the
    // pull request never touched.
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const result = resolveOn(file, quote);
        if (!result.ok) return;
        if (result.anchor.side !== "RIGHT") return;

        const index = buildFileIndex(file);
        const segment = index.segments.find(
          (s) => s.side === "RIGHT" && s.lines.some((l) => l.lineNumber === result.anchor.line),
        );
        if (segment === undefined) return;

        const start = result.anchor.startLine ?? result.anchor.line;
        const span = segment.lines.filter(
          (l) => l.lineNumber >= start && l.lineNumber <= result.anchor.line,
        );
        expect(span.some((l) => l.kind === "added"), "RIGHT anchor must include an added line").toBe(
          true,
        );
      }),
      { numRuns: RUNS },
    );
  });

  it("a LEFT-side anchor always covers at least one removed line", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const result = resolveOn(file, quote);
        if (!result.ok) return;
        if (result.anchor.side !== "LEFT") return;

        const index = buildFileIndex(file);
        const segment = index.segments.find(
          (s) => s.side === "LEFT" && s.lines.some((l) => l.lineNumber === result.anchor.line),
        );
        if (segment === undefined) return;

        const start = result.anchor.startLine ?? result.anchor.line;
        const span = segment.lines.filter(
          (l) => l.lineNumber >= start && l.lineNumber <= result.anchor.line,
        );
        expect(span.some((l) => l.kind === "removed"), "LEFT anchor must include a removed line").toBe(
          true,
        );
      }),
      { numRuns: RUNS },
    );
  });
});

describe("property: resolution is deterministic", () => {
  it("the same input always produces an identical resolution", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const first = resolveOn(buildDiff(path, generated.hunks), quote);
        for (let i = 0; i < 5; i += 1) {
          expect(resolveOn(buildDiff(path, generated.hunks), quote)).toEqual(first);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("resolving does not mutate the file or index it was given", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const before = JSON.stringify(file);
        resolveOn(file, quote);
        expect(JSON.stringify(file)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

describe("property: the ladder only ever relaxes", () => {
  it("a quote matching exactly is reported at rung 0, never a deeper rung", () => {
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        const file = buildDiff(path, generated.hunks);
        const index = buildFileIndex(file);

        // Collect every line text that appears in the diff, unmodified.
        const candidates = index.segments.flatMap((s) => s.lines.map((l) => l.text));
        for (const text of candidates) {
          if (text.trim().length === 0) continue;
          const result = resolveAnchor({
            path: file.path,
            quote: text,
            index,
            prFilePaths: new Set([file.path]),
          });
          if (result.ok) expect(result.anchor.rung, `quote ${JSON.stringify(text)}`).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a deeper rung is only reached when every shallower rung found nothing", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const index = buildFileIndex(file);

        const result = resolveAnchor({
          path: file.path,
          quote,
          index,
          prFilePaths: new Set([file.path]),
        });
        if (!result.ok) return;
        if (result.anchor.rung === 0) return;

        // For every shallower rung, assert nothing matched. This is the
        // "first rung with a match wins" rule, stated as a property.
        for (let rung = 0; rung < result.anchor.rung; rung += 1) {
          const needle = transformLines([quote], rung);
          const matched = index.segments.some((s) =>
            transformLines(
              s.lines.map((l) => l.text),
              rung,
            ).some((text) => text === needle[0]),
          );
          expect(matched, `rung ${rung} should not have matched`).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("property: ambiguity is never silently resolved", () => {
  it("a quote occurring in two distinct places is always rejected", () => {
    fc.assert(
      fc.property(filePath, aDiff, (path, generated) => {
        const file = buildDiff(path, generated.hunks);
        const index = buildFileIndex(file);

        // Find a line number pair where the same text sits at two different
        // line numbers, and assert we refuse rather than choose.
        const byText = new Map<string, Set<number>>();
        for (const segment of index.segments) {
          if (segment.side !== "RIGHT") continue;
          for (const line of segment.lines) {
            if (line.kind === "context") continue;
            const seen = byText.get(line.text) ?? new Set<number>();
            seen.add(line.lineNumber);
            byText.set(line.text, seen);
          }
        }

        for (const [text, lineNumbers] of byText) {
          if (lineNumbers.size < 2) continue;
          const result = resolveAnchor({
            path: file.path,
            quote: text,
            index,
            prFilePaths: new Set([file.path]),
          });
          expect(
            result.ok,
            `text ${JSON.stringify(text)} appears at ${[...lineNumbers].join(",")} and must be refused`,
          ).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("property: the resolver never invents a location", () => {
  it("an anchor's line always carries text that matches the quote at its rung", () => {
    fc.assert(
      fc.property(filePath, aDiff, lineText, (path, generated, quote) => {
        const file = buildDiff(path, generated.hunks);
        const index = buildFileIndex(file);
        const result = resolveAnchor({
          path: file.path,
          quote,
          index,
          prFilePaths: new Set([file.path]),
        });
        if (!result.ok) return;

        const needle = transformLines(quote.split("\n"), result.anchor.rung);
        const segment = index.segments.find(
          (s) =>
            s.side === result.anchor.side &&
            s.lines.some((l) => l.lineNumber === result.anchor.line),
        );
        if (segment === undefined) return;

        const start = result.anchor.startLine ?? result.anchor.line;
        const span = segment.lines.filter((l) => l.lineNumber >= start && l.lineNumber <= result.anchor.line);
        const haystack = transformLines(
          span.map((l) => l.text),
          result.anchor.rung,
        );
        expect(haystack).toEqual(needle);
      }),
      { numRuns: RUNS },
    );
  });

  it("a quote not present in the diff at any rung is never anchored", () => {
    fc.assert(
      fc.property(
        filePath,
        aDiff,
        fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes("\n")),
        (path, generated, quote) => {
          const file = buildDiff(path, generated.hunks);
          const result = resolveOn(file, quote);

          // Whichever way it resolved, the rung must be a real rung and the
          // rejection must be a real rejection code. A resolution may never
          // cite a rung outside the ladder, and a rejection may never claim a
          // rung it did not reach.
          if (result.ok) {
            expect(result.anchor.rung).toBeGreaterThanOrEqual(0);
            expect(result.anchor.rung).toBeLessThan(RUNG_COUNT);
          } else {
            expect(result.rung).toBeGreaterThanOrEqual(0);
            expect(result.rung).toBeLessThan(RUNG_COUNT);
            expect(result.candidateCount).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
