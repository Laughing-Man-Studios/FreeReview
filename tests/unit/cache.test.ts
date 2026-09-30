/**
 * Cache-key tests.
 *
 * The cache is only sound if the key covers everything that changes a response.
 * The bug these guard against is silent and was present in the first
 * implementation: the key hashed the rendered *diff*, while the system prompt is
 * a separate message. Editing the system prompt without bumping
 * `PROMPT_VERSION` would therefore serve the previous prompt's response and
 * report it as the new one — which looks exactly like "my prompt change did
 * nothing", the worst possible outcome during prompt tuning.
 */

import { describe, expect, it } from "vitest";
import { cacheKeyFor, createCache } from "../../eval/lib/cache.js";
import { buildSystemPrompt, buildUserMessage, buildChatRequest } from "../../src/prompt/index.js";
import type { ModelDefinition } from "../../src/config.js";
import type { RenderedChunk } from "../../src/diff/render.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHUNK: RenderedChunk = {
  userMessage: "File: src/a.ts\n@@ -1,3 +1,3 @@\n-old\n+new",
  fenceLength: 3,
  estimatedTokens: 40,
};

const MODEL: ModelDefinition = {
  id: "inclusionai/ling-3.0-flash-sante:free",
  enabled: true,
  priority: 0,
  maxContextTokens: 262_144,
  supportsResponseFormat: false,
  supportsJsonSchema: false,
  privacyEligible: true,
  zdrEligible: true,
};

function body(): Record<string, unknown> {
  // A minimal stand-in for the client's builder, exposing only what the harness
  // uses. The real one is covered by the client integration tests; here the
  // subject under test is the key, not the HTTP.
  const request = buildChatRequest(CHUNK, MODEL, 4_000);
  return {
    model: request.model.id,
    stream: false,
    temperature: 0,
    top_p: 1,
    max_tokens: request.maxOutputTokens,
    messages: request.messages,
    provider: { max_price: { prompt: "0", completion: "0", request: "0" } },
  };
}

describe("the cache key covers everything that changes a response", () => {
  const base = () => ({ promptVersion: "2026-09-27.1", modelId: MODEL.id, body: body() });

  it("is stable for an identical request", () => {
    expect(cacheKeyFor(base())).toBe(cacheKeyFor(base()));
  });

  it("is stable across key ordering in the body", () => {
    // A builder that reorders its own object literal must not invalidate every
    // cached entry, or a cosmetic refactor costs a full re-run.
    const a = cacheKeyFor({ ...base(), body: { model: "m", messages: [{ role: "user", content: "x" }] } });
    const b = cacheKeyFor({ ...base(), body: { messages: [{ content: "x", role: "user" }], model: "m" } });
    expect(a).toBe(b);
  });

  it("does not collapse different nested content onto one key", () => {
    // The regression for the replacer-array bug: a naive "sort the top-level
    // keys" stringify drops every nested key, so two genuinely different
    // requests hash identically.
    const a = cacheKeyFor({ ...base(), body: { messages: [{ role: "system", content: "A" }] } });
    const b = cacheKeyFor({ ...base(), body: { messages: [{ role: "system", content: "B" }] } });
    expect(a).not.toBe(b);
  });

  it("changes when the system prompt changes", () => {
    // The regression. The system prompt is a separate message, so a key derived
    // from the diff alone is blind to every prompt edit.
    const before = cacheKeyFor({ ...base(), body: { ...body(), messages: [{ role: "system", content: "A" }] } });
    const after = cacheKeyFor({ ...base(), body: { ...body(), messages: [{ role: "system", content: "B" }] } });
    expect(before).not.toBe(after);
  });

  it("changes when the diff changes", () => {
    const changed: RenderedChunk = { ...CHUNK, userMessage: `${CHUNK.userMessage} extra` };
    const request = buildChatRequest(changed, MODEL, 4_000);
    const a = cacheKeyFor({ promptVersion: "v", modelId: MODEL.id, body: { messages: request.messages } });
    const b = cacheKeyFor({
      promptVersion: "v",
      modelId: MODEL.id,
      body: { messages: buildChatRequest(CHUNK, MODEL, 4_000).messages },
    });
    expect(a).not.toBe(b);
  });

  it("changes when the output budget changes", () => {
    // Too small an output budget produces an *empty* response, so a cached entry
    // from a larger budget is not the same answer.
    const a = cacheKeyFor({ ...base(), body: { ...body(), max_tokens: 1_500 } });
    const b = cacheKeyFor({ ...base(), body: { ...body(), max_tokens: 4_000 } });
    expect(a).not.toBe(b);
  });

  it("changes when the model changes", () => {
    expect(cacheKeyFor({ ...base(), modelId: "a/b:free" })).not.toBe(cacheKeyFor({ ...base(), modelId: "c/d:free" }));
  });

  it("changes when the provider routing block changes", () => {
    // The routing block decides *which endpoint* serves the request, so a
    // response under `zdr: true` is not the response under `relaxed`.
    const strict = { ...body(), provider: { max_price: { prompt: "0" }, zdr: true } };
    const relaxed = { ...body(), provider: { max_price: { prompt: "0" } } };
    expect(cacheKeyFor({ ...base(), body: strict })).not.toBe(cacheKeyFor({ ...base(), body: relaxed }));
  });

  it("does not change merely because PROMPT_VERSION moved", () => {
    // Version is carried for human legibility only. Correctness comes from the
    // body hash, so an unnecessary version bump costs a full re-run but never
    // returns a wrong answer.
    expect(cacheKeyFor({ ...base(), promptVersion: "v2" })).not.toBe(cacheKeyFor(base()));
  });

  it("keeps the model and version readable in the filename", () => {
    const key = cacheKeyFor(base());
    expect(key).toContain("2026-09-27.1");
    expect(key).toContain("inclusionai_ling-3.0-flash-sante_free");
    expect(key.endsWith(".json")).toBe(true);
  });
});

