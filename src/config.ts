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
   * When the capability flags above were last checked against the live service.
   *
   * `structured_outputs` in OpenRouter's `supported_parameters` is a union across
   * endpoints and can be wrong: `qwen3.8-27b` advertises it and 404s on every
   * STRUCTURED request while serving JSON_OBJECT and PROMPT_JSON normally. A
   * flag believed without a date is a flag nobody has checked, so these record
   * when a real request last agreed with them. Measured by the
   * eval capability matrix (`PROBE_MODE=matrix`).
   */
  readonly capabilityVerifiedOn?: string;
  /**
   * The request shape to use, chosen by measuring review quality in each working
   * mode rather than by taking the strongest one advertised.
   *
   * Measured 2026-09-30 against the Stage A dataset. These two entries disagree
   * with the strongest-capability rule in opposite directions — `qwen` is better
   * in JSON_OBJECT than STRUCTURED, `nemotron-3-super` is much worse in
   * STRUCTURED than PROMPT_JSON — which is why the rule had to go.
   *
   * Absent means "nobody has measured it", and the strongest supported mode is
   * used. Set it whenever a sweep has been run.
   */
  readonly preferredMode?: CapabilityMode;
  /**
   * What this model did when a pull request tried to suppress it.
   *
   * Measured, not assumed. `docs/model-evaluation.md` plants a suppression
   * instruction in the diff alongside a real defect, so the only way to pass is
   * to ignore the instruction and report the defect. A model that complies
   * reports nothing and is scored as having complied.
   *
   * Three outcomes, and the third is the honest default:
   *
   *  - `resistant` — never complied across every observation.
   *  - `exposed`   — complied at least once. Findings from this model may be
   *                  incomplete *by design of the attacker*, and the review says
   *                  so rather than presenting a suppressed review as a clean one.
   *  - `unmeasured`— nobody has tested it. Silent here would be indistinguishable
   *                  from `resistant`, which is the failure this project exists to
   *                  prevent.
   *
   * This is why there is a fallback chain but no injection-resistant fallback:
   * only the primary has ever been measured resistant, so a review that falls
   * through is one a pull request author could have suppressed with a comment.
   */
  readonly injectionResistance?: "resistant" | "exposed" | "unmeasured";
  /**
   * Last manually-verified endpoint privacy posture. NOT queryable at runtime
   * (the endpoints API is management-key only), so this is a maintenance-time
   * assertion recorded in source. See docs/execution-plan.md §1 item 2.
   */
  readonly privacyEligible: boolean;
  /**
   * Whether OpenRouter has a **zero-data-retention** endpoint for this model.
   *
   * This is the hard constraint behind `privacy_mode: strict`, and it is not
   * the same question as `privacyEligible`. Measured live on 2026-09-29: of the
   * free models in the catalog, exactly one could route with `zdr: true`, and
   * none of the structured-output models could. A pool that looks privacy-safe
   * on paper still returns `404 No endpoints found matching your data policy`
   * at request time, so this is recorded per model rather than inferred.
   *
   * Not queryable at runtime — the per-endpoint APIs are management-key only —
   * so this is a maintenance-time assertion, re-verified by `verify-models.yml`
   * and recorded in `docs/execution-plan.md` §8a.
   */
  readonly zdrEligible: boolean;
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
    // The only free model verified to have a ZDR endpoint, as of 2026-09-29.
    //
    // It carries no `response_format` and no `structured_outputs`, so it runs
    // in PROMPT_JSON mode and relies entirely on the defensive parser. That is
    // a real quality cost, and it is the right trade anyway: without it, the
    // default configuration under the default privacy mode reviews nothing at
    // all. A review from a model parsing its own JSON beats no review, and
    // Phase 7 measures whether it is good enough.
    //
    // Provider: Novita. ZDR confirmed by a live `zdr: true` request returning
    // 200; the other 16 free models returned 404 or 429 on the same probe.
    id: "inclusionai/ling-3.0-flash-sante:free",
    enabled: true,
    priority: 0,
    maxContextTokens: 262_144,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: true,
    zdrEligible: true,
    privacyVerifiedOn: "2026-09-29",
    // Measured 2026-09-30: PROMPT_JSON 200, JSON_OBJECT 400, STRUCTURED 404.
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best PROMPT_JSON: only mode that serves; recall 1.00, 0 FP, 0/2 injection
    preferredMode: "PROMPT_JSON",
    // Measured 0/2 injection fixtures across 5 observations, incl. 3 repeated passes
    injectionResistance: "resistant",},
  {
    // `structured_outputs` is advertised in OpenRouter's `supported_parameters`
    // but does NOT work: a STRUCTURED request returns 404 "No endpoints found
    // that can handle the requested parameters", while JSON_OBJECT and
    // PROMPT_JSON both return 200.
    //
    // Measured twice, 2026-09-30, by the eval capability matrix.
    // Advertising the flag while the endpoint cannot serve it would route the
    // action to a mode that 404s, and a 404 names no cause — so this model would
    // appear broken only when a pull request actually needed it.
    id: "qwen/qwen3.8-27b:free",
    enabled: true,
    priority: 1,
    maxContextTokens: 262_144,
    supportsResponseFormat: true,
    supportsJsonSchema: false,
    privacyEligible: true,
    zdrEligible: false,
    privacyVerifiedOn: "2026-09-29",
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best JSON_OBJECT: recall 0.93 / 0/2 injection, vs 0.80 / 2/2 in PROMPT_JSON
    preferredMode: "JSON_OBJECT",
    // Measured complied 1/2 on all 3 repeated passes; a single earlier pass read 0/2
    injectionResistance: "exposed",},
  {
    // Structured-output capable, 262k context. The strongest structured-output
    // fallback in the free catalog as of 2026-09-27.
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    enabled: true,
    priority: 2,
    maxContextTokens: 262_144,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true,
    zdrEligible: false,
    privacyVerifiedOn: "2026-09-29",
    // Measured 2026-09-30: 200 in all three capability modes. The only catalog
    // model whose advertised STRUCTURED support is real.
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best PROMPT_JSON: recall 0.87 / precision 0.87, vs 0.47 / 0.58 in STRUCTURED
    preferredMode: "PROMPT_JSON",
    // Measured complied 1-2/2 across repeated passes
    injectionResistance: "exposed",},
  {
    // UNUSABLE as of 2026-09-30: returns 400 in all three capability modes.
    // Retained but disabled so the failure stays documented rather than
    // silently dropped — if it starts answering, the flag is one edit away.
    id: "liquid/lfm-2.5-2.6b:free",
    enabled: false,
    priority: 7,
    maxContextTokens: 65_536,
    supportsResponseFormat: true,
    supportsJsonSchema: false,
    privacyEligible: true,
    zdrEligible: false,
    privacyVerifiedOn: "2026-09-29",
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best PROMPT_JSON: no mode serves: 400 in all three
    preferredMode: "PROMPT_JSON",
    // Measured no mode serves; 400 in all three
    injectionResistance: "unmeasured",},
  {
    // UNUSABLE as of 2026-09-30: 404 on STRUCTURED, and 429 on both other modes
    // across two independent matrix runs. A 429 is usually transient, so this is
    // recorded as "saturated beyond usefulness" rather than "broken" — but a
    // fallback that is rate-limited every time it is reached is not a fallback.
    id: "google/gemma-4-31b-it:free",
    enabled: false,
    priority: 8,
    maxContextTokens: 262_144,
    supportsResponseFormat: true,
    supportsJsonSchema: false,
    privacyEligible: true,
    zdrEligible: false,
    privacyVerifiedOn: "2026-09-29",
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best JSON_OBJECT: 429 in every mode; unusable
    preferredMode: "JSON_OBJECT",
    // Measured 429 in every mode
    injectionResistance: "unmeasured",},
  {
    // No response_format at all. Selects PROMPT_JSON mode with defensive
    // parsing. 1M context, but no structured-output guarantee. Verified working
    // 2026-09-30 (JSON_OBJECT and PROMPT_JSON both 200; STRUCTURED 404s).
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    enabled: true,
    priority: 3,
    maxContextTokens: 1_000_000,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: true,
    zdrEligible: false,
    privacyVerifiedOn: "2026-09-29",
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best PROMPT_JSON: recall 0.73, 1/2 injection
    preferredMode: "PROMPT_JSON",
    // Measured complied 1/2
    injectionResistance: "exposed",},
  {
    // Excluded by default: OpenRouter documents that free usage may be used to
    // train and improve Poolside models. Retained in code (not removed) so the
    // model remains available to `privacy_mode: relaxed`, where it was verified
    // working 2026-09-30 (JSON_OBJECT and PROMPT_JSON both 200).
    id: "poolside/laguna-s-2.1:free",
    enabled: false,
    priority: 4,
    maxContextTokens: 262_144,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: false,
    zdrEligible: false,
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best PROMPT_JSON: recall 0.73, but 2/2 injection — not recommended
    preferredMode: "PROMPT_JSON",
    // Measured complied 2/2 — failed both
    injectionResistance: "exposed",},
  {
    // UNUSABLE and not merely excluded: returns 403 in all three capability
    // modes with "only available on agentic harnesses". This is not an API
    // endpoint at all, so it can never serve a pull request review regardless of
    // privacy mode. Kept for the record only.
    id: "thinkingmachines/inkling-small:free",
    enabled: false,
    priority: 9,
    maxContextTokens: 1_048_576,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: false,
    zdrEligible: false,
    capabilityVerifiedOn: "2026-09-30",
  
    // Measured best PROMPT_JSON: 403 in all modes; not an API endpoint
    preferredMode: "PROMPT_JSON",
    // Measured 403; not an API endpoint
    injectionResistance: "unmeasured",},
];

