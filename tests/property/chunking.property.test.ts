/**
 * Property: the token budget is a guarantee, not a hope.
 *
 * This is the single most valuable property in the project after the anchoring
 * invariant. It is what protects the 50/day free-model allowance: if a
 * generated chunk can exceed the per-request budget, one enormous pull request
 * can burn the entire day's quota on rejected 400s.
 *
 * The property is stated against *generated* diffs, because the guarantee has to
 * hold for input the action did not author.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildChunks, chunkStats, totalChunkTokens } from "../../src/pipeline/chunk.js";
import { checkChunkBudgets } from "../../src/pipeline/size-gate.js";
import {
  CONFIG_INPUT_TOKEN_FLOOR,
  MIN_CHUNK_BUDGET_TOKENS,
  PER_CHUNK_SCAFFOLD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  createTokenEstimator,
} from "../../src/pipeline/tokens.js";
import { renderChunk } from "../../src/diff/render.js";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import type { DiffFile, LineKind } from "../../src/types.js";

const RUNS = 500;

const kinds = fc.array(fc.constantFrom<LineKind>("context", "added", "removed"), {
  minLength: 1,
  maxLength: 40,
});

const filePath = fc
  .array(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz_.-/".split(""))), { minLength: 3, maxLength: 24 })
  .map((c) => c.join(""))
  .filter((p) => p.includes("/") && !p.startsWith("/") && !p.includes(".."));

/** Build a valid multi-hunk diff. */
function buildFile(path: string, hunkSpecs: readonly (readonly LineKind[])[]): DiffFile {
  const body: string[] = [];
  hunkSpecs.forEach((hunkKinds, index) => {
    const oldCount = hunkKinds.filter((k) => k !== "added").length;
    const newCount = hunkKinds.filter((k) => k !== "removed").length;
    body.push(`@@ -${index * 100 + 1},${oldCount} +${index * 100 + 1},${newCount} @@`);
    hunkKinds.forEach((kind) => {
      const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
      body.push(`${marker}line ${Math.floor(Math.random() * 1e6)}`);
    });
  });
  return parseUnifiedDiff(body.join("\n"), { path, status: "modified" });
}

const aFile = fc
  .tuple(filePath, fc.array(kinds, { minLength: 1, maxLength: 3 }))
  .map(([path, hunkSpecs]) => buildFile(path, hunkSpecs));

const maxInputTokens = fc.constantFrom(2_000, 4_000, 24_000);

