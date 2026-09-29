/**
 * Catalog and quota probes.
 *
 * Both exist to avoid spending a request on something that was knowable in
 * advance. The catalogue verifies that a configured model still exists, is still
 * free, and can carry the request shape we intend to send; the quota probe stops
 * a run from walking into a 429 wall it could see coming.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config, type ModelDefinition } from "../../src/config.js";
import { KEY_URL, MODELS_URL } from "../../src/llm/client.js";
import {
  evaluateModel,
  fetchCatalog,
  fetchQuota,
  quotaDecision,
  type CatalogModel,
} from "../../src/llm/catalog.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function config(): Config {
  return loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000" });
}

const QWEN: ModelDefinition = {
  id: "qwen/qwen3.8-27b:free",
  enabled: true,
  priority: 0,
  maxContextTokens: 262_144,
  supportsResponseFormat: true,
  supportsJsonSchema: true,
  privacyEligible: true,
  zdrEligible: false,
};

const REQUIRED = { inputTokens: 24_000, outputTokens: 1_500, mode: "STRUCTURED" as const };

function catalogEntry(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: QWEN.id,
    context_length: 262_144,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["temperature", "max_tokens", "structured_outputs", "tools"],
    ...overrides,
  };
}

describe("fetchCatalog", () => {
  it("returns the model list on success", async () => {
    server.use(http.get(MODELS_URL, () => HttpResponse.json({ data: [catalogEntry()] })));
    const catalog = await fetchCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog?.[0]?.id).toBe(QWEN.id);
  });

  it("returns null when the catalog is unreachable, rather than throwing", async () => {
    // A probe failure must not disable the reviewer.
    server.use(http.get(MODELS_URL, () => HttpResponse.error()));
    expect(await fetchCatalog()).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    server.use(http.get(MODELS_URL, () => HttpResponse.json({ error: "nope" }, { status: 500 })));
    expect(await fetchCatalog()).toBeNull();
  });

  it("returns null for a malformed body", async () => {
    server.use(http.get(MODELS_URL, () => HttpResponse.json({ unexpected: true })));
    expect(await fetchCatalog()).toBeNull();
  });
});

describe("evaluateModel — free is verified, not assumed", () => {
  it("accepts a model present, zero-priced, with the needed capability", () => {
    const entry = evaluateModel(QWEN, [catalogEntry()], REQUIRED);
    expect(entry.problem).toBeNull();
    expect(entry.isFree).toBe(true);
    expect(entry.supportsJsonSchema).toBe(true);
    expect(entry.contextLength).toBe(262_144);
  });

  it("rejects a model that is no longer in the catalog", () => {
    const entry = evaluateModel(QWEN, [catalogEntry({ id: "other/model:free" })], REQUIRED);
    expect(entry.exists).toBe(false);
    expect(entry.problem).toMatch(/no longer present/);
  });

  it("rejects a :free model that is no longer priced at zero", () => {
    // The id ending in :free is not proof of a free price. This is the check
    // that makes the $0 guarantee verifiable rather than conventional.
    const entry = evaluateModel(QWEN, [catalogEntry({ pricing: { prompt: "0.0000001", completion: "0" } })], REQUIRED);
    expect(entry.isFree).toBe(false);
    expect(entry.problem).toMatch(/not priced at zero/);
  });

  it("rejects a model whose completion price rose", () => {
    const entry = evaluateModel(QWEN, [catalogEntry({ pricing: { prompt: "0", completion: "0.5" } })], REQUIRED);
    expect(entry.isFree).toBe(false);
  });
});

describe("evaluateModel — capability and context", () => {
  it("rejects a model that cannot carry the required schema", () => {
    // The model advertises response_format but not structured_outputs, so a
    // strict json_schema with require_parameters would exclude every endpoint.
    const entry = evaluateModel(
      QWEN,
      [catalogEntry({ supported_parameters: ["temperature", "response_format"] })],
      REQUIRED,
    );
    expect(entry.problem).toMatch(/does not advertise structured_outputs/);
  });

  it("accepts a model with only response_format when the mode does not need a schema", () => {
    const entry = evaluateModel(QWEN, [catalogEntry({ supported_parameters: ["response_format"] })], {
      ...REQUIRED,
      mode: "JSON_OBJECT",
    });
    expect(entry.problem).toBeNull();
  });

  it("rejects a model whose context window cannot hold the request", () => {
    const entry = evaluateModel(QWEN, [catalogEntry({ context_length: 8_000 })], REQUIRED);
    expect(entry.problem).toMatch(/context window is 8000 tokens/);
  });

  it("accepts a model whose window exactly fits", () => {
    const entry = evaluateModel(QWEN, [catalogEntry({ context_length: 25_500 })], REQUIRED);
    expect(entry.problem).toBeNull();
  });
});

describe("evaluateModel — an unavailable catalog is not a failure", () => {
  it("proceeds on configured assumptions when the catalog could not be read", () => {
    const entry = evaluateModel(QWEN, null, REQUIRED);
    expect(entry.model).toBeNull();
    expect(entry.problem).toBeNull();
    expect(entry.exists).toBe(true);
  });

  it("still reports the configured context window when the catalog is unknown", () => {
    expect(evaluateModel(QWEN, null, REQUIRED).contextLength).toBe(262_144);
  });
});

describe("fetchQuota", () => {
  it("reads the daily free-model counters", async () => {
    server.use(
      http.get(KEY_URL, () =>
        HttpResponse.json({
          data: {
            is_free_tier: false,
            free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
          },
        }),
      ),
    );

    const quota = await fetchQuota(config());
    expect(quota?.remaining).toBe(38);
    expect(quota?.limit).toBe(50);
    expect(quota?.isFreeTier).toBe(false);
  });

  it("returns null when the key is rejected", async () => {
    server.use(http.get(KEY_URL, () => HttpResponse.json({ error: "bad key" }, { status: 401 })));
    expect(await fetchQuota(config())).toBeNull();
  });

  it("returns null on a network failure", async () => {
    server.use(http.get(KEY_URL, () => HttpResponse.error()));
    expect(await fetchQuota(config())).toBeNull();
  });

  it("sends the API key", async () => {
    let seen: string | null = null;
    server.use(
      http.get(KEY_URL, ({ request }) => {
        seen = request.headers.get("authorization");
        return HttpResponse.json({ data: {} });
      }),
    );
    await fetchQuota(config());
    expect(seen).toBe("Bearer sk-test-0000000000000000");
  });
});

describe("quotaDecision", () => {
  const quota = (remaining: number, limit = 50) => ({
    remaining,
    limit,
    used: limit - remaining,
    isFreeTier: false,
  });

  it("proceeds when there is plenty of allowance", () => {
    const decision = quotaDecision(quota(45), 10, 3);
    expect(decision.proceed).toBe(true);
    expect(decision.diagnostic).toBeNull();
    expect(decision.reason).toMatch(/remain today/);
  });

  it("stops when the allowance is exhausted", () => {
    const decision = quotaDecision(quota(4), 10, 1);
    expect(decision.proceed).toBe(false);
    expect(decision.diagnostic).toBe("OPENROUTER_QUOTA_EXHAUSTED");
    expect(decision.reason).toMatch(/resets at UTC midnight/);
  });

  it("stops when only the reserve remains, even with requests left", () => {
    // The reserve exists so a $0 action cannot consume the whole day on its own
    // and leave nothing for a human to debug with.
    expect(quotaDecision(quota(10), 10, 1).proceed).toBe(false);
  });

  it("proceeds with a warning when the plan covers only part of the run", () => {
    const decision = quotaDecision(quota(13), 10, 8);
    expect(decision.proceed).toBe(true);
    expect(decision.reason).toMatch(/Only 3 of the 8 planned/);
  });

  it("proceeds when the quota is unreadable, relying on the per-run budget", () => {
    // Refusing to review because a probe failed would make the tool useless
    // whenever OpenRouter has a bad minute. The per-run budget still bounds it.
    const decision = quotaDecision(null, 10, 8);
    expect(decision.proceed).toBe(true);
    expect(decision.reason).toMatch(/per-run budget/);
  });

  it("proceeds when remaining is present but the limit is not", () => {
    const decision = quotaDecision({ remaining: 20, limit: null, used: null, isFreeTier: false }, 10, 2);
    expect(decision.proceed).toBe(true);
    expect(decision.reason).toMatch(/of \? free-model requests remain/);
  });
});
