/**
 * OpenRouter client.
 *
 * The only module permitted to construct a chat-completions request. Everything
 * that talks to OpenRouter goes through here, and the scheduler owns the budget.
 *
 * ## The $0 guarantee
 *
 * Three independent controls, any one of which is sufficient to prevent a paid
 * request. All three are in this file or `config.ts`, and each has a test that
 * fails if it is removed.
 *
 * 1. **Config-time regex.** A model ID that does not end in `:free` is rejected
 *    before any network call (`config.ts`).
 * 2. **Per-request assertion.** Every request re-checks `model.endsWith(":free")`
 *    and throws rather than sending.
 * 3. **`provider.max_price` pinned to zero.** OpenRouter *enforces* this: the
 *    docs are explicit that `max_price` prevents the request from running, in
 *    contrast to `preferred_*`, which only deprioritises. This is the control
 *    that holds even if the other two are bypassed by a future refactor, because
 *    it is enforced server-side rather than by us.
 *
 * No `models: [...]` array and no `openrouter/free` router is ever sent: every
 * request names exactly one explicit model, which is what makes the fallback
 * sequence under our control and the evaluation reproducible.
 *
 * ## Privacy
 *
 * In `strict` mode the request carries `zdr: true` and
 * `data_collection: "deny"`. OpenRouter then routes only to endpoints that meet
 * the constraint; if none qualify it returns 503/404 with `attempt === 0`, which
 * the scheduler reads as a reason to try the next model rather than to retry.
 *
 * An honest limitation: the per-endpoint privacy metadata APIs require a
 * management key, so the serving provider cannot be independently verified at
 * runtime. We enforce the constraint and delegate to OpenRouter. See SECURITY.md.
 */

import type { Config } from "../config.js";
import { reviewModeFor, type ModelDefinition } from "../config.js";
import type { CapabilityMode, RawFindingsResponse } from "../types.js";
import { emptyOutputReason, errorFromBody, isErrorBody, OpenRouterError } from "./errors.js";

export const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
export const MODELS_URL = "https://openrouter.ai/api/v1/models";
export const KEY_URL = "https://openrouter.ai/api/v1/key";

export const ROUTER_METADATA_HEADER = "X-OpenRouter-Metadata";

/**
 * Seed for reproducible evaluation.
 *
 * Fixed so a benchmark run is comparable across sessions. Not all free endpoints
 * support `seed`, and an unsupported parameter is ignored rather than rejected by
 * OpenRouter, so this is best-effort by design.
 */
export const EVAL_SEED = 20_260_928;

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface JsonSchemaDefinition {
  readonly name: string;
  readonly strict: true;
  readonly schema: Record<string, unknown>;
}

export interface ChatRequest {
  readonly model: ModelDefinition;
  readonly messages: readonly ChatMessage[];
  readonly mode: CapabilityMode;
  readonly schema?: JsonSchemaDefinition | undefined;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal | undefined;
}

export interface Usage {
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
}

export interface RouterMetadata {
  readonly attempt?: number | undefined;
  readonly strategy?: string | undefined;
  readonly region?: string | undefined;
  readonly provider?: string | undefined;
  readonly isByok?: boolean | undefined;
}

export interface ChatResult {
  readonly content: string;
  readonly finishReason: string | null;
  readonly usage: Usage;
  readonly router: RouterMetadata;
  /** Parsed structured output, when the mode and the response allowed it. */
  readonly parsed: RawFindingsResponse | null;
  /** Populated when the call succeeded at the transport level. */
  readonly modelId: string;
}

export interface OpenRouterClientOptions {
  readonly config: Config;
  readonly fetchImpl?: typeof fetch;
  /** Injected for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the provider routing block.
 *
 * ## The privacy gap this does not close, and the one it partly does
 *
 * `zdr: true` and `data_collection: "deny"` are *constraints*, not a guarantee
 * about identity. OpenRouter routes to any endpoint meeting them, and a provider
 * can be attached to a model after the date we last checked it. The endpoint APIs
 * that would let us enumerate and pin providers return 403 for anything short of a
 * management key, and a management key cannot call the completions API — so
 * verifying provider identity at runtime would cost two secrets and an
 * account-admin credential. Rejected; see SECURITY.md.
 *
 * `provider.only` is the only enforcement tightening available without one. It
 * converts "any provider meeting the constraint" into "these named providers",
 * so a provider attached *after* verification cannot be selected unless it is on
 * the list.
 *
 * The trade is availability: a provider that stops serving `:free` ends the
 * review rather than silently switching to an unverified one. At 8 requests per
 * run that is the right way round — an unavailable reviewer is visible, an
 * unverified one is not.
 */
export function buildProviderBlock(config: Config, mode: CapabilityMode): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    // Guard 3: a hard filter OpenRouter enforces by refusing to route. A `:free`
    // endpoint prices at zero per token, so this excludes every paid endpoint
    // without excluding the ones we want.
    max_price: { prompt: "0", completion: "0", request: "0" },
  };

  if (config.privacyMode === "strict") {
    provider["zdr"] = true;
    provider["data_collection"] = "deny";

    // Only ever in strict. Pinning providers under `relaxed` would imply a
    // privacy guarantee the caller has explicitly opted out of.
    if (config.strictProviders.length > 0) {
      provider["only"] = [...config.strictProviders];
    }
  }

  // `require_parameters: true` excludes every endpoint that does not support
  // all parameters in the request. Sending it WITHOUT json_schema would exclude
  // every endpoint and produce a 503 for free, so it is only ever sent alongside
  // a schema the selected model is known to support.
  if (mode === "STRUCTURED") provider["require_parameters"] = true;

  return provider;
}

