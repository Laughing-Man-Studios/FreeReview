/**
 * Token-budgeted chunk packing.
 *
 * One hard guarantee, and the property test in `tests/property` that proves it:
 *
 *   **No chunk's estimated cost can exceed the per-request budget.**
 *
 * That guarantee is what protects the 50/day free-model allowance from a single
 * enormous pull request. It has to hold for input the action did not author,
 * which is why it is tested against generated diffs rather than hand-written
 * ones.
 *
 * ## Packing rules, in priority order
 *
 * 1. **Hunks are never split across chunks unless a single hunk alone exceeds
 *    the budget.** A hunk is the unit GitHub itself uses to describe a change;
 *    splitting one arbitrarily produces chunks whose contents misrepresent the
 *    diff, and prompts the model to comment on a fragment.
 * 2. **When a hunk must be split, it is split at line boundaries** and the
 *    pieces are marked as continuing parts, so the model is not told that a
 *    fragment is a complete change.
 * 3. **Hunks are packed in file order**, so a chunk's contents are spatially
 *    coherent and easier for a small model to reason about.
 * 4. **A single file's hunks stay in one chunk where possible.** Reviewing a
 *    file's changes together is worth more than the marginal packing
 *    efficiency, and it keeps a finding's surrounding context local.
 *
 * ## Why chunking can never break anchoring
 *
 * Anchoring resolves against the file-level index built in `diff/index.ts`, not
 * against a chunk. Splitting a hunk therefore has no effect on whether a
 * finding can be located. This is the property that lets rule 1 be relaxed when
 * a hunk is genuinely too large.
 */

import type { DiffFile, DiffHunk, DiffLine } from "../types.js";
import { estimateHunkHeaderTokens, type TokenEstimator } from "./tokens.js";

export interface ChunkFragment {
  /** File this fragment belongs to. Carried so the renderer can label it. */
  readonly filePath: string;
  /** The hunk this came from, and its range within the file. */
  readonly hunkIndex: number;
  readonly header: string;
  /** 1-based fragment number within the hunk. */
  readonly fragment: number;
  /** Total fragments this hunk was split into. */
  readonly fragmentCount: number;
  readonly lines: readonly DiffLine[];
}

export interface ReviewChunk {
  readonly id: string;
  readonly files: readonly DiffFile[];
  readonly fragments: readonly ChunkFragment[];
  /** Estimated tokens for the rendered diff content, excluding request overhead. */
  readonly estimatedTokens: number;
}

export interface ChunkOptions {
  /** Maximum files in one chunk. Bounds how scattered a chunk can be. */
  maxFilesPerChunk: number;
  /**
   * When true, stop at the first file that does not fit rather than carrying it
   * to a new chunk alongside later files. Keeps a chunk focused on one file.
   */
  keepChunksFileLocal: boolean;
}

/**
 * Cost of a fragment: its hunk header plus its line contents, including the
 * leading marker character each line will carry in the rendered prompt.
 */
function fragmentTokens(fragment: ChunkFragment, estimator: TokenEstimator): number {
  const header = estimateHunkHeaderTokens(fragment.header, estimator);
  // +1 per line for the '+'/'-'/' ' marker, which the renderer emits.
  const markers = fragment.lines.length;
  return header + estimator.lines(fragment.lines.map((line) => line.text)) + markers;
}

/**
 * Split one hunk into fragments that each fit `budget`.
 *
 * Returns the whole hunk as a single fragment when it fits. When it does not,
 * the hunk is cut at line boundaries and each piece is labelled, so the prompt
 * can tell the model it is looking at part of a change.
 *
 * A single line too large to fit alone is emitted on its own rather than
 * dropped. Dropping it would mean silently not reviewing a line; emitting it
 * overshoots the budget, which the caller's property test would catch. Neither
 * is acceptable, so it is emitted and the caller can decide — in practice the
 * renderer's per-line truncation keeps such a line bounded.
 */
