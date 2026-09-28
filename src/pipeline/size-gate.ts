/**
 * Size and context gates.
 *
 * Two independent thresholds, because they catch different failures:
 *
 * - `MAX_CHANGED_LINES` rejects an obviously oversized PR before any inference,
 *   which is the cheap decision. It is a coarse guard whose only job is to avoid
 *   spending quota on a PR that could never produce a useful review.
 * - `MAX_INPUT_TOKENS` is enforced per request by the chunker, and is the
 *   guarantee that matters.
 *
 * A PR that fails the coarse gate is skipped with a clear reason. It is never a
 * failure, because "this PR is too big to review automatically" is a statement
 * about the tool, not a judgement about the code.
 */

import type { Diagnostic } from "../diagnostics.js";
import type { ReviewChunk } from "./chunk.js";
import type { TokenEstimator } from "./tokens.js";

export interface SizeGateInput {
  readonly totalChangedLines: number;
  readonly maxChangedLines: number;
  readonly filesConsidered: number;
}

export type SizeGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

export function checkChangedLines(input: SizeGateInput): SizeGateResult {
  if (input.totalChangedLines <= input.maxChangedLines) return { ok: true };

  return {
    ok: false,
    diagnostic: {
      code: "PR_TOO_LARGE",
      severity: "expected",
      message:
        `This pull request changes ${input.totalChangedLines} lines, which exceeds the ` +
        `configured limit of ${input.maxChangedLines}. No AI review was performed.`,
      context: {
        changed_lines: input.totalChangedLines,
        limit: input.maxChangedLines,
        files: input.filesConsidered,
      },
    },
  };
}

/**
 * Verify that every chunk fits the request budget.
 *
 * This is a runtime assertion rather than a test-only check. It uses the
 * *rendered* cost, not the packed estimate, because the renderer adds the
 * banner, fence, and file headers on top. If the two ever disagree, the request
 * is dropped rather than sent and rejected by OpenRouter with a 400 — a wasted
 * request against a 50/day allowance.
 */
export function checkChunkBudgets(
  chunkRenderedTokens: readonly number[],
  estimator: TokenEstimator,
): SizeGateResult {
  const limit = estimator.budgetForChunk() + estimator.chunkScaffold;

  for (const [index, tokens] of chunkRenderedTokens.entries()) {
    if (tokens > limit) {
      return {
        ok: false,
        diagnostic: {
          code: "CONTEXT_TOO_LARGE",
          severity: "expected",
          message:
            `Chunk ${index + 1} rendered to approximately ${tokens} tokens, over the ` +
            `per-request limit of ${limit}. It was not sent. This indicates the token ` +
            "estimator and the renderer disagree, which is a bug rather than a PR problem.",
          context: { chunk: index + 1, estimated: tokens, limit },
        },
      };
    }
  }

  return { ok: true };
}

/**
 * Decide whether the request budget allows reviewing the chunks at all.
 *
 * One request per chunk is the design: the plan deliberately avoids a separate
 * analysis call and a separate formatting call, because that would double
 * consumption of a 50/day allowance. When the chunk count exceeds what is left in
 * the run budget, the review proceeds with as many chunks as fit, in file order,
 * and says so — rather than silently reviewing an arbitrary subset with no
 * indication that anything was dropped.
 */
export function selectAffordableChunks(
  chunks: readonly ReviewChunk[],
  remainingRequests: number,
): { selected: ReviewChunk[]; dropped: number } {
  if (remainingRequests <= 0) return { selected: [], dropped: chunks.length };
  if (chunks.length <= remainingRequests) return { selected: [...chunks], dropped: 0 };
  return { selected: chunks.slice(0, remainingRequests), dropped: chunks.length - remainingRequests };
}