export class OpenRouterClient {
  private readonly config: Config;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OpenRouterClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** Guard 2: assert the model is free, or refuse to send. */
  private assertFree(model: ModelDefinition): void {
    if (!model.id.endsWith(":free")) {
      throw new OpenRouterError({
        httpStatus: 0,
        errorType: "invalid_request",
        modelId: model.id,
        message:
          `Refusing to request non-free model '${model.id}'. This action never routes ` +
          "to a paid model; the $0 guarantee is not configurable.",
      });
    }
  }

  buildBody(request: ChatRequest): Record<string, unknown> {
    const mode = request.mode;

    const body: Record<string, unknown> = {
      model: request.model.id,
      stream: false,
      // Determinism matters for evaluation: a run has to be reproducible, and
      // greedy decoding is the closest a chat API gets to that.
      temperature: 0,
      top_p: 1,
      seed: EVAL_SEED,
      max_tokens: request.maxOutputTokens,
      messages: request.messages,
      provider: buildProviderBlock(this.config, mode),
    };

    if (mode === "STRUCTURED" && request.schema !== undefined) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: request.schema.name,
          strict: request.schema.strict,
          schema: request.schema.schema,
        },
      };
    } else if (mode === "JSON_OBJECT") {
      // The model accepts response_format but not strict schema enforcement.
      // This is the Gemma-4 free case.
      body["response_format"] = { type: "json_object" };
    }
    // PROMPT_JSON sends no response_format at all; the prompt carries the
    // contract and the parser defends against it.

    return body;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.config.referer,
      "X-OpenRouter-Title": this.config.title,
      // Surfaces which provider actually served the request, so the run has an
      // audit trail and internal provider fallback is visible. Absent on cache
      // replays and on 500s.
      [ROUTER_METADATA_HEADER]: "enabled",
    };
  }

  /**
   * Send one chat completion.
   *
   * No retry here. Retries belong to the scheduler, which owns the budget and
   * must count every attempt; a hidden retry inside the client would spend quota
   * the scheduler does not know about.
   */
  async complete(request: ChatRequest): Promise<ChatResult> {
    this.assertFree(request.model);

    const body = this.buildBody(request);

    let response: Response;
    try {
      response = await this.fetchImpl(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new OpenRouterError({
        httpStatus: 0,
        errorType: "timeout",
        modelId: request.model.id,
        message: cause instanceof Error ? cause.message : "network failure",
      });
    }

    const payload = await readJson(response);

    if (!response.ok) {
      throw errorFromBody(
        payload,
        response.status,
        request.model.id,
        response.headers.get("retry-after"),
      );
    }

    // A non-streaming provider failure can arrive as HTTP 200 with an error body
    // and no usable choices. Checking the status alone yields a silent empty
    // review, which is indistinguishable from "no findings".
    if (isErrorBody(payload)) {
      throw errorFromBody(
        payload,
        // Synthesise a 5xx so the classification machinery sees a server-side
        // failure rather than a success.
        500,
        request.model.id,
        response.headers.get("retry-after"),
      );
    }

    const envelope = (payload ?? {}) as {
      choices?: {
        message?: { content?: string | null };
        finish_reason?: string | null;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      openrouter_metadata?: {
        attempt?: number;
        strategy?: string;
        region?: string;
        endpoints?: { available?: { provider?: string }[] };
        is_byok?: boolean;
      };
    };

    const choice = envelope.choices?.[0];
    const content = choice?.message?.content ?? "";

    if (content.trim().length === 0) {
      const reason = emptyOutputReason(payload);
      // A truncated response is not retryable. OpenRouter documents that a
      // reasoning model which spent its budget on reasoning tokens will not
      // produce content on a retry; the fix is a larger output budget.
      throw new OpenRouterError({
        httpStatus: 200,
        errorType: reason === "truncated" ? "max_tokens_exceeded" : "server",
        modelId: request.model.id,
        message:
          reason === "truncated"
            ? "The model consumed its entire output budget on reasoning tokens and produced no content. " +
              "Retrying will not help; raise max_output_tokens."
            : "The model returned no content.",
      });
    }

    return {
      content,
      finishReason: choice?.finish_reason ?? null,
      usage: {
        promptTokens: envelope.usage?.prompt_tokens,
        completionTokens: envelope.usage?.completion_tokens,
        totalTokens: envelope.usage?.total_tokens,
        reasoningTokens: envelope.usage?.completion_tokens_details?.reasoning_tokens,
      },
      router: {
        attempt: envelope.openrouter_metadata?.attempt,
        strategy: envelope.openrouter_metadata?.strategy,
        region: envelope.openrouter_metadata?.region,
        provider: envelope.openrouter_metadata?.endpoints?.available?.find((e) => e.provider !== undefined)
          ?.provider,
        isByok: envelope.openrouter_metadata?.is_byok,
      },
      parsed: parseStructured(content),
      modelId: request.model.id,
    };
  }
}

function parseStructured(content: string): RawFindingsResponse | null {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value === "object" && value !== null) return value as RawFindingsResponse;
    return null;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Which request shape to send this model: a measured preference, else capability. */
export function modeFor(model: ModelDefinition): CapabilityMode {
  return reviewModeFor(model);
}
