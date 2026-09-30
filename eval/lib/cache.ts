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
  /**
   * The fully-built request body, exactly as it will be sent.
   *
   * The key must be derived from the whole request, not from the diff alone.
   * The system prompt is a *separate* message, so a cache keyed on the rendered
   * user message is blind to it: editing the system prompt without bumping
   * `PROMPT_VERSION` would serve the previous prompt's response and report it as
   * the new one. That failure is silent and looks exactly like "my prompt change
   * did nothing", which is the worst possible thing to happen during prompt
   * tuning.
   *
   * Hashing the built body makes the key sound by construction rather than by
   * relying on someone remembering to bump a version string. It also covers
   * everything else that changes a response: the model, the schema, the output
   * budget, and the provider routing block that decides *which endpoint* serves
   * the request.
   */
  readonly body: unknown;
  readonly modelId: string;
  /** Carried in the filename for human legibility, not for correctness. */
  readonly promptVersion: string;
}

/**
 * Deterministic serialisation with recursively sorted keys.
 *
 * `JSON.stringify(value, arrayOfKeys)` does NOT do this. The array form is a
 * *filter*, applied at every nesting level, so passing the top-level key list
 * silently drops every nested key that is not also a top-level key — the system
 * prompt and the diff both disappear, and two different requests hash the same.
 * That was the first implementation, and the test asserting "changing the
 * system prompt changes the key" caught it.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function cacheKeyFor(key: CacheKey): string {
  const digest = createHash("sha256").update(stableStringify(key.body)).digest("hex").slice(0, 32);
  const model = key.modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${key.promptVersion}__${model}__${digest}.json`;
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
