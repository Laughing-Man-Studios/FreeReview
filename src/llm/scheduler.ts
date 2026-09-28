/**
 * Request scheduler.
 *
 * The single owner of the request budget. No other module may call the client
 * directly, because the moment two code paths can send a request, nobody can
 * state how many requests a run will spend — and that number is the project's
 * binding constraint at 50 requests per day.
 *
 * ## Budget rules
 *
 * - **Every attempt counts.** A retry and a model fallback are each a real
 *   request that consumes daily allowance, and OpenRouter counts failed requests
 *   too. A retry hidden inside the client would spend quota the scheduler cannot
 *   see, so the client does not retry at all.
 * - **The run budget is hard.** `maxRequestsPerRun` includes retries and
 *   fallbacks. When it is exhausted the remaining work is abandoned, not
 *   attempted.
 * - **The daily reserve is untouchable.** The last N of the day's allowance is
 *   left for manual and debug use.
 * - **Concurrency is conservative.** Free endpoints are shared infrastructure;
 *   the default of 2 is about politeness as much as throughput.
 * - **Cancellation is immediate.** An in-flight request is aborted when the run
 *   is superseded, so a cancelled run stops spending quota at once rather than
 *   finishing work nobody will read.
 *
 * ## Fallback
 *
 * Fallback advances to the next eligible model on rate limiting, provider
 * unavailability, an unroutable request, and a missing model. It does **not**
 * happen because a model produced a valid but different answer — that would be
 * fan-out voting, which is unaffordable here and is not what this tool is.
 */

import type { Config, ModelDefinition } from "../config.js";
import type { ChatRequest, ChatResult, OpenRouterClient } from "./client.js";
import { OpenRouterError, type OpenRouterFailure } from "./errors.js";
import type { DiagnosticCode } from "../diagnostics.js";

export type TaskOutcome =
  | {
      readonly ok: true;
      readonly result: ChatResult;
      readonly requestsSpent: number;
      /**
       * Included on success too, not only on failure. A run that succeeded on
       * its second model after a rate limit is exactly the case a maintainer
       * needs explained, and the trail is what the step summary renders.
       */
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly ok: false;
      readonly failure: OpenRouterFailure;
      readonly error: OpenRouterError | null;
      readonly requestsSpent: number;
      readonly diagnostic: DiagnosticCode;
      readonly attempts: readonly AttemptRecord[];
    };

export interface AttemptRecord {
  readonly modelId: string;
  readonly outcome: "success" | OpenRouterFailure;
  readonly errorType: string | null;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds?: number | undefined;
  readonly willRetry: boolean;
  readonly willFallback: boolean;
}

export interface SchedulerOptions {
  readonly client: OpenRouterClient;
  readonly config: Config;
  /** Injected for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RunBudget {
  /** Total requests this run may still send, including retries. */
  readonly remaining: number;
  /** Requests already spent, across every task. */
  readonly spent: number;
  readonly limit: number;
  /** Requests left in today's allowance after the reserve. */
  readonly dailyRemaining: number | null;
}

const RETRYABLE_DIAGNOSTIC: DiagnosticCode = "OPENROUTER_RATE_LIMITED";
const FALLBACK_DIAGNOSTIC: DiagnosticCode = "NO_ELIGIBLE_PROVIDER";
const FATAL_DIAGNOSTIC: DiagnosticCode = "OPENROUTER_UNAVAILABLE";

/** Maximum single backoff wait, regardless of what the server suggests. */
const MAX_BACKOFF_MS = 30_000;

/** Maximum time honoured from a `Retry-After` header. */
const MAX_RETRY_AFTER_MS = 60_000;

