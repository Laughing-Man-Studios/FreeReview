/**
 * OpenRouter error classification.
 *
 * OpenRouter publishes a stable `error.metadata.error_type` vocabulary and
 * documents it as the field to switch on, because the HTTP status alone is
 * lossy. That matters concretely here: a 503 means either "no provider matched
 * your routing constraints" (permanent for this model, fall back and move on) or
 * "the provider is overloaded" (retry the same model). Treating both as
 * "retryable" burns the 50/day allowance on a request that could never succeed.
 *
 * Two classification bugs found during Phase 1 smoke-testing are encoded in the
 * tests here:
 *
 *  - HTTP 401 was unclassified, fell through to "client", and became a
 *    non-blocking skip. A bad token produced a green run that had reviewed
 *    nothing.
 *  - A non-streaming request can return HTTP 200 with an `error` object in the
 *    body and no usable `choices`. Checking only the status produces a silent
 *    empty review.
 */

/** The documented `error_type` vocabulary, as far as this action cares. */
export type OpenRouterErrorType =
  | "rate_limit_exceeded"
  | "provider_overloaded"
  | "provider_unavailable"
  | "timeout"
  | "server"
  | "unmapped"
  | "authentication"
  | "payment_required"
  | "permission_denied"
  | "content_policy_violation"
  | "refusal"
  | "not_found"
  | "context_length_exceeded"
  | "max_tokens_exceeded"
  | "token_limit_exceeded"
  | "string_too_long"
  | "invalid_request"
  | "invalid_prompt"
  | "payload_too_large"
  | "unprocessable"
  | "precondition_failed";

/**
 * How the scheduler should react.
 *
 * Deliberately coarse. The scheduler needs to know three things: is retrying
 * worthwhile, should we try a different model, and is this fatal.
 */
export type OpenRouterFailure =
  /** Retry the same model after a backoff. */
  | "retryable"
  /** Advance to the next eligible model without retrying. */
  | "fallback"
  /** Nothing will help. Abort the run. */
  | "fatal"
  /** The request is fine; the failure is in what came back. */
  | "response_invalid";

export interface OpenRouterErrorInit {
  readonly httpStatus: number;
  readonly errorType: OpenRouterErrorType | null;
  readonly message: string;
  readonly retryAfterSeconds?: number | undefined;
  readonly modelId: string;
  /** From router metadata. 0 means no endpoint ever received the request. */
  readonly attempt?: number | undefined;
  readonly limitSource?: string | undefined;
}

export class OpenRouterError extends Error {
  readonly httpStatus: number;
  readonly errorType: OpenRouterErrorType | null;
  readonly retryAfterSeconds: number | undefined;
  readonly modelId: string;
  readonly attempt: number | undefined;
  readonly limitSource: string | undefined;

  constructor(init: OpenRouterErrorInit) {
    super(init.message);
    this.name = "OpenRouterError";
    this.httpStatus = init.httpStatus;
    this.errorType = init.errorType;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.modelId = init.modelId;
    this.attempt = init.attempt;
    this.limitSource = init.limitSource;
  }

  get failure(): OpenRouterFailure {
    return classify(this);
  }

  /**
   * Whether the model itself is unusable for this configuration.
   *
   * True when routing found no endpoint at all, which usually means a privacy or
   * capability constraint excluded every provider rather than a transient blip.
   * Those cases must advance to a different model, not retry the same one.
   */
  get noEligibleProvider(): boolean {
    // `attempt === 0` is router metadata's signal that the request never
    // reached a provider, i.e. every candidate was filtered out first.
    if (this.attempt === 0) return true;
    if (this.errorType === "not_found") return true;
    // 503 is overloaded OR unroutable; router metadata disambiguates.
    if (this.httpStatus === 503 && this.attempt === 0) return true;
    return false;
  }

  /** Short, safe, non-source-bearing summary for logs and diagnostics. */
  summary(): string {
    const parts = [`status=${this.httpStatus}`];
    if (this.errorType) parts.push(`type=${this.errorType}`);
    if (this.attempt !== undefined) parts.push(`attempt=${this.attempt}`);
    if (this.retryAfterSeconds !== undefined) parts.push(`retry_after=${this.retryAfterSeconds}s`);
    return parts.join(" ");
  }
}

const RETRYABLE: ReadonlySet<OpenRouterErrorType> = new Set<OpenRouterErrorType>([
  "rate_limit_exceeded",
  "provider_overloaded",
  "provider_unavailable",
  "timeout",
  "server",
  "unmapped",
]);

const FALLBACK: ReadonlySet<OpenRouterErrorType> = new Set<OpenRouterErrorType>([
  "not_found",
]);

const FATAL: ReadonlySet<OpenRouterErrorType> = new Set<OpenRouterErrorType>([
  // A bad or revoked key is an operator problem, and retrying it is pointless.
  "authentication",
  "permission_denied",
  "content_policy_violation",
  "refusal",
  "invalid_request",
  "invalid_prompt",
  "context_length_exceeded",
  "max_tokens_exceeded",
  "token_limit_exceeded",
  "string_too_long",
  "payload_too_large",
  "unprocessable",
  "precondition_failed",
]);

