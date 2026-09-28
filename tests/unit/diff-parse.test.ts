import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DiffParseError, parseUnifiedDiff } from "../../src/diff/parse.js";
import type { DiffFile, DiffHunk } from "../../src/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function parse(patch: string, overrides: Partial<Parameters<typeof parseUnifiedDiff>[1]> = {}): DiffFile {
  return parseUnifiedDiff(patch, { path: "src/example.ts", status: "modified", ...overrides });
}

/** All line texts of a given kind, across all hunks. */
function textsOf(file: DiffFile, kind: "added" | "removed" | "context"): string[] {
  return file.hunks.flatMap((h: DiffHunk) =>
    h.lines.filter((l) => l.kind === kind).map((l) => l.text),
  );
}

describe("parseUnifiedDiff — the real PR #1 diff", () => {
  // Ground truth: GitHub's own `patch` output for ReviewTest#1, not hand-written.
  const patch = readFileSync(resolve(FIXTURES, "real-pr-1-off-by-one.diff"), "utf8");
  const expected = JSON.parse(
    readFileSync(resolve(FIXTURES, "real-pr-1-off-by-one.json"), "utf8"),
  ) as {
    expectedParse: {
      fileCount: number;
      hunkCount: number;
      header: string;
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      addedLines: string[];
      removedLineCount: number;
      contextLineCount: number;
    };
  };

  const file = parse(patch, { path: "src/orders.ts" });

  it("matches every count GitHub reported", () => {
    const e = expected.expectedParse;
    expect(file.hunks).toHaveLength(e.hunkCount);
    expect(file.hunks[0]?.header).toBe(e.header);
    expect(file.hunks[0]?.oldStart).toBe(e.oldStart);
    expect(file.hunks[0]?.oldLines).toBe(e.oldLines);
    expect(file.hunks[0]?.newStart).toBe(e.newStart);
    expect(file.hunks[0]?.newLines).toBe(e.newLines);
  });

  it("recovers the exact added and removed content", () => {
    const e = expected.expectedParse;
    expect(textsOf(file, "added")).toEqual(e.addedLines);
    expect(textsOf(file, "removed")).toHaveLength(e.removedLineCount);
    expect(textsOf(file, "context")).toHaveLength(e.contextLineCount);
  });

  it("assigns new-file line numbers so the off-by-one lands on line 3", () => {
    // The bug is `items.length - 1`, an added line. In the new file:
    //   1 export function orderTotalCents(...)
    //   2   let total = 0;
    //   3   for (let i = 0; i < items.length - 1; i++) {   <- the defect
    //   4     total += items[i].quantity * ...;
    const added = file.hunks[0]?.lines.filter((l) => l.kind === "added") ?? [];
    expect(added).toHaveLength(2);
    expect(added[0]?.newLine).toBe(3);
    expect(added[0]?.oldLine).toBeNull();
    expect(added[1]?.newLine).toBe(4);
  });

  it("numbers the LEFT side of the removed loop as old line 17", () => {
    // The first 14 lines are all removed (two interfaces plus blank lines),
    // then context lines occupy old 15-16, so the removed loop header is 17.
    const removed = file.hunks[0]?.lines.filter((l) => l.kind === "removed") ?? [];
    const loop = removed.find((l) => l.text.includes("for (const item of items)"));
    expect(loop?.oldLine).toBe(17);
    expect(loop?.newLine).toBeNull();
  });
});

