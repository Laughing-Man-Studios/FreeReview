/**
 * Action input parsing, defaults, and validation.
 *
 * Validation is deliberately hand-rolled rather than schema-driven so that every
 * rejection can name the exact offending input. `CONFIG_INVALID` is an
 * action_failure, and an operator staring at a red X needs to be told which
 * input to fix without reading our source.
 *
 * This module also hosts **guard 1 of 3** against paid routing (see
 * `llm/client.ts` for guards 2 and 3): a model ID that does not end in `:free`
 * is rejected here, before any network call is made.
 */

import type { CapabilityMode } from "./types.js";

export type PrivacyMode = "strict" | "relaxed";

export interface ModelDefinition {
  readonly id: string;
  readonly enabled: boolean;
  readonly priority: number;
  /**
   * Declared conservatively from the catalog and verified at runtime against
   * `GET /api/v1/models`. Null means "unknown until probed" — the action
   * adapts its request shape to whatever the catalog actually reports.
   */
  readonly maxContextTokens: number | null;
  readonly supportsResponseFormat: boolean | null;
  readonly supportsJsonSchema: boolean | null;
  /**
   * Last manually-verified endpoint privacy posture. NOT queryable at runtime
   * (the endpoints API is management-key only), so this is a maintenance-time
   * assertion recorded in source. See docs/execution-plan.md §1 item 2.
   */
  readonly privacyEligible: boolean;
  /** What produced `privacyEligible`, for the step summary. */
  readonly privacyVerifiedOn?: string;
}

/**
 * Default model pool.
 *
 * Ordering here is a starting point, NOT a quality ranking. The authoritative
 * ordering is whatever `eval/thresholds.json` measures — see
 * docs/model-evaluation.md. `privacyEligible: false` models are never selected
 * in strict mode regardless of capability.
 */
export const DEFAULT_MODELS: readonly ModelDefinition[] = [
  {
    id: "qwen/qwen3.8-27b:free",
    enabled: true,
    priority: 0,
    maxContextTokens: 262_144,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true,
  },
  {
    // Structured-output capable, 262k context. The strongest structured-output
    // fallback in the free catalog as of 2026-09-27.
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    enabled: true,
    priority: 1,
    maxContextTokens: 262_144,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true,
  },
  {
    id: "liquid/lfm-2.5-2.6b:free",
    enabled: true,
    priority: 2,
    maxContextTokens: 65_536,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true,
  },
  {
    // Exposes `response_format` but NOT `structured_outputs`, so it cannot be
    // used with json_schema under `require_parameters: true`. Selects
    // JSON_OBJECT mode. Small context window.
    id: "google/gemma-4-31b-it:free",
    enabled: true,
    priority: 3,
    maxContextTokens: 262_144,
    supportsResponseFormat: true,
    supportsJsonSchema: false,
    privacyEligible: true,
  },
  {
    // No response_format at all. Selects PROMPT_JSON mode with defensive
    // parsing. 1M context, but no structured-output guarantee.
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    enabled: true,
    priority: 4,
    maxContextTokens: 1_000_000,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: true,
  },
  {
    // Excluded by default: OpenRouter documents that free usage may be used to
    // train and improve Poolside models. Retained in code (not removed) so the
    // model remains available to `privacy_mode: relaxed`.
    id: "poolside/laguna-s-2.1:free",
    enabled: false,
    priority: 5,
    maxContextTokens: 262_144,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: false,
  },
  {
    // Excluded by default: the free Inkling endpoint documents that prompts and
    // outputs are logged and used to improve Thinking Machines Lab models.
    id: "thinkingmachines/inkling-small:free",
    enabled: false,
    priority: 6,
    maxContextTokens: 1_048_576,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: false,
  },
];

export interface Config {
  readonly openrouterApiKey: string;
  readonly privacyMode: PrivacyMode;
  readonly models: readonly ModelDefinition[];
  readonly maxChangedLines: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxRequestsPerRun: number;
  readonly maxConcurrency: number;
  readonly maxRequestsPerMinute: number;
  readonly maxRetriesPerRequest: number;
  readonly maxFindingsPerChunk: number;
  readonly includeSuggestions: boolean;
  readonly debugPayloads: boolean;
  /** Never spend the last N of the 50/day free allowance. */
  readonly dailyReserve: number;
  /** Conservative chars-per-token divisor for the estimator. */
  readonly charsPerToken: number;
  readonly tokenSafetyMultiplier: number;
  /** Single request timeout, ms. */
  readonly requestTimeoutMs: number;
  /** Overall run budget, ms. */
  readonly runBudgetMs: number;
  readonly referer: string;
  readonly title: string;
}

