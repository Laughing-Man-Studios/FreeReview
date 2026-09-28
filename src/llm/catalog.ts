/**
 * Runtime model-catalog and quota probes.
 *
 * Both endpoints cost nothing against the request allowance, and both exist to
 * stop the action from spending a request it could have known was a waste.
 *
 * ## Why the catalog is probed rather than trusted
 *
 * The free-model catalog churns. A configured model can disappear, stop being
 * free, or lose a capability between one run and the next. Sending a request to
 * a model that has stopped supporting `json_schema` wastes one of 50 daily
 * requests and, with `require_parameters: true`, produces a 503 rather than a
 * graceful degradation.
 *
 * **Free is verified, not assumed.** `pricing.prompt === "0"` is checked, so a
 * `:free` variant that OpenRouter has quietly repriced is rejected here.
 *
 * ## What cannot be verified
 *
 * Per-endpoint privacy metadata (`/models/{author}/{slug}/endpoints`,
 * `/endpoints/zdr`) requires a management key and returns 403 to a normal API
 * key. The action therefore cannot check at runtime which provider served a
 * request, and relies on the per-request `zdr` / `data_collection` constraints
 * plus a manually curated pool. This is stated in SECURITY.md rather than
 * papered over.
 */

import type { Config, ModelDefinition } from "../config.js";
import { KEY_URL, MODELS_URL } from "./client.js";
import type { CapabilityMode } from "../types.js";

export interface CatalogModel {
  readonly id: string;
  readonly context_length?: number;
  readonly pricing?: { prompt?: string; completion?: string; request?: string };
  readonly supported_parameters?: readonly string[];
}

export interface CatalogEntry {
  readonly model: CatalogModel | null;
  readonly exists: boolean;
  readonly isFree: boolean;
  readonly supportsJsonSchema: boolean;
  readonly supportsResponseFormat: boolean;
  readonly contextLength: number | null;
  /** Why this model is not usable, if it is not. */
  readonly problem: string | null;
}

export interface QuotaState {
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly used: number | null;
  /** Whether this account has ever purchased credits. */
  readonly isFreeTier: boolean;
}

export interface ProbesOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Fetch the model catalog.
 *
 * Non-fatal by design: a probe failure must not disable the reviewer, so the
 * caller falls back to the configured assumptions. `null` means "could not tell".
 */
export async function fetchCatalog(options: ProbesOptions = {}): Promise<CatalogModel[] | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(MODELS_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: CatalogModel[] };
    return Array.isArray(body.data) ? body.data : null;
  } catch {
    return null;
  }
}

/**
 * Evaluate one configured model against the catalog.
 *
 * When the catalog is unavailable, the entry reports `model: null` and no
 * problem: the action proceeds with its configured assumptions rather than
 * refusing to review.
 */