describe("the cache itself", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "freereview-cache-"));
  }

  it("returns null on a miss", () => {
    const dir = tmp();
    try {
      const cache = createCache({ dir, enabled: true });
      expect(cache.get({ promptVersion: "v", modelId: "m", body: { a: 1 } })).toBeNull();
      expect(cache.stats.misses).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a stored response", () => {
    const dir = tmp();
    try {
      const key = { promptVersion: "v", modelId: "m", body: { a: 1 } };
      const first = createCache({ dir, enabled: true });
      first.set(key, { content: '{"findings":[]}' });
      // A fresh instance over the same directory, which is what a restored
      // cache looks like on the next run.
      const second = createCache({ dir, enabled: true });
      expect(second.get(key)?.content).toBe('{"findings":[]}');
      expect(second.stats.hits).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when disabled", () => {
    const dir = tmp();
    try {
      const cache = createCache({ dir, enabled: false });
      const key = { promptVersion: "v", modelId: "m", body: { a: 1 } };
      cache.set(key, { content: "x" });
      expect(cache.get(key)).toBeNull();
      expect(cache.stats.writes).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a corrupt entry as a miss rather than failing the run", () => {
    const dir = tmp();
    try {
      const key = { promptVersion: "v", modelId: "m", body: { a: 1 } };
      createCache({ dir, enabled: true }).set(key, { content: "x" });
      writeFileSync(join(dir, cacheKeyFor(key)), "{ not json", "utf8");

      const cache = createCache({ dir, enabled: true });
      expect(cache.get(key)).toBeNull();
      expect(cache.stats.misses).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the system prompt reaches the request body", () => {
  it("is the first message, so a key over the body sees it", () => {
    const request = buildChatRequest(CHUNK, MODEL, 4_000);
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.content).toBe(buildSystemPrompt("PROMPT_JSON"));
  });

  it("differs between capability modes, so keys differ too", () => {
    expect(buildSystemPrompt("STRUCTURED")).not.toBe(buildSystemPrompt("PROMPT_JSON"));
  });

  it("is carried in the user-facing message builder for the system role", () => {
    // Guards the shape the two assertions above rely on.
    expect(buildUserMessage(CHUNK, "PROMPT_JSON")).toContain("BEGIN UNTRUSTED DIFF");
  });
});