export class ConfigError extends Error {
  constructor(
    readonly input: string,
    readonly detail: string,
  ) {
    super(`Invalid configuration for input '${input}': ${detail}`);
    this.name = "ConfigError";
  }
}

/**
 * OpenRouter model IDs are `author/slug` and free variants end in `:free`.
 * Anchored, so `:free` must be a literal suffix.
 */
export const FREE_MODEL_ID_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._-]+:free$/;

/** Guard 1 of 3. Any non-`:free` ID is rejected here, before any network I/O. */
export function assertFreeModelId(id: string, input: string): void {
  if (!FREE_MODEL_ID_PATTERN.test(id)) {
    throw new ConfigError(
      input,
      `'${id}' is not a valid free model ID. Must match ${FREE_MODEL_ID_PATTERN} ` +
        `(lowercase author/slug ending in ':free'). This action never routes to a paid model.`,
    );
  }
}

function readRaw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // GitHub exposes action inputs as INPUT_<UPPERCASED_NAME>.
  const raw = env[`INPUT_${name.toUpperCase()}`];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  // Reject "12abc", "1e5", "0x10", "" and other JS-parseable-but-not-integer input.
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(name, `'${raw}' is not an integer.`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new ConfigError(name, `${value} is outside the allowed range [${min}, ${max}].`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = readRaw(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["true", "yes", "1", "on"].includes(raw)) return true;
  if (["false", "no", "0", "off"].includes(raw)) return false;
  throw new ConfigError(name, `'${raw}' is not a boolean. Use true or false.`);
}

function readPrivacyMode(env: NodeJS.ProcessEnv): PrivacyMode {
  const raw = readRaw(env, "privacy_mode")?.toLowerCase() ?? "strict";
  if (raw === "strict" || raw === "relaxed") return raw;
  throw new ConfigError("privacy_mode", `'${raw}' is not a valid mode. Use strict or relaxed.`);
}

function parseModelList(
  value: string | undefined,
  input: string,
): ModelDefinition[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return ids.map((id, index) => {
    assertFreeModelId(id, input);
    return {
      id,
      enabled: true,
      priority: index,
      maxContextTokens: null,
      supportsResponseFormat: null,
      supportsJsonSchema: null,
      // Unknown until the runtime catalog probe. An unverified model is
      // treated as eligible in strict mode only if the request-time ZDR and
      // data_collection constraints can be satisfied — which OpenRouter
      // enforces, not us. A 503/404 means no endpoint qualified.
      privacyEligible: true,
    };
  });
}

/**
 * Read the debug flag without validating the rest of the configuration.
 *
 * The logger must exist before config is validated, because a CONFIG_INVALID
 * run still needs to report why. Returns false on anything unparseable rather
 * than throwing, since the full validation happens moments later in
 * `loadConfig` and will report the problem properly there.
 */
export function debugPayloadsFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readBool(env, "debug_payloads", false);
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const openrouterApiKey = readRaw(env, "openrouter_api_key");
  if (openrouterApiKey === undefined) {
    throw new ConfigError(
      "openrouter_api_key",
      "Required input is missing. Set the OPENROUTER_API_KEY repository secret and pass it as `openrouter_api_key`.",
    );
  }

  const privacyMode = readPrivacyMode(env);

  const configuredPrimary = readRaw(env, "primary_model");
  const configuredFallbacks = parseModelList(readRaw(env, "fallback_models"), "fallback_models");

  let models: ModelDefinition[];
  if (configuredPrimary === undefined && configuredFallbacks === undefined) {
    models = [...DEFAULT_MODELS];
  } else {
    const primaryId = configuredPrimary ?? DEFAULT_MODELS[0]?.id;
    if (primaryId === undefined) {
      throw new ConfigError("primary_model", "No default primary model is configured.");
    }
    assertFreeModelId(primaryId, "primary_model");

    const primary: ModelDefinition = {
      id: primaryId,
      enabled: true,
      priority: 0,
      maxContextTokens: null,
      supportsResponseFormat: null,
      supportsJsonSchema: null,
      privacyEligible: true,
    };

    const fallbackIds = configuredFallbacks ?? [];
    models = [
      primary,
      ...fallbackIds.map((f, index) => {
        const known = DEFAULT_MODELS.find((m) => m.id === f.id);
        return {
          id: f.id,
          enabled: true,
          priority: index + 1,
          maxContextTokens: known?.maxContextTokens ?? null,
          supportsResponseFormat: known?.supportsResponseFormat ?? null,
          supportsJsonSchema: known?.supportsJsonSchema ?? null,
          privacyEligible: known?.privacyEligible ?? true,
        };
      }),
    ];
  }

  const maxInputTokens = readInt(env, "max_input_tokens", 24_000, { min: 1_000, max: 400_000 });
  const maxOutputTokens = readInt(env, "max_output_tokens", 1_500, { min: 256, max: 32_000 });
  const maxChangedLines = readInt(env, "max_changed_lines", 2_000, { min: 1, max: 100_000 });

  const config: Config = {
    openrouterApiKey,
    privacyMode,
    models,
    maxChangedLines,
    maxInputTokens,
    maxOutputTokens,
    maxRequestsPerRun: readInt(env, "max_requests_per_run", 8, { min: 1, max: 50 }),
    maxConcurrency: readInt(env, "max_concurrency", 2, { min: 1, max: 4 }),
    // Stay under OpenRouter's documented 20 RPM free-model cap.
    maxRequestsPerMinute: 15,
    maxRetriesPerRequest: 1,
    maxFindingsPerChunk: readInt(env, "max_findings_per_chunk", 5, { min: 1, max: 20 }),
    includeSuggestions: readBool(env, "include_suggestions", false),
    debugPayloads: readBool(env, "debug_payloads", false),
    dailyReserve: 10,
    charsPerToken: 3.2,
    tokenSafetyMultiplier: 1.25,
    requestTimeoutMs: 120_000,
    runBudgetMs: 8 * 60_000,
    referer: "https://github.com/Laughing-Man-Studios/FreeReview",
    title: "FreeReview",
  };

  validateConfig(config);
  return config;
}