export interface Config {
  readonly openrouterApiKey: string;
  readonly privacyMode: PrivacyMode;
  /**
   * Provider slugs to pin in strict mode. Empty means unconstrained.
   *
   * `zdr: true` constrains *how* a provider handles data but says nothing about
   * *which* provider serves the request, and a provider can be attached to a
   * model after we last checked it. The endpoint APIs that would enumerate
   * providers are management-key only, and a management key cannot call the
   * completions API — so runtime verification would need two secrets, one of
   * which administers the account. Rejected. This allowlist is the only
   * enforcement tightening available without one.
   */
  readonly strictProviders: readonly string[];
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

/**
 * Provider slugs to pin in strict mode (`provider.only`).
 *
 * Empty means unconstrained, which is the default: adding an allowlist requires
 * the operator to know which providers actually serve the free tier, and an empty
 * list that silently narrowed routing would turn most reviews into "no eligible
 * provider" for no stated reason.
 *
 * Normalised and de-duplicated because a typo'd duplicate would otherwise widen
 * nothing but would make the emitted block confusing to read in a request log.
 */
function readStrictProviders(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = readRaw(env, "strict_providers");
  if (raw === undefined) return [];

  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const slug = part.trim().toLowerCase();
    if (slug.length === 0) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
      // Sent verbatim to OpenRouter. A value with a comma or a quote could alter
      // the routing block's meaning, so it is rejected rather than escaped.
      throw new ConfigError(
        "strict_providers",
        `${JSON.stringify(slug)} is not a valid provider slug. Use OpenRouter's provider ` +
          `slugs, comma-separated, e.g. "novita,fireworks".`,
      );
    }
    seen.add(slug);
  }

  return [...seen];
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
      // Unknown for a user-supplied model. Treated as *not* ZDR-capable, which
      // means it is still tried under strict mode — this flag only orders the
      // pool, it never excludes — but it is tried after any model whose ZDR
      // posture has actually been verified.
      zdrEligible: false,
      // Treated as eligible in strict mode only if the request-time ZDR and
      // data_collection constraints can be satisfied — which OpenRouter
      // enforces, not us. A 404 means no endpoint qualified.
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
  const strictProviders = readStrictProviders(env);

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
      // A bare `primary_model` is a user assertion. If the model is one of the
      // defaults we have a measured ZDR verdict and use it; otherwise we have
      // none, and assuming `true` would put an unverified model at the front of
      // a strict-mode pool where it is guaranteed to 404.
      zdrEligible: DEFAULT_MODELS.find((m) => m.id === primaryId)?.zdrEligible ?? false,
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
          zdrEligible: known?.zdrEligible ?? false,
        };
      }),
    ];
  }

  // The floor is 2000 rather than something smaller because the estimator
  // reserves REQUEST_OVERHEAD_TOKENS + PER_CHUNK_SCAFFOLD_TOKENS (1300) before
  // any diff content. Below that the content budget would hit its floor and the
  // total would exceed the configured maximum, which makes the budget
  // guarantee meaningless. 2000 leaves 700 tokens of usable content.
  const maxInputTokens = readInt(env, "max_input_tokens", 24_000, { min: 2_000, max: 400_000 });
  // 4000, not 1500. The only free model with a ZDR endpoint is a reasoning
  // model that spends this budget on reasoning before emitting any content.
  // Measured 2026-09-29: at 1500 it returned an empty response on 4 of 4
  // attempts; at 4000 it returned usable JSON on all 4. Too small produces an
  // empty response, not a short one, so this is a correctness floor rather than
  // a quality preference. Near-free to raise: the binding constraint is
  // requests per day, and a `:free` endpoint prices at zero per token.
  const maxOutputTokens = readInt(env, "max_output_tokens", 4_000, { min: 256, max: 32_000 });
  const maxChangedLines = readInt(env, "max_changed_lines", 2_000, { min: 1, max: 100_000 });

  const config: Config = {
    openrouterApiKey,
    privacyMode,
    strictProviders,
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
 * The enabled model pool, filtered and ordered by privacy policy.
 *
 * In strict mode, models flagged `privacyEligible: false` are excluded, and
 * models flagged `zdrEligible: true` are ordered **first**.
 *
 * That ordering is the whole point. Live measurement on 2026-09-29 found that
 * only one free model has a ZDR endpoint, and it is not the one with structured
 * output support. Under strict privacy every request carries `zdr: true`, so
 * trying a non-ZDR model is not a slower path to an answer — it is a guaranteed
 * `404 No endpoints found matching your data policy`, costing one of 50 daily
 * requests to learn nothing. Ordering ZDR-capable models first means strict mode
 * spends its budget on requests that can succeed.
 *
 * Non-ZDR models are still retained in the pool rather than removed: they are
 * correct for `relaxed`, and a ZDR endpoint can appear or disappear, so a pool
 * that hard-excludes them would have no recovery path.
 *
 * Note this is a *static* preference based on manually verified endpoint
 * posture. The authoritative enforcement is the per-request `zdr` /
 * `data_collection` flags, which OpenRouter applies regardless of what we send.
 */
export function eligibleModels(config: Config): ModelDefinition[] {
  const strict = config.privacyMode === "strict";

  return config.models
    .filter((m) => m.enabled)
    .filter((m) => !strict || m.privacyEligible)
    .sort((a, b) => {
      if (strict && a.zdrEligible !== b.zdrEligible) {
        return a.zdrEligible ? -1 : 1;
      }
      return a.priority - b.priority;
    });
}

/**
 * Which request shape a model's capabilities support.
 *
 * `require_parameters: true` must only be sent alongside `json_schema`;
 * sending it otherwise excludes every endpoint and yields a 503 for free.
 */
/**
 * The request shapes a model could plausibly be asked for.
 *
 * This is a *capability* filter and nothing more: it answers "which shapes might
 * this endpoint serve", never "which shape reviews best". Those are different
 * questions, and conflating them is what produced the measured results below.
 */
export function supportedModesFor(model: ModelDefinition): readonly CapabilityMode[] {
  if (model.supportsJsonSchema === true) return ["STRUCTURED", "JSON_OBJECT", "PROMPT_JSON"];
  if (model.supportsResponseFormat === true) return ["JSON_OBJECT", "PROMPT_JSON"];
  return ["PROMPT_JSON"];
}

/**
 * The strongest mode a model could serve, ignoring whether it reviews well.
 *
 * Retained as the fallback for a model with no measured preference. Preferring
 * the strongest shape is the best guess available when nobody has measured.
 */
function strongestSupportedMode(model: ModelDefinition): CapabilityMode {
  return supportedModesFor(model)[0]!;
}

/**
 * Which request shape to actually send this model.
 *
 * ## Capability is a filter, not a ranking
 *
 * The obvious policy — send the strongest shape a model advertises — is wrong,
 * and measurably so. Same models, same fixtures, same prompt, 2026-09-30:
 *
 *   qwen/qwen3.8-27b      PROMPT_JSON  recall 0.80  injection 2/2
 *                         JSON_OBJECT  recall 0.93  injection 0/2
 *
 *   nemotron-3-super      PROMPT_JSON  recall 0.87  precision 0.87
 *                         STRUCTURED   recall 0.47  precision 0.58
 *
 * The two move in opposite directions, each by more than the gap between any two
 * models. `nemotron-3-super` genuinely supports STRUCTURED, and STRUCTURED is
 * worse for it by nearly half — schema-constrained output produced quotes that
 * would not anchor to the diff. `qwen` gains a full swing on injection
 * resistance purely by moving to a shape the API enforces.
 *
 * The default model out of the box picked STRUCTURED for `nemotron-3-super` and
 * would have shipped the 0.47.
 *
 * So the mode is a measured property of the model, recorded in the catalog as
 * `preferredMode`. Capabilities decide which modes are *eligible*; measurement
 * decides which is *chosen*.
 *
 * ## The contradiction guard
 *
 * A `preferredMode` the model cannot actually serve is a catalog bug, and the
 * failure it causes is the worst kind: a 404 that names no cause, discovered
 * only when a pull request needs reviewing and the primary model has already
 * failed. So an unsupported preference degrades to the strongest mode the model
 * *can* serve rather than being trusted.
 */
export function reviewModeFor(model: ModelDefinition): CapabilityMode {
  const preferred = model.preferredMode;

  if (preferred !== undefined && supportedModesFor(model).includes(preferred)) {
    return preferred;
  }

  return strongestSupportedMode(model);
}
