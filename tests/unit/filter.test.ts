import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTER_OPTIONS,
  classifyPath,
  filterFile,
  filterFiles,
  isLockfile,
} from "../../src/pipeline/filter.js";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { createTokenEstimator } from "../../src/pipeline/tokens.js";
import type { DiffFile } from "../../src/types.js";

const estimator = createTokenEstimator({ maxInputTokens: 24_000 });
const est = (text: string) => estimator.text(text);

function file(patch: string, path: string, status: DiffFile["status"] = "modified"): DiffFile {
  return parseUnifiedDiff(patch, { path, status });
}

/** A small, entirely ordinary source change. */
const SOURCE_PATCH = [
  "@@ -1,3 +1,3 @@",
  " function total(items) {",
  "-  let sum = 0;",
  "+  let sum = 0; // accumulate",
  "   return sum;",
].join("\n");

describe("classifyPath", () => {
  it.each([
    ["src/index.ts", "source"],
    ["lib/util/helpers.py", "source"],
    ["README.md", "source"],
    ["dist/bundle.js", "generated"],
    ["build/main.js", "generated"],
    ["packages/app/node_modules/x/index.js", "generated"],
    ["src/vendor/lib.go", "generated"],
    ["public/assets/logo.png", "media"],
    ["docs/diagram.svg", "media"],
    ["assets/app.bin", "media"],
    ["__pycache__/mod.cpython-311.pyc", "media"],
  ] as const)("classifies %s as %s", (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
  });
});

describe("isLockfile", () => {
  it.each([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "go.sum",
    "nested/dir/package-lock.json",
  ])("recognises %s", (path) => {
    expect(isLockfile(path)).toBe(true);
  });

  it.each(["src/package.json", "src/lockfile.ts", "src/ordering.lock.ts", "README.md"])(
    "does not treat %s as a lockfile",
    (path) => {
      expect(isLockfile(path)).toBe(false);
    },
  );
});