export function classify(error: OpenRouterError): OpenRouterFailure {
  // No eligible endpoint is a routing outcome, not a transport failure, and it
  // is decided before the error_type check: a 503 with attempt 0 is documented
  // as "no available provider meets your routing requirements".
  if (error.noEligibleProvider) return "fallback";

  const type = error.errorType;

  if (type === "payment_required") {
    // 402 is fatal unless the request was rejected by the in-flight spending
    // budget, which is transient and carries a Retry-After. Everything else
    // means the account is out of credits, which a $0 action must never hit.
    return error.limitSource === "openrouter_in_flight_budget" ? "retryable" : "fatal";
  }

  if (type !== null && RETRYABLE.has(type)) return "retryable";
  if (type !== null && FALLBACK.has(type)) return "fallback";
  if (type !== null && FATAL.has(type)) return "fatal";

  // No usable error_type. Fall back to the status code, deliberately erring
  // towards NOT retrying: an unclassifiable failure is more likely a
  // misconfiguration than a blip, and a pointless retry costs quota.
  if (error.httpStatus === 429) return "retryable";
  if (error.httpStatus >= 500) return "retryable";
  if (error.httpStatus === 401 || error.httpStatus === 403) return "fatal";
  if (error.httpStatus === 404) return "fallback";

  return "fatal";
}

/** The error body shape OpenRouter returns. */
export interface OpenRouterErrorBody {
  error?: {
    code?: number;
    message?: string;
    metadata?: Record<string, unknown>;
  };
  openrouter_metadata?: {
    attempt?: number;
    strategy?: string;
  };
}

/**
 * Build a typed error from a response body.
 *
 * Called for non-OK statuses and for HTTP 200 responses that carry an error in
 * the body, which is how a mid-generation provider failure arrives on a
 * non-streaming request.
 */
export function errorFromBody(
  body: unknown,
  httpStatus: number,
  modelId: string,
  retryAfterHeader?: string | null,
): OpenRouterError {
  const envelope = (typeof body === "object" && body !== null ? body : {}) as OpenRouterErrorBody;
  const inner = envelope.error ?? {};
  const metadata = inner.metadata ?? {};

  const rawType = metadata["error_type"];
  const errorType = typeof rawType === "string" ? (rawType as OpenRouterErrorType) : null;

  const attemptRaw = envelope.openrouter_metadata?.attempt;
  const attempt = typeof attemptRaw === "number" ? attemptRaw : undefined;

  const limitSourceRaw = metadata["limit_source"];
  const limitSource = typeof limitSourceRaw === "string" ? limitSourceRaw : undefined;

  const parsed = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;

  return new OpenRouterError({
    httpStatus,
    errorType,
    message: inner.message ?? `OpenRouter returned ${httpStatus}`,
    retryAfterSeconds: Number.isFinite(parsed) ? parsed : undefined,
    modelId,
    attempt,
    limitSource,
  });
}

/**
 * Whether a 200 response actually carries usable output.
 *
 * A non-streaming request whose provider fails after the response headers were
 * sent returns 200 with an `error` and no `choices`. Treating that as success
 * yields a review of nothing that looks clean.
 */
export function isErrorBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const envelope = body as OpenRouterErrorBody & {
    choices?: { error?: unknown }[];
  };
  if (envelope.error !== undefined) return true;
  const first = envelope.choices?.[0];
  return first?.error !== undefined;
}

/**
 * Why a 200 response carried no usable content.
 *
 * Two cases that look identical to a naive check and need opposite handling:
 *
 *  - The model was warming up, or the provider returned nothing. Retrying helps.
 *  - The model spent the whole `max_tokens` budget on reasoning tokens. OpenRouter
 *    documents that retrying does *not* help; the fix is a larger output budget.
 *
 * Conflating them means either wasting a request on an unfixable case, or
 * abandoning a finding that a single retry would have found.
 */
export function emptyOutputReason(body: unknown): "retryable" | "truncated" | "empty" {
  if (typeof body !== "object" || body === null) return "empty";

  const choices = (body as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] })
    .choices;
  const first = choices?.[0];
  const finishReason = first?.finish_reason;
  const content = first?.message?.content;

  if (finishReason === "length") return "truncated";

  const usage = (body as { usage?: { completion_tokens_details?: { reasoning_tokens?: number }; completion_tokens?: number } })
    .usage;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  const completion = usage?.completion_tokens ?? 0;

  // A reasoning model that consumed its entire budget explains an empty
  // completion without being a transport failure.
  if (typeof reasoning === "number" && completion > 0 && reasoning >= completion * 0.9) {
    return "truncated";
  }

  if (finishReason === "stop" && (typeof content !== "string" || content.trim().length === 0)) {
    return "retryable";
  }

  return "empty";
}