export class Scheduler {
  private readonly client: OpenRouterClient;
  private readonly config: Config;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private spent = 0;
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];
  /** Timestamps of requests within the current minute, for the rate limiter. */
  private recent: number[] = [];
  private dailyRemaining: number | null = null;

  constructor(options: SchedulerOptions) {
    this.client = options.client;
    this.config = options.config;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  setDailyRemaining(remaining: number | null): void {
    this.dailyRemaining = remaining;
  }

  get budget(): RunBudget {
    const reserve = this.config.dailyReserve;
    const spendable = this.dailyRemaining === null ? null : Math.max(0, this.dailyRemaining - reserve);
    return {
      remaining: Math.max(0, Math.min(this.config.maxRequestsPerRun - this.spent, spendable ?? Infinity)),
      spent: this.spent,
      limit: this.config.maxRequestsPerRun,
      dailyRemaining: this.dailyRemaining,
    };
  }

  /**
   * Run one task, retrying and falling back within budget.
   *
   * `models` is the ordered eligible pool. The first model is tried first; later
   * entries are reached only through a failure that warrants it.
   */
  async runTask(
    request: Omit<ChatRequest, "model">,
    models: readonly ModelDefinition[],
    signal?: AbortSignal,
  ): Promise<TaskOutcome> {
    const attempts: AttemptRecord[] = [];
    const startedAt = this.spent;
    let lastError: OpenRouterError | null = null;
    let lastFailure: OpenRouterFailure = "fatal";

    for (const model of models) {
      for (let attempt = 0; attempt <= this.config.maxRetriesPerRequest; attempt += 1) {
        if (signal?.aborted === true) {
          return {
            ok: false,
            failure: "response_invalid",
            error: null,
            requestsSpent: this.spent - startedAt,
            diagnostic: "REQUEST_CANCELLED",
            attempts,
          };
        }

        const budget = this.budget;
        if (budget.remaining <= 0) {
          return {
            ok: false,
            failure: lastFailure,
            error: lastError,
            requestsSpent: this.spent - startedAt,
            diagnostic: "REQUEST_BUDGET_EXHAUSTED",
            attempts,
          };
        }

        let result: ChatResult;
        try {
          result = await this.send({ ...request, model }, signal);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return {
              ok: false,
              failure: "response_invalid",
              error: null,
              requestsSpent: this.spent - startedAt,
              diagnostic: "REQUEST_CANCELLED",
              attempts,
            };
          }

          if (!(error instanceof OpenRouterError)) throw error;

          lastError = error;
          lastFailure = error.failure;

          const canRetry = error.failure === "retryable" && attempt < this.config.maxRetriesPerRequest;
          const willFallback = error.failure === "fallback" || error.failure === "fatal";
          const wantsFallback = canRetry ? false : willFallback;

          attempts.push({
            modelId: model.id,
            outcome: error.failure,
            errorType: error.errorType,
            httpStatus: error.httpStatus,
            retryAfterSeconds: error.retryAfterSeconds,
            willRetry: canRetry,
            willFallback: wantsFallback,
          });

          if (error.failure === "fatal") {
            return {
              ok: false,
              failure: "fatal",
              error,
              requestsSpent: this.spent - startedAt,
              diagnostic:
                error.errorType === "authentication" ? "OPENROUTER_AUTH_FAILED" : FATAL_DIAGNOSTIC,
              attempts,
            };
          }

          if (canRetry) {
            await this.sleep(this.backoffMs(error, attempt));
            continue;
          }

          if (error.failure === "retryable") {
            // Retries exhausted. Try the next model rather than giving up: a
            // different model may not be rate limited.
            break;
          }

          // fallback: advance to the next model.
          break;
        }

        attempts.push({ modelId: model.id, outcome: "success", errorType: null, httpStatus: null, willRetry: false, willFallback: false });
        return { ok: true, result, requestsSpent: this.spent - startedAt, attempts };
      }
    }

    return {
      ok: false,
      failure: lastFailure,
      error: lastError,
      requestsSpent: this.spent - startedAt,
      diagnostic:
        lastFailure === "fallback"
          ? FALLBACK_DIAGNOSTIC
          : lastFailure === "retryable"
            ? RETRYABLE_DIAGNOSTIC
            : FATAL_DIAGNOSTIC,
      attempts,
    };
  }

  /**
   * One request: rate limit, concurrency limit, then send.
   *
   * The budget increment happens BEFORE the call, so a request that throws still
   * counts. OpenRouter charges for failed requests, and a rate-limited or
   * rejected attempt is the case most likely to be miscounted.
   */
  private async send(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    await this.acquireRateLimit();
    await this.acquireSlot();

    this.spent += 1;
    if (this.dailyRemaining !== null) this.dailyRemaining = Math.max(0, this.dailyRemaining - 1);

    try {
      return await this.client.complete({ ...request, ...(signal ? { signal } : {}) });
    } finally {
      this.releaseSlot();
    }
  }

  private backoffMs(error: OpenRouterError, attempt: number): number {
    // Prefer the server's own instruction, but never wait unbounded: a hostile
    // or buggy Retry-After must not stall a run that has a wall-clock budget.
    if (error.retryAfterSeconds !== undefined) {
      return Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS);
    }
    // Exponential with full jitter, so concurrent runs do not resynchronise and
    // immediately collide again.
    const ceiling = Math.min(2 ** attempt * 1_000, MAX_BACKOFF_MS);
    return Math.random() * ceiling;
  }

  /** Token bucket over requests per minute, kept under the documented cap. */
  private async acquireRateLimit(): Promise<void> {
    const limit = this.config.maxRequestsPerMinute;
    for (;;) {
      const now = this.now();
      this.recent = this.recent.filter((at) => now - at < 60_000);

      if (this.recent.length < limit) {
        this.recent.push(now);
        return;
      }

      // Wait until the oldest entry falls out of the window.
      const oldest = this.recent[0] ?? now;
      const waitMs = Math.max(50, 60_000 - (now - oldest));
      await this.sleep(waitMs);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.config.maxConcurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight += 1;
  }

  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    next?.();
  }
}
