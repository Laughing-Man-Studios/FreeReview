import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  ConfigError,
  reviewModeFor,
  supportedModesFor,
  eligibleModels,
  loadConfig,
  validateConfig,
  type Config,
  type ModelDefinition,
} from "../../src/config.js";
import { FREE_MODEL_ID_PATTERN, assertFreeModelId } from "../../src/config.js";

/** Minimal valid env; overridden per test. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { INPUT_OPENROUTER_API_KEY: "sk-test-not-a-real-key", ...overrides };
}

function model(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: "qwen/qwen3.8-27b:free",
    enabled: true,
    priority: 0,
    maxContextTokens: 262_144,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true,
    zdrEligible: false,
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig(env()), ...overrides };
}

describe("FREE_MODEL_ID_PATTERN (guard 1 of 3 against paid routing)", () => {
  it.each([
    "qwen/qwen3.8-27b:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "dots-studio/dots-3-note-preview:free",
    "vendor/model_v1.2-rc.3:free",
  ])("accepts %s", (id) => {
    expect(FREE_MODEL_ID_PATTERN.test(id)).toBe(true);
    expect(() => assertFreeModelId(id, "primary_model")).not.toThrow();
  });

  it.each([
    // The exact substitution the plan forbids: dropping :free silently
    // converts a $0 endpoint into a paid one.
    ["qwen/qwen3.8-27b", "paid variant of a free model"],
    ["openai/gpt-4o", "paid model"],
    ["openrouter/free", "free router (not reproducible)"],
    ["openrouter/auto", "auto router"],
    ["Qwen/Qwen3.8-27B:free", "uppercase (OpenRouter IDs are lowercase)"],
    ["qwen/qwen3.8-27b:free:extra", "suffix after :free"],
    ["qwen/qwen3.8-27b:paid", "wrong suffix"],
    ["qwen", "missing author prefix"],
    [":free", "missing slug"],
    ["qwen/", "missing slug"],
    ["/qwen3.8-27b:free", "missing author"],
    ["", "empty"],
    ["qwen/qwen3.8 27b:free", "space in slug"],
  ])("rejects %s (%s)", (id) => {
    expect(FREE_MODEL_ID_PATTERN.test(id)).toBe(false);
    expect(() => assertFreeModelId(id, "primary_model")).toThrow(ConfigError);
  });

  it("names the input in the error", () => {
    expect(() => assertFreeModelId("openai/gpt-4o", "fallback_models")).toThrow(/fallback_models/);
  });

  it("the error message states the action never routes to a paid model", () => {
    expect(() => assertFreeModelId("openai/gpt-4o", "primary_model")).toThrow(
      /never routes to a paid model/i,
    );
  });
});

describe("loadConfig — required input", () => {
  it("throws CONFIG_INVALID naming openrouter_api_key when missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).input).toBe("openrouter_api_key");
    }
  });

  it("treats a whitespace-only key as missing", () => {
    expect(() => loadConfig({ INPUT_OPENROUTER_API_KEY: "   " })).toThrow(/openrouter_api_key/);
  });

  it("does not echo the key value in the error message", () => {
    try {
      loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-abcdef0123456789abcdef" });
    } catch {
      // no throw expected
    }
    // Missing-key error must not contain any key material.
    try {
      loadConfig({});
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toMatch(/sk-/);
    }
  });
});

describe("loadConfig — numeric inputs", () => {
  it.each([
    ["max_input_tokens", "0", "below min"],
    ["max_input_tokens", "1500", "below the estimator's reserve"],
    ["max_input_tokens", "abc", "not an integer"],
    ["max_input_tokens", "12abc", "trailing garbage"],
    ["max_input_tokens", "1e5", "exponent notation"],
    ["max_input_tokens", "0x10", "hex notation"],
    ["max_input_tokens", "999999", "above max"],
    ["max_output_tokens", "-1", "negative"],
    ["max_changed_lines", "0", "below min"],
    ["max_requests_per_run", "0", "below min"],
    ["max_requests_per_run", "51", "above max"],
    ["max_concurrency", "5", "above the hard cap of 4"],
    ["max_findings_per_chunk", "0", "below min"],
    ["max_findings_per_chunk", "21", "above max"],
  ])("%s rejects '%s' (%s)", (name, value) => {
    expect(() => loadConfig(env({ [`INPUT_${name.toUpperCase()}`]: value }))).toThrow(ConfigError);
  });

  it("accepts values at the exact bounds", () => {
    // max_input_tokens has a floor of 2000, not 1000: the estimator reserves
    // REQUEST_OVERHEAD_TOKENS + PER_CHUNK_SCAFFOLD_TOKENS before any diff
    // content, and below that the content budget would hit its floor and the
    // total would exceed the configured maximum.
    const c = loadConfig(
      env({
        INPUT_MAX_INPUT_TOKENS: "2000",
        INPUT_MAX_OUTPUT_TOKENS: "256",
        INPUT_MAX_CHANGED_LINES: "1",
        INPUT_MAX_REQUESTS_PER_RUN: "1",
        INPUT_MAX_CONCURRENCY: "1",
        INPUT_MAX_FINDINGS_PER_CHUNK: "1",
      }),
    );
    expect(c.maxInputTokens).toBe(2000);
    expect(c.maxOutputTokens).toBe(256);
    expect(c.maxChangedLines).toBe(1);
    expect(c.maxRequestsPerRun).toBe(1);
    expect(c.maxConcurrency).toBe(1);
    expect(c.maxFindingsPerChunk).toBe(1);
  });

  it("rejects max_input_tokens below the estimator's reserve", () => {
    expect(() => loadConfig(env({ INPUT_MAX_INPUT_TOKENS: "1999" }))).toThrow(/max_input_tokens/);
    expect(() => loadConfig(env({ INPUT_MAX_INPUT_TOKENS: "1000" }))).toThrow(/max_input_tokens/);
  });

  it("applies documented defaults when inputs are absent", () => {
    const c = loadConfig(env());
    expect(c.maxChangedLines).toBe(2000);
    expect(c.maxInputTokens).toBe(24000);
    expect(c.maxOutputTokens).toBe(4_000);
  });

  it("defaults the output budget high enough for a reasoning model to finish", () => {
    // Measured 2026-09-29: the only free model with a ZDR endpoint is a
    // reasoning model. At 1500 output tokens it returned an empty response on
    // 4 of 4 attempts; at 4000 it returned usable JSON on all 4.
    //
    // Too small produces an empty response rather than a short one, so this is a
    // correctness floor, not a quality preference. If it regresses, every run
    // silently publishes "no review was produced" and nothing looks broken.
    const c = loadConfig(env());
    expect(c.maxOutputTokens).toBeGreaterThanOrEqual(3_000);
    expect(c.maxRequestsPerRun).toBe(8);
    expect(c.maxConcurrency).toBe(2);
    expect(c.maxFindingsPerChunk).toBe(5);
    expect(c.privacyMode).toBe("strict");
    expect(c.includeSuggestions).toBe(false);
    expect(c.debugPayloads).toBe(false);
  });

  it("keeps requests-per-minute under OpenRouter's 20 RPM free cap", () => {
    expect(loadConfig(env()).maxRequestsPerMinute).toBeLessThan(20);
  });
});

describe("loadConfig — boolean inputs", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["1", true],
    ["on", true],
    ["false", false],
    ["no", false],
    ["0", false],
    ["off", false],
  ])("include_suggestions='%s' -> %s", (value, expected) => {
    expect(loadConfig(env({ INPUT_INCLUDE_SUGGESTIONS: value })).includeSuggestions).toBe(expected);
  });

  it.each(["maybe", "2", "t", "y"])("rejects non-boolean '%s'", (value) => {
    expect(() => loadConfig(env({ INPUT_INCLUDE_SUGGESTIONS: value }))).toThrow(ConfigError);
  });
});

describe("loadConfig — privacy_mode", () => {
  it("defaults to strict", () => {
    expect(loadConfig(env()).privacyMode).toBe("strict");
  });

  it.each(["strict", "relaxed", "STRICT", "Relaxed"])("accepts '%s'", (value) => {
    expect(["strict", "relaxed"]).toContain(
      loadConfig(env({ INPUT_PRIVACY_MODE: value })).privacyMode,
    );
  });

  it.each(["off", "none", "permissive", "STRICTLY_RELAXED", "true"])(
    "rejects '%s'",
    (value) => {
      expect(() => loadConfig(env({ INPUT_PRIVACY_MODE: value }))).toThrow(ConfigError);
    },
  );

  it("treats an empty value as unset and falls back to strict", () => {
    // An empty input is indistinguishable from an absent one, so it must
    // resolve to the safe default rather than to relaxed.
    expect(loadConfig(env({ INPUT_PRIVACY_MODE: "" })).privacyMode).toBe("strict");
    expect(loadConfig(env({ INPUT_PRIVACY_MODE: "   " })).privacyMode).toBe("strict");
  });
});

describe("loadConfig — model configuration", () => {
  it("uses DEFAULT_MODELS when no model input is given", () => {
    const c = loadConfig(env());
    expect(c.models).toHaveLength(DEFAULT_MODELS.length);
    // The default primary is the one free model with a verified ZDR endpoint.
    // Everything else in the pool returns 404 under the default strict privacy
    // mode, so shipping anything else first means the default configuration
    // reviews nothing.
    expect(c.models[0]?.id).toBe("inclusionai/ling-3.0-flash-sante:free");
  });

  it("has exactly one model with a verified ZDR endpoint", () => {
    // Measured 2026-09-29 by probing every free model in the catalog with
    // `zdr: true`. If a second one appears, this test is the prompt to verify
    // it properly and re-order the pool toward structured output.
    const zdr = DEFAULT_MODELS.filter((m) => m.zdrEligible);
    expect(zdr.map((m) => m.id)).toEqual(["inclusionai/ling-3.0-flash-sante:free"]);
  });

  it("orders ZDR-capable models first in strict mode, so the budget is not wasted", () => {
    // Under strict, every request carries zdr:true, so trying a non-ZDR model is
    // a guaranteed 404 that costs one of the daily allowance to learn nothing.
    const c = loadConfig(env());
    const first = eligibleModels(c)[0];
    expect(first?.zdrEligible).toBe(true);
  });

  it("keeps the whole pool available in strict mode, just re-ordered", () => {
    // Not excluded: a ZDR endpoint can appear or disappear, so a pool that
    // hard-excluded non-ZDR models would have no recovery path.
    const c = loadConfig(env());
    expect(eligibleModels(c)).toHaveLength(DEFAULT_MODELS.filter((m) => m.enabled).length);
  });

  it("does not reorder in relaxed mode, where ZDR is not requested", () => {
    const c = loadConfig(env({ INPUT_PRIVACY_MODE: "relaxed" }));
    const order = eligibleModels(c).map((m) => m.id);
    expect(order[0]).toBe("inclusionai/ling-3.0-flash-sante:free");
    // Priority order is otherwise preserved.
    const priorities = eligibleModels(c).map((m) => m.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it("does not promote a user-supplied model to ZDR-capable", () => {
    // A bare `primary_model` is a user assertion with no measured ZDR verdict.
    // Assuming `true` would put an unverified model at the front of a strict
    // pool where it is guaranteed to 404.
    const c = loadConfig(env({ INPUT_PRIMARY_MODEL: "cohere/north-mini-code:free" }));
    expect(c.models[0]?.zdrEligible).toBe(false);
  });

  it("every default model is a valid free ID", () => {
    for (const m of DEFAULT_MODELS) {
      expect(FREE_MODEL_ID_PATTERN.test(m.id), `${m.id} must be a :free ID`).toBe(true);
    }
  });

  it("rejects a non-:free primary model", () => {
    expect(() => loadConfig(env({ INPUT_PRIMARY_MODEL: "openai/gpt-4o" }))).toThrow(ConfigError);
  });

  it("rejects a non-:free entry in fallback_models", () => {
    expect(() =>
      loadConfig(env({ INPUT_FALLBACK_MODELS: "google/gemma-4-31b-it:free,openai/gpt-4o" })),
    ).toThrow(/fallback_models/);
  });

  it("accepts a comma-separated fallback list with whitespace", () => {
    const c = loadConfig(
      env({ INPUT_FALLBACK_MODELS: " google/gemma-4-31b-it:free , liquid/lfm-2.5-2.6b:free " }),
    );
    expect(c.models.map((m) => m.id)).toEqual([
      "inclusionai/ling-3.0-flash-sante:free",
      "google/gemma-4-31b-it:free",
      "liquid/lfm-2.5-2.6b:free",
    ]);
  });

  it("ignores empty segments in fallback_models", () => {
    const c = loadConfig(env({ INPUT_FALLBACK_MODELS: "a/b:free,,c/d:free," }));
    expect(c.models).toHaveLength(3);
  });

  it("inherits known capabilities from DEFAULT_MODELS", () => {
    const c = loadConfig(env({ INPUT_FALLBACK_MODELS: "google/gemma-4-31b-it:free" }));
    const fallback = c.models[1];
    expect(fallback?.supportsJsonSchema).toBe(false);
    expect(fallback?.supportsResponseFormat).toBe(true);
  });

  it("rejects duplicate models", () => {
    // A fallback that repeats the primary would make the scheduler retry the
    // same model twice on failure, burning two requests to learn one thing.
    expect(() =>
      loadConfig(env({ INPUT_FALLBACK_MODELS: "inclusionai/ling-3.0-flash-sante:free,liquid/lfm-2.5-2.6b:free" })),
    ).toThrow(/Duplicate/);
  });

  it("rejects an empty model pool", () => {
    expect(() => validateConfig(config({ models: [] }))).toThrow(/At least one model/);
  });
});

describe("validateConfig — context window arithmetic", () => {
  it("rejects budgets that exceed a model's declared context window", () => {
    expect(() =>
      validateConfig(
        config({
          maxInputTokens: 24_000,
          maxOutputTokens: 1_500,
          models: [model({ maxContextTokens: 10_000 })],
        }),
      ),
    ).toThrow(/context window/);
  });

  it("accepts budgets that exactly fit the context window", () => {
    expect(() =>
      validateConfig(
        config({
          maxInputTokens: 8_500,
          maxOutputTokens: 1_500,
          models: [model({ maxContextTokens: 10_000 })],
        }),
      ),
    ).not.toThrow();
  });

  it("skips the check for models whose window is unknown until the catalog probe", () => {
    expect(() =>
      validateConfig(
        config({
          maxInputTokens: 24_000,
          maxOutputTokens: 1_500,
          models: [model({ maxContextTokens: null })],
        }),
      ),
    ).not.toThrow();
  });

  it("every default model's window accommodates the default budgets", () => {
    for (const m of DEFAULT_MODELS) {
      if (m.maxContextTokens === null) continue;
      expect(
        m.maxContextTokens,
        `${m.id} window too small for 24000+4000`,
      ).toBeGreaterThanOrEqual(24_000 + 1_500);
    }
  });
});

describe("eligibleModels — privacy filtering", () => {
  it("strict mode excludes models flagged not privacy-eligible", () => {
    const c = config({
      privacyMode: "strict",
      models: [
        model({ id: "qwen/qwen3.8-27b:free", priority: 0, privacyEligible: true }),
        model({ id: "poolside/laguna-s-2.1:free", priority: 1, privacyEligible: false }),
        model({ id: "thinkingmachines/inkling-small:free", priority: 2, privacyEligible: false }),
      ],
    });
    expect(eligibleModels(c).map((m) => m.id)).toEqual(["qwen/qwen3.8-27b:free"]);
  });

  it("relaxed mode includes every enabled model", () => {
    const c = config({
      privacyMode: "relaxed",
      models: [
        model({ id: "qwen/qwen3.8-27b:free", priority: 0, privacyEligible: true }),
        model({ id: "poolside/laguna-s-2.1:free", priority: 1, privacyEligible: false }),
      ],
    });
    expect(eligibleModels(c).map((m) => m.id)).toEqual([
      "qwen/qwen3.8-27b:free",
      "poolside/laguna-s-2.1:free",
    ]);
  });

  it("excludes disabled models in both modes", () => {
    const c = config({
      privacyMode: "relaxed",
      models: [
        model({ id: "qwen/qwen3.8-27b:free", priority: 0 }),
        model({ id: "poolside/laguna-s-2.1:free", priority: 1, enabled: false }),
      ],
    });
    expect(eligibleModels(c).map((m) => m.id)).toEqual(["qwen/qwen3.8-27b:free"]);
  });

  it("orders by priority, not declaration order", () => {
    const c = config({
      models: [
        model({ id: "liquid/lfm-2.5-2.6b:free", priority: 5 }),
        model({ id: "qwen/qwen3.8-27b:free", priority: 0 }),
        model({ id: "nvidia/nemotron-3-super-120b-a12b:free", priority: 2 }),
      ],
    });
    expect(eligibleModels(c).map((m) => m.priority)).toEqual([0, 2, 5]);
  });

  it("the default pool in strict mode yields at least three usable models", () => {
    // A pool that collapses to one model under strict privacy is fragile: the
    // free catalog churns and a single model disappearing disables the action.
    expect(eligibleModels(loadConfig(env())).length).toBeGreaterThanOrEqual(3);
  });
});

describe("supportedModesFor — capability is a filter, not a ranking", () => {
  it("offers STRUCTURED first when the model declares json schema support", () => {
    expect(supportedModesFor(model({ supportsJsonSchema: true }))[0]).toBe("STRUCTURED");
  });

  it("offers JSON_OBJECT when response_format exists but structured_outputs does not", () => {
    expect(supportedModesFor(model({ supportsJsonSchema: false, supportsResponseFormat: true }))[0]).toBe(
      "JSON_OBJECT",
    );
  });

  it("offers only PROMPT_JSON when neither is declared", () => {
    expect(supportedModesFor(model({ supportsJsonSchema: false, supportsResponseFormat: false }))).toEqual([
      "PROMPT_JSON",
    ]);
  });

  it("assumes least-demanding when capabilities are unknown", () => {
    expect(
      supportedModesFor(
        model({ supportsJsonSchema: null, supportsResponseFormat: null, maxContextTokens: null }),
      ),
    ).toEqual(["PROMPT_JSON"]);
  });
});

describe("reviewModeFor — a measured preference beats the strongest capability", () => {
  it("uses the strongest supported mode when nothing has been measured", () => {
    expect(reviewModeFor(model({ supportsJsonSchema: true }))).toBe("STRUCTURED");
    expect(reviewModeFor(model({ supportsJsonSchema: false, supportsResponseFormat: true }))).toBe(
      "JSON_OBJECT",
    );
    expect(reviewModeFor(model({ supportsJsonSchema: false, supportsResponseFormat: false }))).toBe(
      "PROMPT_JSON",
    );
  });

  it("prefers a measured mode over a stronger advertised capability", () => {
    // The finding that replaced the strongest-capability rule. `nemotron-3-super`
    // really does support STRUCTURED, and STRUCTURED scored recall 0.47 against
    // 0.87 in PROMPT_JSON on the same fixtures. Taking the strongest capability
    // would have shipped the 0.47.
    const nemotron = model({
      supportsJsonSchema: true,
      supportsResponseFormat: true,
      preferredMode: "PROMPT_JSON",
    });
    expect(reviewModeFor(nemotron)).toBe("PROMPT_JSON");
  });

  it("prefers JSON_OBJECT for qwen, which is better there than STRUCTURED", () => {
    // qwen advertises structured_outputs but 404s on it, and its recall and
    // injection resistance both improve in JSON_OBJECT over PROMPT_JSON.
    const qwen = model({
      supportsJsonSchema: false,
      supportsResponseFormat: true,
      preferredMode: "JSON_OBJECT",
    });
    expect(reviewModeFor(qwen)).toBe("JSON_OBJECT");
  });

  it("ignores a preferred mode the model cannot serve", () => {
    // A contradiction here would route the action to a shape that 404s, and a
    // 404 names no cause — so it would surface only when a pull request needed
    // reviewing and the primary model had already failed.
    const broken = model({
      supportsJsonSchema: false,
      supportsResponseFormat: false,
      preferredMode: "STRUCTURED",
    });
    expect(reviewModeFor(broken)).toBe("PROMPT_JSON");
  });

  it("degrades to the strongest supported mode when the preference is unsupported", () => {
    const broken = model({
      supportsJsonSchema: true,
      supportsResponseFormat: true,
      preferredMode: "JSON_OBJECT",
    });
    // JSON_OBJECT *is* supported here, so it is honoured.
    expect(reviewModeFor(broken)).toBe("JSON_OBJECT");

    const worse = model({
      supportsJsonSchema: false,
      supportsResponseFormat: false,
      preferredMode: "JSON_OBJECT",
    });
    expect(reviewModeFor(worse)).toBe("PROMPT_JSON");
  });
});

describe("the catalog's chosen modes are internally consistent", () => {
  it("never prefers a mode a model cannot serve", () => {
    for (const entry of DEFAULT_MODELS) {
      const supported = supportedModesFor(entry);
      if (entry.preferredMode !== undefined) {
        expect(supported, `${entry.id} prefers ${entry.preferredMode} but supports ${supported.join(",")}`).toContain(
          entry.preferredMode,
        );
      }
    }
  });

  it("gives every catalog model a measured preference", () => {
    // Every entry was swept on 2026-09-30. A missing preference means the
    // strongest-capability fallback is in play, which is the rule that shipped
    // the 0.47.
    for (const entry of DEFAULT_MODELS) {
      expect(entry.preferredMode, `${entry.id} has no measured preferredMode`).toBeDefined();
    }
  });
});