export function evaluateModel(
  model: ModelDefinition,
  catalog: readonly CatalogModel[] | null,
  required: { inputTokens: number; outputTokens: number; mode: CapabilityMode },
): CatalogEntry {
  if (catalog === null) {
    return {
      model: null,
      exists: true,
      isFree: true,
      supportsJsonSchema: model.supportsJsonSchema ?? false,
      supportsResponseFormat: model.supportsResponseFormat ?? false,
      contextLength: model.maxContextTokens,
      problem: null,
    };
  }

  const found = catalog.find((entry) => entry.id === model.id);
  if (found === undefined) {
    return {
      model: null,
      exists: false,
      isFree: false,
      supportsJsonSchema: false,
      supportsResponseFormat: false,
      contextLength: null,
      problem: "The model is no longer present in the OpenRouter catalog.",
    };
  }

  // Free is verified, never assumed. A `:free` id is not proof of a zero price.
  const promptPrice = found.pricing?.prompt;
  const completionPrice = found.pricing?.completion;
  const isFree = promptPrice === "0" && completionPrice === "0";
  if (!isFree) {
    return {
      model: found,
      exists: true,
      isFree: false,
      supportsJsonSchema: false,
      supportsResponseFormat: false,
      contextLength: found.context_length ?? null,
      problem:
        `The model is listed but not priced at zero (prompt=${promptPrice ?? "?"}, ` +
        `completion=${completionPrice ?? "?"}). A $0 action will not use it.`,
    };
  }

  const parameters = new Set(found.supported_parameters ?? []);
  const supportsJsonSchema = parameters.has("structured_outputs");
  const supportsResponseFormat = parameters.has("response_format");

  // The catalog reports the union across endpoints. `require_parameters: true`
  // filters to endpoints that actually support the parameter, so a model can
  // advertise a capability with no endpoint providing it — which yields a 503.
  if (required.mode === "STRUCTURED" && !supportsJsonSchema) {
    return {
      model: found,
      exists: true,
      isFree: true,
      supportsJsonSchema: false,
      supportsResponseFormat,
      contextLength: found.context_length ?? null,
      problem:
        "The model does not advertise structured_outputs, so a strict JSON schema " +
        "cannot be enforced. It would be selected in json_object mode instead.",
    };
  }

  const contextLength = found.context_length ?? null;
  const needed = required.inputTokens + required.outputTokens;
  if (contextLength !== null && contextLength < needed) {
    return {
      model: found,
      exists: true,
      isFree: true,
      supportsJsonSchema,
      supportsResponseFormat,
      contextLength,
      problem:
        `The model's context window is ${contextLength} tokens, below the ${needed} this ` +
        "configuration requires.",
    };
  }

  return {
    model: found,
    exists: true,
    isFree: true,
    supportsJsonSchema,
    supportsResponseFormat,
    contextLength,
    problem: null,
  };
}

/**
 * Read the remaining free-model allowance for the current UTC day.
 *
 * Prevents knowingly walking into a 429. The daily counter includes failed
 * requests, so a run that starts at `remaining: 2` and budgets 8 would spend the
 * day's allowance on four rejected attempts.
 */
export async function fetchQuota(
  config: Config,
  options: ProbesOptions = {},
): Promise<QuotaState | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(KEY_URL, {
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      data?: {
        is_free_tier?: boolean;
        free_model_daily_requests?: { used?: number; limit?: number; remaining?: number };
      };
    };

    const daily = body.data?.free_model_daily_requests;
    return {
      remaining: daily?.remaining ?? null,
      limit: daily?.limit ?? null,
      used: daily?.used ?? null,
      isFreeTier: body.data?.is_free_tier ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether the run may start, given the remaining allowance.
 *
 * `reserve` keeps the last N requests of the day for manual and debug use. With
 * a default reserve of 10 against a 50/day allowance, a $0 action will not
 * consume the whole day on its own.
 *
 * An unreadable quota is not a stop condition. The per-run request budget still
 * applies, so proceeding is safe; refusing to review because a probe failed
 * would make the reviewer useless whenever OpenRouter has a bad minute.
 */
export function quotaDecision(
  quota: QuotaState | null,
  reserve: number,
  plannedRequests: number,
): { proceed: boolean; reason: string; diagnostic: "OPENROUTER_QUOTA_EXHAUSTED" | null } {
  if (quota === null) {
    return { proceed: true, reason: "Quota could not be read; relying on the per-run budget.", diagnostic: null };
  }

  if (quota.remaining === null) {
    return { proceed: true, reason: "Quota remaining unknown; relying on the per-run budget.", diagnostic: null };
  }

  const spendable = Math.max(0, quota.remaining - reserve);

  if (spendable <= 0) {
    return {
      proceed: false,
      reason:
        `The daily free-model allowance is exhausted (${quota.remaining} remaining of ` +
        `${quota.limit ?? "?"}, with ${reserve} reserved). It resets at UTC midnight.`,
      diagnostic: "OPENROUTER_QUOTA_EXHAUSTED",
    };
  }

  if (plannedRequests > spendable) {
    return {
      proceed: true,
      reason:
        `Only ${spendable} of the ${plannedRequests} planned request(s) fit within the ` +
        `remaining daily allowance (${quota.remaining} of ${quota.limit ?? "?"}, ` +
        `${reserve} reserved). The review will cover fewer files.`,
      diagnostic: null,
    };
  }

  return {
    proceed: true,
    reason: `${quota.remaining} of ${quota.limit ?? "?"} free-model requests remain today.`,
    diagnostic: null,
  };
}