describe("property: multi-file packing is quota-efficient", () => {
  it("packs several small files into one chunk", () => {
    // The reason chunks span files: at one request per file, a twenty-file PR
    // would exhaust `max_requests_per_run` of 8 after eight files regardless of
    // how much budget remained.
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 2, maxLength: 5 }), (files) => {
        const estimator = createTokenEstimator({ maxInputTokens: 24_000 });
        const chunks = buildChunks(files, estimator);
        const stats = chunkStats(chunks);

        // Five tiny files must not become five requests.
        expect(stats.chunks).toBeLessThan(files.length);
        expect(stats.files).toBe(files.length);
      }),
      { numRuns: 200 },
    );
  });

  it("never puts more files in a chunk than the cap allows", () => {
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 1, maxLength: 6 }), maxInputTokens, (files, maxIn) => {
        const estimator = createTokenEstimator({ maxInputTokens: maxIn });
        const chunks = buildChunks(files, estimator, { maxFilesPerChunk: 3, keepChunksFileLocal: true });
        for (const chunk of chunks) {
          expect(chunk.files.length).toBeLessThanOrEqual(3);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("reports every file it was given, across however many chunks", () => {
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 1, maxLength: 6 }), maxInputTokens, (files, maxIn) => {
        const estimator = createTokenEstimator({ maxInputTokens: maxIn });
        const chunks = buildChunks(files, estimator);
        const paths = new Set(chunks.flatMap((chunk) => chunk.files.map((f) => f.path)));
        for (const file of files) {
          expect(paths.has(file.path), `${file.path} missing from chunks`).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("property: no packed chunk exceeds the content budget", () => {
  it("every chunk's estimated tokens fit the per-chunk budget", () => {
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 1, maxLength: 4 }), maxInputTokens, (files, maxIn) => {
        const estimator = createTokenEstimator({ maxInputTokens: maxIn });
        const chunks = buildChunks(files, estimator);

        for (const chunk of chunks) {
          expect(
            chunk.estimatedTokens,
            `chunk ${chunk.id} cost ${chunk.estimatedTokens} exceeds budget ${estimator.budgetForChunk()}`,
          ).toBeLessThanOrEqual(estimator.budgetForChunk());
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("the budget already reserves request overhead and render scaffold", () => {
    // For any budget at or above the configuration floor, contents + overhead +
    // scaffold must not exceed the configured maximum, or a packed chunk could
    // overflow the model's context window.
    //
    // Below the floor the estimator clamps the content budget to MIN_BUDGET,
    // deliberately exceeding the configured maximum so that an extremely small
    // configuration still permits a review at all. The two requirements cannot
    // both hold down there; the clamp is the documented resolution.
    fc.assert(
      fc.property(maxInputTokens, (maxIn) => {
        const estimator = createTokenEstimator({ maxInputTokens: maxIn });
        const total = estimator.budgetForChunk() + estimator.requestOverhead + estimator.chunkScaffold;
        if (maxIn >= CONFIG_INPUT_TOKEN_FLOOR) {
          expect(total).toBeLessThanOrEqual(maxIn);
        } else {
          expect(total).toBeGreaterThan(maxIn);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("the configuration floor sits above the combined overhead", () => {
    // Guarantees the clamp is unreachable through configuration, so the budget
    // guarantee holds for every input an operator can actually provide.
    const estimator = createTokenEstimator({ maxInputTokens: CONFIG_INPUT_TOKEN_FLOOR });
    expect(estimator.budgetForChunk()).toBeGreaterThan(MIN_CHUNK_BUDGET_TOKENS);
    expect(estimator.budgetForChunk()).toBe(
      CONFIG_INPUT_TOKEN_FLOOR - REQUEST_OVERHEAD_TOKENS - PER_CHUNK_SCAFFOLD_TOKENS,
    );
  });

  it("a misconfigured budget still yields a positive budget", () => {
    // Unreachable via config now that the floor is 2000, but the estimator is
    // also called from the eval harness and tests, so the clamp stays as a
    // backstop rather than producing a negative budget and zero chunks.
    for (const maxIn of [500, 1_000, 1_300, 1_500]) {
      const estimator = createTokenEstimator({ maxInputTokens: maxIn });
      expect(estimator.budgetForChunk()).toBe(MIN_CHUNK_BUDGET_TOKENS);
    }
  });
});

describe("property: the RENDERED message also fits, not just the packed estimate", () => {
  it("a rendered chunk stays within the request limit", () => {
    // The renderer adds an untrusted-data banner, fence markers, and per-file
    // headers on top of what the chunker measured. If the scaffold reserve is
    // too small, the packed chunk fits but the request that carries it does not.
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 1, maxLength: 3 }), maxInputTokens, (files, maxIn) => {
        const estimator = createTokenEstimator({ maxInputTokens: maxIn });
        const chunks = buildChunks(files, estimator);

        const renderedTokens = chunks.map((chunk) =>
          renderChunk(
            chunk,
            {
              owner: "acme",
              repo: "widgets",
              pullNumber: 42,
              headSha: "a".repeat(40),
              fileCount: files.length,
            },
            (text) => estimator.text(text),
          ).estimatedTokens,
        );

        const limit = estimator.budgetForChunk() + estimator.chunkScaffold;
        for (const [index, tokens] of renderedTokens.entries()) {
          expect(
            tokens,
            `rendered chunk ${index + 1} cost ${tokens} exceeds ${limit}`,
          ).toBeLessThanOrEqual(limit);
        }

        // And the runtime guard agrees, so a request is never sent and rejected.
        expect(checkChunkBudgets(renderedTokens, estimator).ok).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("property: chunking preserves the diff", () => {
  it("every diff line appears in exactly one chunk", () => {
    // Chunking may split a hunk, but it must never drop or duplicate content.
    // A dropped line is code nobody reviews; a duplicated line invites duplicate
    // findings.
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 1, maxLength: 3 }), maxInputTokens, (files, maxIn) => {
        const estimator = createTokenEstimator({ maxInputTokens: maxIn });
        const chunks = buildChunks(files, estimator);

        for (const file of files) {
          const expected = file.hunks.flatMap((h) => h.lines);
          const actual = chunks
            .flatMap((chunk) => chunk.fragments)
            .filter((fragment) => fragment.filePath === file.path)
            .flatMap((fragment) => fragment.lines);

          expect(actual, `line count changed for ${file.path}`).toHaveLength(expected.length);
          expect(actual.map((l) => `${l.kind}:${l.oldLine}:${l.newLine}`)).toEqual(
            expected.map((l) => `${l.kind}:${l.oldLine}:${l.newLine}`),
          );
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a file small enough to fit is never split", () => {
    fc.assert(
      fc.property(aFile, (file) => {
        const estimator = createTokenEstimator({ maxInputTokens: 24_000 });
        const chunks = buildChunks([file], estimator);
        const stats = chunkStats(chunks);
        // With a 24k budget, a 40-line hunk cannot need splitting.
        expect(stats.splitHunks).toBe(0);
        expect(stats.files).toBe(1);
      }),
      { numRuns: 200 },
    );
  });
});

describe("property: chunk accounting is additive", () => {
  it("total chunk tokens equals the sum of individual chunks", () => {
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 1, maxLength: 4 }), (files) => {
        const estimator = createTokenEstimator({ maxInputTokens: 4_000 });
        const chunks = buildChunks(files, estimator);
        const sum = chunks.reduce((total, chunk) => total + chunk.estimatedTokens, 0);
        expect(totalChunkTokens(chunks)).toBe(sum);
      }),
      { numRuns: 200 },
    );
  });

  it("chunk ids are unique and sequential", () => {
    fc.assert(
      fc.property(fc.array(aFile, { minLength: 1, maxLength: 4 }), (files) => {
        const estimator = createTokenEstimator({ maxInputTokens: 1_000 });
        const chunks = buildChunks(files, estimator);
        const ids = chunks.map((chunk) => chunk.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(chunks.map((_, index) => `chunk-${index + 1}`));
      }),
      { numRuns: 200 },
    );
  });
});

describe("overhead constants are internally consistent", () => {
  it("the default reserves leave a workable budget", () => {
    const estimator = createTokenEstimator({ maxInputTokens: 24_000 });
    expect(estimator.requestOverhead).toBe(REQUEST_OVERHEAD_TOKENS);
    expect(estimator.chunkScaffold).toBe(PER_CHUNK_SCAFFOLD_TOKENS);
    expect(estimator.budgetForChunk()).toBe(
      24_000 - REQUEST_OVERHEAD_TOKENS - PER_CHUNK_SCAFFOLD_TOKENS,
    );
  });

  it("the estimator is monotonic in text length", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 4_000 }), (text) => {
        const estimator = createTokenEstimator({ maxInputTokens: 24_000 });
        expect(estimator.text(text + "x")).toBeGreaterThanOrEqual(estimator.text(text));
      }),
      { numRuns: 200 },
    );
  });

  it("empty text costs nothing and short text costs less than long text", () => {
    const estimator = createTokenEstimator({ maxInputTokens: 24_000 });
    expect(estimator.text("")).toBe(0);
    expect(estimator.text("a".repeat(100))).toBeLessThan(estimator.text("a".repeat(10_000)));
  });
});