/**
 * Cross-input validation that can only be done once everything is parsed.
 * Separated from `loadConfig` so tests can construct a partial Config and
 * exercise the checks directly.
 */
export function validateConfig(config: Config): void {
  if (config.models.length === 0) {
    throw new ConfigError("primary_model", "At least one model must be configured.");
  }

  const seen = new Set<string>();
  for (const model of config.models) {
    assertFreeModelId(model.id, "primary_model");
    if (seen.has(model.id)) {
      throw new ConfigError("fallback_models", `Duplicate model '${model.id}'.`);
    }
    seen.add(model.id);
  }

  if (config.privacyMode === "strict" && !config.models.some((m) => m.enabled)) {
    throw new ConfigError(
      "primary_model",
      "No enabled model remains. Strict privacy mode requires at least one privacy-eligible model.",
    );
  }

  // Context-window arithmetic. A model whose declared window cannot hold
  // input + output will fail every request with `context_length_exceeded`,
  // which wastes quota. Catch it here instead.
  for (const model of config.models) {
    if (model.maxContextTokens === null) continue; // unknown until catalog probe
    const needed = config.maxInputTokens + config.maxOutputTokens;
    if (needed > model.maxContextTokens) {
      throw new ConfigError(
        "max_input_tokens",
        `Model '${model.id}' has a ${model.maxContextTokens}-token context window, but ` +
          `max_input_tokens (${config.maxInputTokens}) + max_output_tokens (${config.maxOutputTokens}) ` +
          `= ${needed}. Lower the token budgets or use a model with a larger window.`,
      );
    }
  }
}

/**
 * The enabled model pool in priority order, filtered by privacy policy.
 *
 * In strict mode, models flagged `privacyEligible: false` are excluded. Note
 * this is a *static* exclusion based on manually verified endpoint posture; the
 * authoritative enforcement is the per-request `zdr` / `data_collection` flags,
 * which OpenRouter applies.
 */
export function eligibleModels(config: Config): ModelDefinition[] {
  return config.models
    .filter((m) => m.enabled)
    .filter((m) => config.privacyMode === "relaxed" || m.privacyEligible)
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Which request shape a model's capabilities support.
 *
 * `require_parameters: true` must only be sent alongside `json_schema`;
 * sending it otherwise excludes every endpoint and yields a 503 for free.
 */
export function capabilityModeFor(model: ModelDefinition): CapabilityMode {
  if (model.supportsJsonSchema === true) return "STRUCTURED";
  if (model.supportsResponseFormat === true) return "JSON_OBJECT";
  if (model.supportsJsonSchema === false) return "PROMPT_JSON";
  if (model.supportsResponseFormat === false) return "PROMPT_JSON";
  // Unknown: assume the least demanding shape. The catalog probe upgrades this
  // before the first request in practice.
  return "PROMPT_JSON";
}
