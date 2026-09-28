/**
 * Scheduler tests.
 *
 * The scheduler owns the request budget, and the budget is the project's binding
 * constraint. These assert the properties that make it trustworthy:
 *
 *  - every attempt counts, including retries and fallbacks;
 *  - the run budget is never exceeded;
 *  - the daily reserve is untouchable;
 *  - a fatal failure is not retried;
 *  - a retryable failure is retried only within budget;
 *  - fallback advances models only for failures that warrant it;
 *  - cancellation stops spending immediately.
 *
 * `sleep` and `now` are injected, so no test consumes wall-clock time.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config, type ModelDefinition } from "../../src/config.js";
import { CHAT_COMPLETIONS_URL, OpenRouterClient } from "../../src/llm/client.js";
import { Scheduler } from "../../src/llm/scheduler.js";

const server = setupServer();
let requests = 0;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", () => {
    requests += 1;
  });
});
afterEach(() => {
  server.resetHandlers();
  requests = 0;
});
afterAll(() => server.close());

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000", ...overrides });
}

const PRIMARY: ModelDefinition = {
  id: "qwen/qwen3.8-27b:free",
  enabled: true,
  priority: 0,
  maxContextTokens: 262_144,
  supportsResponseFormat: true,
  supportsJsonSchema: true,
  privacyEligible: true,
};

const SECONDARY: ModelDefinition = { ...PRIMARY, id: "nvidia/nemotron-3-super-120b-a12b:free", priority: 1 };
const TERTIARY: ModelDefinition = { ...PRIMARY, id: "liquid/lfm-2.5-2.6b:free", priority: 2 };

const MESSAGES = [{ role: "user" as const, content: "hi" }];
const REQUEST = { messages: MESSAGES, mode: "PROMPT_JSON" as const, maxOutputTokens: 100 };

function scheduler(overrides: Record<string, string> = {}, cfg: Config = config(overrides)) {
  return new Scheduler({
    client: new OpenRouterClient({ config: cfg, sleep: () => Promise.resolve() }),
    config: cfg,
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
}

function ok(content = '{"findings":[]}') {
  return HttpResponse.json({
    id: "gen",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function errorResponse(status: number, errorType: string, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    { error: { code: status, message: errorType, metadata: { error_type: errorType, ...extra } } },
    { status },
  );
}

describe("budget accounting", () => {
  it("counts a successful request once", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY]);

    expect(outcome.ok).toBe(true);
    expect(outcome.requestsSpent).toBe(1);
    expect(s.budget.spent).toBe(1);
    expect(requests).toBe(1);
  });

  it("counts a retry against the budget", async () => {
    let calls = 0;
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () => {
        calls += 1;
        return calls === 1 ? errorResponse(429, "rate_limit_exceeded") : ok();
      }),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY]);

    expect(outcome.ok).toBe(true);
    // Two requests were spent: the rate-limited one and the successful retry.
    // A retry is not free.
    expect(outcome.requestsSpent).toBe(2);
    expect(s.budget.spent).toBe(2);
  });

  it("counts a failed request that never returned content", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => errorResponse(502, "provider_unavailable")));
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY]);

    expect(outcome.ok).toBe(false);
    expect(s.budget.spent).toBeGreaterThanOrEqual(1);
  });
});

describe("the run budget is hard", () => {
  it("stops once max_requests_per_run is reached", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => errorResponse(500, "server")));
    // Budget 2, retries 1, two models: without a budget this would be 4 calls.
    const s = scheduler({ INPUT_MAX_REQUESTS_PER_RUN: "2" });

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY]);

    expect(outcome.ok).toBe(false);
    expect(s.budget.spent).toBeLessThanOrEqual(2);
  });

  it("reports REQUEST_BUDGET_EXHAUSTED when the budget runs out mid-task", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => errorResponse(500, "server")));
    const s = scheduler({ INPUT_MAX_REQUESTS_PER_RUN: "1" });

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("REQUEST_BUDGET_EXHAUSTED");
  });

  it("spends nothing when the budget is already exhausted", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler({ INPUT_MAX_REQUESTS_PER_RUN: "1" });

    await s.runTask(REQUEST, [PRIMARY]);
    const afterFirst = requests;

    const second = await s.runTask(REQUEST, [PRIMARY]);

    expect(second.ok).toBe(false);
    // The budget allows exactly one request for the whole run, not per task.
    expect(requests).toBe(afterFirst);
  });
});

describe("the daily reserve is untouchable", () => {
  it("stops when only the reserve remains", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler();
    // Remaining exactly equal to the default reserve of 10: nothing spendable.
    s.setDailyRemaining(10);

    const outcome = await s.runTask(REQUEST, [PRIMARY]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("REQUEST_BUDGET_EXHAUSTED");
    expect(requests).toBe(0);
  });

  it("allows spending while more than the reserve remains", async () => {
    // 12 remaining against a reserve of 10 leaves 2 spendable, so this must
    // succeed. The boundary is `remaining > reserve`, not `>=`.
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler();
    s.setDailyRemaining(12);

    const outcome = await s.runTask(REQUEST, [PRIMARY]);

    expect(outcome.ok).toBe(true);
    expect(s.budget.dailyRemaining).toBe(11);
  });

  it("spends down to the reserve and then stops", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler({ INPUT_MAX_REQUESTS_PER_RUN: "10" });
    s.setDailyRemaining(12); // 2 spendable

    await s.runTask(REQUEST, [PRIMARY]);
    await s.runTask(REQUEST, [PRIMARY]);

    expect(s.budget.spent).toBe(2);
    expect(s.budget.remaining).toBe(0);

    const third = await s.runTask(REQUEST, [PRIMARY]);
    expect(third.ok).toBe(false);
    expect(requests).toBe(2);
  });

  it("allows the full run budget when the daily allowance is unknown", async () => {
    // A failed quota probe must not disable the reviewer; the per-run budget
    // still bounds the damage.
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler();
    s.setDailyRemaining(null);

    await s.runTask(REQUEST, [PRIMARY]);
    expect(s.budget.remaining).toBeGreaterThan(0);
  });
});

describe("retry policy", () => {
  it("retries a retryable failure once", async () => {
    let calls = 0;
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () => {
        calls += 1;
        return calls === 1 ? errorResponse(503, "provider_overloaded") : ok();
      }),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY]);

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry a fatal failure", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => errorResponse(401, "authentication")));
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY, TERTIARY]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("OPENROUTER_AUTH_FAILED");
    // A bad key is an operator problem: one request, not a retry storm, and not
    // a walk through the whole model pool.
    expect(requests).toBe(1);
  });

  it("advances to the next model after retries are exhausted", async () => {
    const used: string[] = [];
    server.use(
      http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
        const body = (await request.clone().json()) as { model: string };
        used.push(body.model);
        if (body.model === PRIMARY.id) return errorResponse(503, "provider_overloaded");
        return ok();
      }),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY]);

    if (!outcome.ok) throw new Error(`expected success, got ${outcome.diagnostic}`);
    expect(outcome.result.modelId).toBe(SECONDARY.id);
    expect(used[0]).toBe(PRIMARY.id);
    expect(used[used.length - 1]).toBe(SECONDARY.id);
  });
});

describe("fallback policy", () => {
  it("falls back immediately when no endpoint matched routing", async () => {
    // attempt 0 means the router filtered every candidate before submitting.
    // Retrying the identical request cannot change that, so it must not.
    const used: string[] = [];
    server.use(
      http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
        const body = (await request.clone().json()) as { model: string };
        used.push(body.model);
        return HttpResponse.json(
          {
            error: { code: 503, message: "No available model provider meets your routing requirements" },
            openrouter_metadata: { attempt: 0 },
          },
          { status: 503 },
        );
      }),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("NO_ELIGIBLE_PROVIDER");
    // One attempt per model, no retries: two models, two requests.
    expect(requests).toBe(2);
    expect(used).toEqual([PRIMARY.id, SECONDARY.id]);
  });

  it("falls back when a model has disappeared from the catalog", async () => {
    const used: string[] = [];
    server.use(
      http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
        const body = (await request.clone().json()) as { model: string };
        used.push(body.model);
        if (body.model === PRIMARY.id) return errorResponse(404, "not_found");
        return ok();
      }),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY]);

    expect(outcome.ok).toBe(true);
    expect(requests).toBe(2);
  });

  it("reports NO_ELIGIBLE_PROVIDER when every model is unroutable", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(
          {
            error: { code: 503, message: "no provider" },
            openrouter_metadata: { attempt: 0 },
          },
          { status: 503 },
        ),
      ),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY, TERTIARY]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("NO_ELIGIBLE_PROVIDER");
    expect(requests).toBe(3);
  });

  it("records every attempt for the diagnostic trail", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
        const body = (await request.clone().json()) as { model: string };
        if (body.model === PRIMARY.id) return errorResponse(503, "provider_overloaded");
        return ok();
      }),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY]);

    if (!outcome.ok) throw new Error(`expected success, got ${outcome.diagnostic}`);
    // The primary is retried once before the pool advances, so the trail is
    // three entries: two retryable failures on the primary, then success on the
    // secondary. The trail is what the step summary renders, so a run that fell
    // back is explainable afterwards rather than just "it worked eventually".
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts[0]?.modelId).toBe(PRIMARY.id);
    expect(outcome.attempts[0]?.outcome).toBe("retryable");
    expect(outcome.attempts[0]?.willRetry).toBe(true);
    expect(outcome.attempts[1]?.modelId).toBe(PRIMARY.id);
    expect(outcome.attempts[1]?.outcome).toBe("retryable");
    expect(outcome.attempts[1]?.willRetry).toBe(false);
    expect(outcome.attempts[2]?.modelId).toBe(SECONDARY.id);
    expect(outcome.attempts[2]?.outcome).toBe("success");
    // Three requests spent, not one. A retry is not free.
    expect(outcome.requestsSpent).toBe(3);
  });

  it("marks a fallback-driven attempt as such rather than as a retry", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
        const body = (await request.clone().json()) as { model: string };
        if (body.model === PRIMARY.id) return errorResponse(404, "not_found");
        return ok();
      }),
    );
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, [PRIMARY, SECONDARY]);

    if (!outcome.ok) throw new Error(`expected success, got ${outcome.diagnostic}`);
    expect(outcome.attempts[0]?.outcome).toBe("fallback");
    expect(outcome.attempts[0]?.willRetry).toBe(false);
    expect(outcome.attempts[0]?.willFallback).toBe(true);
  });
});

describe("cancellation", () => {
  it("spends nothing when already cancelled", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler();
    const controller = new AbortController();
    controller.abort();

    const outcome = await s.runTask(REQUEST, [PRIMARY], controller.signal);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostic).toBe("REQUEST_CANCELLED");
    expect(requests).toBe(0);
  });
});

describe("no eligible models", () => {
  it("spends nothing when the pool is empty", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => ok()));
    const s = scheduler();

    const outcome = await s.runTask(REQUEST, []);

    expect(outcome.ok).toBe(false);
    expect(requests).toBe(0);
  });
});

describe("concurrency", () => {
  it("never exceeds max_concurrency in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    server.use(
      http.post(CHAT_COMPLETIONS_URL, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return ok();
      }),
    );
    const s = scheduler({ INPUT_MAX_CONCURRENCY: "2" });

    await Promise.all([
      s.runTask(REQUEST, [PRIMARY]),
      s.runTask(REQUEST, [PRIMARY]),
      s.runTask(REQUEST, [PRIMARY]),
      s.runTask(REQUEST, [PRIMARY]),
    ]);

    expect(peak).toBeLessThanOrEqual(2);
  });
});