describe("parseUnifiedDiff — basic shapes", () => {
  it("parses a single-line change", () => {
    const file = parse("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
    expect(file.hunks).toHaveLength(1);
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks[0]?.lines.map((l) => l.kind)).toEqual(["context", "removed", "added", "context"]);
  });

  it("treats an omitted count as 1", () => {
    const file = parse("@@ -5 +5 @@\n-old\n+new");
    expect(file.hunks[0]?.oldStart).toBe(5);
    expect(file.hunks[0]?.oldLines).toBe(1);
    expect(file.hunks[0]?.newStart).toBe(5);
    expect(file.hunks[0]?.newLines).toBe(1);
  });

  it("handles a new file (@@ -0,0 +1,3 @@)", () => {
    const file = parse("@@ -0,0 +1,3 @@\n+a\n+b\n+c", { status: "added" });
    expect(file.hunks[0]?.lines.map((l) => l.newLine)).toEqual([1, 2, 3]);
    expect(file.hunks[0]?.lines.every((l) => l.oldLine === null)).toBe(true);
  });

  it("handles a fully deleted file (@@ -1,2 +0,0 @@)", () => {
    const file = parse("@@ -1,2 +0,0 @@\n-a\n-b", { status: "deleted" });
    expect(file.hunks[0]?.lines.map((l) => l.oldLine)).toEqual([1, 2]);
    expect(file.hunks[0]?.lines.every((l) => l.newLine === null)).toBe(true);
  });

  it("handles multiple hunks in one file", () => {
    const file = parse(
      ["@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -10,2 +10,3 @@", " x", "-y", "+Y", "+Z"].join("\n"),
    );
    expect(file.hunks).toHaveLength(2);
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(2);
    // Line numbering restarts from each hunk's declared start.
    expect(file.hunks[1]?.lines[0]?.oldLine).toBe(10);
    expect(file.hunks[1]?.lines[3]?.newLine).toBe(12);
  });

  it("recomputes position as an offset from the first @@ header", () => {
    const file = parse(
      ["@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -9,2 +9,2 @@", " q", "-r", "+R"].join("\n"),
    );
    // Position 1 is the line directly below the first header. The count then
    // continues "through lines of whitespace and additional hunks", which means
    // the second `@@` header line itself occupies position 4 — so the line
    // below it is 5, not 4.
    expect(file.hunks[0]?.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(file.hunks[1]?.lines.map((l) => l.position)).toEqual([5, 6, 7]);
  });

  it("keeps position monotonic across every hunk in the file", () => {
    const file = parse(
      [
        "@@ -1,1 +1,1 @@",
        "-a",
        "+A",
        "@@ -5,1 +5,1 @@",
        "-b",
        "+B",
        "@@ -9,1 +9,1 @@",
        "-c",
        "+C",
      ].join("\n"),
    );
    const positions = file.hunks.flatMap((h) => h.lines.map((l) => l.position));
    expect(positions).toEqual([1, 2, 4, 5, 7, 8]);
    // Strictly increasing, and no value is skipped other than the headers.
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("handles a hunk header with a trailing section heading", () => {
    const file = parse("@@ -1,2 +1,2 @@ function foo() {\n a\n-b\n+B");
    expect(file.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@ function foo() {");
    expect(file.hunks[0]?.lines).toHaveLength(3);
  });

  it("handles an empty context line emitted as a bare empty string", () => {
    // git emits " " for an empty context line; some tools emit "".
    const file = parse("@@ -1,3 +1,3 @@\n a\n\n-b\n+B");
    expect(file.hunks[0]?.lines).toHaveLength(4);
    expect(file.hunks[0]?.lines[1]?.kind).toBe("context");
    expect(file.hunks[0]?.lines[1]?.text).toBe("");
  });

  it("ignores file-level headers before the first hunk", () => {
    const file = parse(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1234567..89abcde 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "+B",
      ].join("\n"),
    );
    expect(file.hunks).toHaveLength(1);
    expect(file.additions).toBe(1);
  });

  it("flags a file with no hunks as binary", () => {
    const file = parse("", { status: "modified" });
    expect(file.hunks).toHaveLength(0);
    expect(file.binary).toBe(true);
  });
});

describe("parseUnifiedDiff — no-newline marker", () => {
  it("consumes \\ No newline at end of file without emitting a line", () => {
    const file = parse("@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B");
    expect(file.hunks[0]?.lines).toHaveLength(3);
    expect(textsOf(file, "added")).toEqual(["B"]);
    expect(textsOf(file, "removed")).toEqual(["b"]);
  });

  it("consumes the marker on the added side too", () => {
    const file = parse("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+A\n\\ No newline at end of file");
    expect(file.hunks[0]?.lines).toHaveLength(2);
  });
});

describe("parseUnifiedDiff — CRLF", () => {
  it("preserves the carriage return in line text for the ladder to handle", () => {
    // git strips CR from diffs it generates, but patches from other tools carry
    // it. The parser must not silently lose the character; rung L1 of the
    // normalisation ladder deals with it.
    const file = parse("@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B");
    expect(textsOf(file, "added")).toEqual(["B"]);
    expect(textsOf(file, "context")[0]).toBe("a\r");
  });
});

describe("parseUnifiedDiff — line numbering invariants", () => {
  it("increments oldLine only for context and removed lines", () => {
    // 5 body lines: a, -b, +B, c, -d  ->  4 old-side lines, 3 new-side lines.
    const file = parse("@@ -10,4 +20,3 @@\n a\n-b\n+B\n c\n-d\n");
    const old = file.hunks[0]?.lines.map((l) => l.oldLine) ?? [];
    expect(old).toEqual([10, 11, null, 12, 13]);
  });

  it("increments newLine only for context and added lines", () => {
    const file = parse("@@ -10,4 +20,3 @@\n a\n-b\n+B\n c\n-d\n");
    const next = file.hunks[0]?.lines.map((l) => l.newLine) ?? [];
    expect(next).toEqual([20, null, 21, 22, null]);
  });

  it("marks every parsed line commentable", () => {
    const file = parse("@@ -1,2 +1,2 @@\n a\n-b\n+B");
    expect(file.hunks[0]?.lines.every((l) => l.isCommentable)).toBe(true);
  });
});

describe("parseUnifiedDiff — rejects malformed patches", () => {
  it("throws when a hunk contains fewer lines than its header declares", () => {
    // This is the truncation case. Publishing a review against a mis-parsed
    // diff would put comments on the wrong lines, so it is a hard failure.
    expect(() => parse("@@ -1,10 +1,10 @@\n a\n-b\n+B")).toThrow(DiffParseError);
  });

  it("throws when a hunk contains more added lines than declared", () => {
    expect(() => parse("@@ -1,1 +1,1 @@\n+B\n+C")).toThrow(DiffParseError);
  });

  it("throws when a hunk contains more removed lines than declared", () => {
    expect(() => parse("@@ -1,1 +1,1 @@\n-b\n-c\n+C")).toThrow(DiffParseError);
  });

  it("throws when a hunk contains more context lines than declared", () => {
    expect(() => parse("@@ -1,1 +1,1 @@\n a\n b\n+C")).toThrow(DiffParseError);
  });

  it("reports the line number of the offending body line", () => {
    try {
      parse("@@ -1,1 +1,1 @@\n+B\n+C");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DiffParseError);
      expect((error as DiffParseError).line).toBe(3);
    }
  });

  it("names the hunk in the truncation message", () => {
    try {
      parse("@@ -3,5 +3,5 @@\n a");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("@@ -3,5 +3,5 @@");
      expect((error as Error).message).toMatch(/truncated or malformed/);
    }
  });
});

describe("parseUnifiedDiff — paths with awkward characters", () => {
  it.each([
    "src/with space.ts",
    "src/with-dash.ts",
    "src/deeply/nested/path/to/file.ts",
    "src/unicode-üñïçødé.ts",
    "a.ts",
  ])("handles the path %s", (path) => {
    const file = parse("@@ -1,1 +1,1 @@\n-a\n+A", { path });
    expect(file.path).toBe(path);
  });

  it("records previousPath for a renamed file", () => {
    const file = parse("@@ -1,1 +1,1 @@\n-a\n+A", {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
    });
    expect(file.previousPath).toBe("src/old.ts");
    expect(file.status).toBe("renamed");
  });
});