describe("filterFile", () => {
  it("includes an ordinary source change", () => {
    const decision = filterFile(file(SOURCE_PATCH, "src/pricing.ts"), est);
    expect(decision.include).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("excludes a file with no hunks as binary", () => {
    const decision = filterFile(file("", "assets/logo.png"), est);
    expect(decision.include).toBe(false);
    expect(decision.reason).toBe("binary");
  });

  it("excludes a media file by extension", () => {
    const decision = filterFile(file(SOURCE_PATCH, "docs/diagram.svg"), est);
    expect(decision.include).toBe(false);
    expect(decision.reason).toBe("media");
  });

  it("excludes generated output", () => {
    const decision = filterFile(file(SOURCE_PATCH, "dist/bundle.js"), est);
    expect(decision.include).toBe(false);
    expect(decision.reason).toBe("generated-path");
  });

  it("excludes a minified file on average line length", () => {
    // One enormous line, as produced by a minifier.
    const huge = "a".repeat(5_000);
    const decision = filterFile(file(`@@ -1,1 +1,1 @@\n-old\n+${huge}`, "app.min.js"), est);
    expect(decision.include).toBe(false);
    expect(decision.reason).toBe("minified");
  });

  it("excludes a lockfile body but keeps ordinary sources", () => {
    const lock = filterFile(file(SOURCE_PATCH, "package-lock.json"), est);
    expect(lock.include).toBe(false);
    expect(lock.reason).toBe("lockfile-body");

    const source = filterFile(file(SOURCE_PATCH, "package.json"), est);
    expect(source.include).toBe(true);
  });

  it("excludes a file above the per-file token ceiling", () => {
    const manyLines = Array.from({ length: 4_000 }, (_, i) => `+line number ${i} with some text`);
    const patch = `@@ -1,0 +1,4000 @@\n${manyLines.join("\n")}`;
    const decision = filterFile(file(patch, "src/huge.ts"), est, {
      ...DEFAULT_FILTER_OPTIONS,
      maxFileTokens: 500,
    });
    expect(decision.include).toBe(false);
    expect(decision.reason).toBe("oversized-file");
  });

  it("reports a truncated diff as a coverage gap, not a filter decision", () => {
    // Simulated by constructing the file directly: the parser never sets
    // `truncated`, it comes from GitHub's patch being cut short.
    const base = file(SOURCE_PATCH, "src/big.ts");
    const truncated: DiffFile = { ...base, truncated: true };
    const decision = filterFile(truncated, est);
    expect(decision.include).toBe(false);
    expect(decision.reason).toBe("truncated-diff");
  });

  it("names the measured line length in the minified reason", () => {
    const huge = "b".repeat(1_000);
    const decision = filterFile(file(`@@ -1,1 +1,1 @@\n-old\n+${huge}`, "app.min.js"), est);
    expect(decision.detail).toMatch(/Average line length \d+ exceeds/);
  });
});

describe("filterFiles", () => {
  it("separates included files from excluded ones with reasons", () => {
    const result = filterFiles(
      [
        file(SOURCE_PATCH, "src/a.ts"),
        file(SOURCE_PATCH, "dist/bundle.js"),
        file("", "assets/logo.png"),
        file(SOURCE_PATCH, "src/c.py"),
      ],
      est,
    );

    expect(result.included.map((f) => f.path)).toEqual(["src/a.ts", "src/c.py"]);
    expect(result.excluded.map((e) => e.path)).toEqual(["dist/bundle.js", "assets/logo.png"]);
    expect(result.excluded.every((e) => e.decision.reason !== undefined)).toBe(true);
  });

  it("reports a dependency change without sending the lockfile body", () => {
    // A dependency bump is one of the most security-relevant changes a PR can
    // make, so the change is surfaced even though the hashes are not reviewed.
    const result = filterFiles([file(SOURCE_PATCH, "package-lock.json")], est);
    expect(result.included).toHaveLength(0);
    expect(result.dependencyChanges).toHaveLength(1);
    expect(result.dependencyChanges[0]).toMatch(/^package-lock\.json: 1 added, 1 deleted/);
    expect(result.dependencyChanges[0]).toMatch(/lockfile body not reviewed/);
  });

  it("reports a lockfile inside a generated directory as a dependency change", () => {
    // The lockfile check runs before the generated-path rule, so a vendored
    // lockfile is still surfaced rather than vanishing into build output.
    const result = filterFiles([file(SOURCE_PATCH, "vendor/package-lock.json")], est);
    expect(result.dependencyChanges).toHaveLength(1);
  });

  it("classifies truncation and oversize as coverage gaps", () => {
    const base = file(SOURCE_PATCH, "src/truncated.ts");
    const result = filterFiles([{ ...base, truncated: true }, base], est);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0]?.reason).toBe("truncated-diff");
  });

  it("does not treat binary or minified skips as coverage gaps", () => {
    // These have no reviewable value at all, so calling them gaps would pad the
    // summary and imply we failed to review something we never intended to.
    const result = filterFiles(
      [file("", "assets/logo.png"), file(`@@ -1,1 +1,1 @@\n-a\n+${"c".repeat(3000)}`, "app.min.js")],
      est,
    );
    expect(result.coverageGaps).toHaveLength(0);
    expect(result.excluded).toHaveLength(2);
  });

  it("returns an empty included list when everything is filtered", () => {
    const result = filterFiles([file("", "a.png"), file(SOURCE_PATCH, "dist/b.js")], est);
    expect(result.included).toHaveLength(0);
  });

  it("handles an empty input", () => {
    const result = filterFiles([], est);
    expect(result.included).toHaveLength(0);
    expect(result.excluded).toHaveLength(0);
    expect(result.dependencyChanges).toHaveLength(0);
  });

  it("is deterministic", () => {
    const inputs = [
      file(SOURCE_PATCH, "src/a.ts"),
      file(SOURCE_PATCH, "dist/b.js"),
      file(SOURCE_PATCH, "package-lock.json"),
    ];
    expect(filterFiles(inputs, est)).toEqual(filterFiles(inputs, est));
  });
});
