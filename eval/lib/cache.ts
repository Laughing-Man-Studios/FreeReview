/**
 * Content-addressed response cache for evaluation runs.
 *
 * ## Why
 *
 * A prompt iteration re-runs the same fixtures against the same diffs. With
 * `temperature: 0` and a fixed seed, a response is a *function* of the request —
 * so replaying an identical request is not an approximation, it is the same
 * answer. Caching therefore attacks cost directly rather than raising a ceiling.
 *
 * It also removes a source of noise: a free model served by a shared provider is
 * not perfectly deterministic, so two runs of the "same" request can differ.
 * Without a cache, a scoring change looks like a model change.
 *
 * ## The key
 *
 * `(promptVersion, modelId, chunkHash)`. The chunk hash is over the exact
 * rendered user message, so a change anywhere in the prompt, the diff, or the
 * rendering produces a different key. `promptVersion` is belt-and-braces: it is
 * already implied by the rendered text, but a human reading a cache directory
 * needs to see which prompt produced an entry.
 *
 * ## When to bypass
 *
 * When a provider-side change makes a fresh response genuinely informative — a
 * model was re-served by a different endpoint, or a fixed bug landed upstream.
 * `--no-cache` forces it, and a run that does so records that fact, because
 * "the model improved" and "the provider changed" are different conclusions.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheKey {
  readonly promptVersion: string;
  readonly modelId: string;
  readonly renderedUserMessage: string;
}

export function cacheKeyFor(key: CacheKey): string {
  const chunk = createHash("sha256").update(key.renderedUserMessage).digest("hex").slice(0, 32);
  const model = key.modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${key.promptVersion}__${model}__${chunk}.json`;
}

export interface CacheEntry {
  readonly content: string;
  /** Usage as reported, for cost reporting even on a hit. */
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly finishReason?: string | null;
  /** When this entry was written, so a stale cache is visible. */
  readonly cachedAt: string;
}

export interface ResponseCache {
  get(key: CacheKey): CacheEntry | null;
  set(key: CacheKey, entry: Omit<CacheEntry, "cachedAt">): void;
  readonly stats: { hits: number; misses: number; writes: number };
}

export function createCache(options: { dir: string; enabled: boolean }): ResponseCache {
  const stats = { hits: 0, misses: 0, writes: 0 };

  if (options.enabled) mkdirSync(options.dir, { recursive: true });

  return {
    stats,
    get(key) {
      if (!options.enabled) {
        stats.misses += 1;
        return null;
      }
      const path = join(options.dir, cacheKeyFor(key));
      if (!existsSync(path)) {
        stats.misses += 1;
        return null;
      }
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
        stats.hits += 1;
        return parsed;
      } catch {
        // A corrupt entry must not stop a run. Treat it as a miss and overwrite.
        stats.misses += 1;
        return null;
      }
    },
    set(key, entry) {
      if (!options.enabled) return;
      const record: CacheEntry = { ...entry, cachedAt: new Date().toISOString() };
      writeFileSync(join(options.dir, cacheKeyFor(key)), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      stats.writes += 1;
    },
  };
}