function splitHunk(
  file: DiffFile,
  hunk: DiffHunk,
  hunkIndex: number,
  budget: number,
  estimator: TokenEstimator,
): ChunkFragment[] {
  const single: ChunkFragment = {
    filePath: file.path,
    hunkIndex,
    header: hunk.header,
    fragment: 1,
    fragmentCount: 1,
    lines: hunk.lines,
  };

  if (fragmentTokens(single, estimator) <= budget) return [single];

  // Greedy fill: keep adding lines while the running cost stays within budget.
  const pieces: DiffLine[][] = [];
  let current: DiffLine[] = [];
  let currentCost = estimateHunkHeaderTokens(hunk.header, estimator);

  for (const line of hunk.lines) {
    const lineCost = estimator.text(line.text) + 1; // +1 for the marker
    if (current.length > 0 && currentCost + lineCost > budget) {
      pieces.push(current);
      current = [];
      currentCost = estimateHunkHeaderTokens(hunk.header, estimator);
    }
    current.push(line);
    currentCost += lineCost;
  }
  if (current.length > 0) pieces.push(current);

  const total = pieces.length;
  return pieces.map((lines, index) => ({
    filePath: file.path,
    hunkIndex,
    header: hunk.header,
    fragment: index + 1,
    fragmentCount: total,
    lines,
  }));
}

/**
 * Pack filtered files into chunks that each fit the per-request budget.
 *
 * ## Why chunks span multiple files
 *
 * Packing one file per chunk is simpler and keeps a chunk focused, but it is
 * request-hungry, and requests are the scarce resource: at the default
 * `max_requests_per_run` of 8, a twenty-file pull request would be truncated
 * after eight files whether or not the budget allowed more. Against a 50/day
 * allowance, spending a whole request on a three-line change is the difference
 * between reviewing ~25 pull requests a day and reviewing ~6.
 *
 * So fragments from several files share a chunk, bounded by
 * `maxFilesPerChunk` to keep any single chunk coherent. Each file's header is
 * rendered above its hunks, and the finding schema requires `path`, so a
 * multi-file chunk remains unambiguous — which is the whole reason `path` is in
 * the schema at all.
 *
 * A file's hunks stay contiguous within a chunk wherever the budget allows, so
 * a finding's surrounding context is usually local.
 */
export function buildChunks(
  files: readonly DiffFile[],
  estimator: TokenEstimator,
  options: ChunkOptions = { maxFilesPerChunk: 5, keepChunksFileLocal: true },
): ReviewChunk[] {
  const budget = estimator.budgetForChunk();
  if (budget <= 0) return [];

  // Flatten every file's hunks into fragments, in file order, so a chunk's
  // contents are spatially coherent.
  const pending: { file: DiffFile; fragment: ChunkFragment }[] = [];
  for (const file of files) {
    file.hunks.forEach((hunk, hunkIndex) => {
      for (const fragment of splitHunk(file, hunk, hunkIndex, budget, estimator)) {
        pending.push({ file, fragment });
      }
    });
  }

  const chunks: ReviewChunk[] = [];
  let currentFragments: ChunkFragment[] = [];
  let currentFiles: DiffFile[] = [];
  let currentCost = 0;

  const flush = (): void => {
    if (currentFragments.length === 0) return;
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      files: currentFiles,
      fragments: currentFragments,
      estimatedTokens: currentCost,
    });
    currentFragments = [];
    currentFiles = [];
    currentCost = 0;
  };

  for (const { file, fragment } of pending) {
    const cost = fragmentTokens(fragment, estimator);
    const alreadyInChunk = currentFiles.some((f) => f.path === file.path);
    const wouldExceedFileCap = !alreadyInChunk && currentFiles.length >= options.maxFilesPerChunk;

    if (currentFragments.length > 0 && (currentCost + cost > budget || wouldExceedFileCap)) {
      flush();
    }

    if (!currentFiles.some((f) => f.path === file.path)) currentFiles.push(file);
    currentFragments.push(fragment);
    currentCost += cost;
  }

  flush();

  return chunks;
}

/** Total estimated tokens across all chunks. */
export function totalChunkTokens(chunks: readonly ReviewChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.estimatedTokens, 0);
}

/**
 * Hunk and file counts, for the step summary.
 *
 * Splitting is surfaced rather than hidden, because a split hunk means the model
 * saw a partial change and any finding on it should be read with that in mind.
 */
export function chunkStats(chunks: readonly ReviewChunk[]): {
  chunks: number;
  splitHunks: number;
  files: number;
  maxChunkTokens: number;
} {
  const seen = new Set<string>();
  const splitHunks = new Set<string>();
  let maxChunkTokens = 0;

  for (const chunk of chunks) {
    maxChunkTokens = Math.max(maxChunkTokens, chunk.estimatedTokens);
    for (const file of chunk.files) seen.add(file.path);
    for (const fragment of chunk.fragments) {
      if (fragment.fragmentCount > 1) splitHunks.add(`${fragment.header}#${fragment.hunkIndex}`);
    }
  }

  return { chunks: chunks.length, splitHunks: splitHunks.size, files: seen.size, maxChunkTokens };
}
