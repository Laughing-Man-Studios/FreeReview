/**
 * Conservative token estimation.
 *
 * A line count is not a context-window proxy, and getting this wrong has two
 * failure modes that matter:
 *
 * - **Under-estimating** produces a 400 `context_length_exceeded` from
 *   OpenRouter, which wastes a request against a 50/day budget.
 * - **Over-estimating** splits a diff into more chunks than necessary, so a
 *   reviewable PR gets skipped as "too large" when it would have fitted.
 *
 * So the estimator is deliberately biased high. No tokenizer dependency is
 * used: a real tokenizer for each of a dozen free models would be a large
 * runtime dependency for an action whose whole premise is zero dependencies,
 * and the bundled artifact must stay self-contained.
 *
 * The estimate is only used for two decisions — whether to skip a PR for size,
 * and how to pack chunks. Both tolerate being conservative. Neither needs to
 * be exact.
 */

import type { Config } from "../config.js";

/**
 * Characters per token.
 *
 * Deliberately below the ~4.0 typical for English prose, because source code is
 * denser in punctuation and identifiers, and because guessing low is the safe
 * direction. Calibrated against the free models' published behaviour; revisit
 * if a model in the default pool starts reporting `context_length_exceeded` on
 * chunks the estimator said would fit.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.2;

/**
 * Headroom multiplier applied on top of the raw estimate.
 *
 * Absorbs the difference between a character-ratio guess and whatever
 * tokenizer the provider actually uses. 1.25 leaves roughly 20% margin.
 */
export const DEFAULT_SAFETY_MULTIPLIER = 1.25;

/**
 * Fixed per-request overhead, in tokens.
 *
 * The system prompt, the JSON schema, the instruction wrapper, and the reply
 * envelope are paid on every request regardless of chunk size. Chunks must
 * reserve this, or a chunk packed to exactly the budget will overflow once the
 * scaffolding is added.
 *
 * Kept as a single tunable constant rather than computed from the real prompt
 * so that changing the prompt cannot silently invalidate chunk packing. A test
 * asserts the real scaffolding stays under it.
 */
export const REQUEST_OVERHEAD_TOKENS = 900;

/**
 * Per-chunk rendering scaffold, in tokens.
 *
 * The chunker counts hunk headers and line bodies, but the rendered message also
 * contains an untrusted-data banner, the fence markers, the `File: path` headers
 * for each file in the chunk, and the closing instruction. Those are all
 * *additions* to what the chunker measured, so they must be reserved or the
 * packed chunk can render larger than the budget it was packed for.
 *
 * Sized for the default `maxFilesPerChunk` of 5: roughly 80 tokens of banner and
 * instructions, plus ~15 per file header. A test asserts the real rendered
 * message stays within this reserve.
 */
export const PER_CHUNK_SCAFFOLD_TOKENS = 400;

/**
 * Floor on the usable content budget, in tokens.
 *
 * If `maxInputTokens` is small enough that the overhead and scaffold reserves
 * would consume all of it, the content budget is clamped here rather than going
 * to zero. A tiny configuration therefore still permits a small review instead
 * of silently emitting zero chunks.
 *
 * The clamp can only be reached by calling the estimator directly (the eval
 * harness, tests) — the `max_input_tokens` input has a floor of 2000, which
 * leaves 700 tokens of content.
 */
export const MIN_CHUNK_BUDGET_TOKENS = 200;

/** The validated floor for the `max_input_tokens` action input. */
export const CONFIG_INPUT_TOKEN_FLOOR = 2_000;

export interface TokenEstimator {
  /** Estimate the tokens in a block of text. */
  text(value: string): number;
  /** Estimate the tokens in a block of lines, including newline separators. */
  lines(values: readonly string[]): number;
  /**
   * The largest input a single request may contain for chunk *contents*.
   * Already reduced by the request overhead and the per-chunk render scaffold.
   */
  budgetForChunk(): number;
  readonly charsPerToken: number;
  readonly safetyMultiplier: number;
  /** Tokens reserved for the system prompt, schema, and reply envelope. */
  readonly requestOverhead: number;
  /** Tokens reserved for the rendered chunk's own banner and file headers. */
  readonly chunkScaffold: number;
}

export function createTokenEstimator(
  options: {
    maxInputTokens: number;
    charsPerToken?: number;
    safetyMultiplier?: number;
    overheadTokens?: number;
    scaffoldTokens?: number;
  } = { maxInputTokens: 24_000 },
): TokenEstimator {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const safetyMultiplier = options.safetyMultiplier ?? DEFAULT_SAFETY_MULTIPLIER;
  const overhead = options.overheadTokens ?? REQUEST_OVERHEAD_TOKENS;
  const scaffold = options.scaffoldTokens ?? PER_CHUNK_SCAFFOLD_TOKENS;

  // The effective budget is what remains for diff content once both the request
  // scaffolding and the per-chunk render scaffold are paid. Clamped at a sane
  // minimum so a misconfigured `max_input_tokens` cannot produce a negative or
  // zero budget that would make chunking fail in a confusing way.
  const budget = Math.max(MIN_CHUNK_BUDGET_TOKENS, options.maxInputTokens - overhead - scaffold);

  const text = (value: string): number => {
    if (value.length === 0) return 0;
    const raw = Math.ceil(value.length / charsPerToken);
    return Math.ceil(raw * safetyMultiplier);
  };

  return {
    text,
    lines: (values) => text(values.join("\n")),
    budgetForChunk: () => budget,
    charsPerToken,
    safetyMultiplier,
    requestOverhead: overhead,
    chunkScaffold: scaffold,
  };
}

export function estimatorFromConfig(config: Config): TokenEstimator {
  return createTokenEstimator({
    maxInputTokens: config.maxInputTokens,
    charsPerToken: config.charsPerToken,
    safetyMultiplier: config.tokenSafetyMultiplier,
  });
}

/**
 * Rough rendered cost of a hunk header, in tokens.
 *
 * Small but not zero: `@@ -12,7 +14,9 @@ someSectionHeading() {` is real text
 * the model reads, and a diff with many hunks accumulates a meaningful amount of
 * header. Ignoring it would systematically under-count.
 */
export function estimateHunkHeaderTokens(header: string, estimator: TokenEstimator): number {
  return estimator.text(header);
}
