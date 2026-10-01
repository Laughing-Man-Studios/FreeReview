/**
 * Rate-limit stress: 30 synthetic pull requests against the mock, asserting the
 * request ceiling holds across the whole batch.
 *
 * ## Why 30 and why ≤ 8
 *
 * The ceiling that matters is per-run, and a single run's accounting is already
 * covered by the scheduler unit tests. What those cannot show is whether the
 * ceiling survives *repetition* — the failure being guarded against is a slow
 * arithmetic leak: an off-by-one that only shows up on the twentieth run, or a
 * counter that resets when it should not.
 *
 * 30 is chosen to be larger than any plausible free-tier allowance in a busy hour
 * and small enough to run in CI. The asserted figure is the shipped default of
 * `max_requests_per_run: 8`.
 *
 * ## What is actually being asserted
 *
 * Not "the scheduler stops at 8" — that is one case. Three things:
 *
 *  1. **Per-run isolation.** Each of the 30 runs gets a fresh budget, so run 30
 *     costs the same as run 1. A shared counter across runs would make the last
 *     runs free and the first ones expensive, which is the opposite of the
 *     intended fairness.
 *  2. **Retries are inside the ceiling, not beside it.** A run whose model keeps
 *     failing must still stop at 8 — the ceiling is what stops a bad provider from
 *     consuming a day's allowance.
 *  3. **The default is what ships.** Asserted against `loadConfig()` with no
 *     overrides rather than a literal, so changing the default fails here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { loadConfig, type Config, type ModelDefinition } from "../../src/config.js";
import { OpenRouterClient, CHAT_COMPLETIONS_URL } from "../../src/llm/client.js";
import { Scheduler } from "../../src/llm/scheduler.js";

const server = setupServer();
let requests = 0;
let mode: "ok" | "failing" = "ok";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", () => {
    requests += 1;
  });
});
afterEach(() => {
  server.resetHandlers();
  requests = 0;
  mode = "ok";
});
afterAll(() => server.close());

function okBody() {
  return HttpResponse.json({
    id: "gen",
    choices: [{ message: { role: "assistant", content: '{"findings":[]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function failBody() {
  return HttpResponse.json(
    { error: { code: 500, message: "upstream", metadata: { error_type: "internal_error" } } },
    { status: 500 },
  );
}

// Registered per test, not once in `beforeAll`: `afterEach(server.resetHandlers())`
// would otherwise remove it after the first case and leave every later one
// unhandled.
beforeEach(() => {
  server.use(http.post(CHAT_COMPLETIONS_URL, () => (mode === "ok" ? okBody() : failBody())));
});

const MODEL: ModelDefinition = {
  id: "qwen/qwen3.8-27b:free",
  enabled: true,
  priority: 0,
  maxContextTokens: 262_144,
  supportsResponseFormat: true,
  supportsJsonSchema: true,
  privacyEligible: true,
  zdrEligible: false,
};

function newScheduler(config: Config): Scheduler {
  return new Scheduler({
    client: new OpenRouterClient({ config, sleep: () => Promise.resolve() }),
    config,
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
}

function request() {
  return {
    messages: [{ role: "user" as const, content: "hi" }],
    mode: "STRUCTURED" as const,
    maxOutputTokens: 100,
    model: MODEL,
  };
}

const PRS = 30;

describe("the shipped default is the figure being asserted", () => {
  it("is 8 requests per run", () => {
    // Asserted through loadConfig so changing the default fails here rather than
    // silently making the stress test assert a number nobody ships.
    expect(loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test" }).maxRequestsPerRun).toBe(8);
  });
});

describe("30 sequential pull requests each stay within the ceiling", () => {
  it("spends exactly the budget when there is more work than the ceiling allows", async () => {
    const config = loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000" });
    const limit = config.maxRequestsPerRun;

    const spent: number[] = [];

    for (let pr = 0; pr < PRS; pr += 1) {
      requests = 0;
      const scheduler = newScheduler(config);

      // More chunks than the ceiling permits, which is the realistic case: a
      // large pull request would be reviewed in several chunks.
      for (let chunk = 0; chunk < limit + 4; chunk += 1) {
        await scheduler.runTask(request(), [MODEL]);
      }

      spent.push(scheduler.budget.spent);
      expect(requests, `PR ${pr} exceeded the ceiling`).toBeLessThanOrEqual(limit);
    }

    // Per-run isolation: every run spends the same amount. A counter shared across
    // runs would make the later runs free, which is how a fairness bug hides.
    expect(new Set(spent)).toEqual(new Set([limit]));
  });

  it("reports the budget exhausted rather than pretending the work was done", async () => {
    const config = loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000" });
    const scheduler = newScheduler(config);

    const outcomes = [];
    for (let chunk = 0; chunk < config.maxRequestsPerRun + 3; chunk += 1) {
      outcomes.push(await scheduler.runTask(request(), [MODEL]));
    }

    // The first N succeed and the rest are refused. An unbounded run would keep
    // going; a silent one would report success for work never done.
    const succeeded = outcomes.filter((o) => o.ok);
    const refused = outcomes.filter((o) => !o.ok);

    expect(succeeded).toHaveLength(config.maxRequestsPerRun);
    expect(refused.length).toBeGreaterThan(0);
    for (const outcome of refused) {
      if (!outcome.ok) expect(outcome.diagnostic).toBe("REQUEST_BUDGET_EXHAUSTED");
    }
  });
});

describe("a failing provider cannot drain the allowance", () => {
  it("stops at the ceiling even when every request fails and retries", async () => {
    // This is the shape that matters: a bad provider returns 500, the scheduler
    // retries with backoff, and each retry costs a request. Without the ceiling
    // this would burn a day's 50 requests on one pull request.
    mode = "failing";
    const config = loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000" });
    const limit = config.maxRequestsPerRun;

    for (let pr = 0; pr < PRS; pr += 1) {
      requests = 0;
      const scheduler = newScheduler(config);
      for (let chunk = 0; chunk < limit + 2; chunk += 1) {
        await scheduler.runTask(request(), [MODEL]);
      }
      expect(requests, `PR ${pr} exceeded the ceiling while failing`).toBeLessThanOrEqual(limit);
    }
  });

  it("counts a retry as a spent request, not as free", async () => {
    // The specific leak: if retries were not counted, the ceiling would bound
    // *tasks* rather than *requests*, and the documented cost would be wrong.
    mode = "failing";
    const config = loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000" });
    const scheduler = newScheduler(config);

    await scheduler.runTask(request(), [MODEL]);

    expect(scheduler.budget.spent).toBeGreaterThan(1);
    expect(requests).toBe(scheduler.budget.spent);
  });
});

describe("the daily reserve holds back the last of the allowance", () => {
  it("never lets a run spend into the reserve, however many chunks arrive", async () => {
    // The per-run ceiling bounds one pull request. The reserve bounds *all* of
    // them, and is the property that keeps a burst of pull requests from eating
    // the whole day and leaving later reviews silently unreviewed.
    //
    // Asserting "30 PRs cost under 50 requests" would be wrong: each run legitimately
    // spends its own 8, so the batch costs 240. The reserve is what makes the
    // remainder of the day reachable.
    const config = loadConfig({
      INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000",
      INPUT_DAILY_RESERVE: "10",
    });

    const dailyAllowance = 50;
    let dailyRemaining = dailyAllowance;
    let total = 0;

    for (let pr = 0; pr < PRS; pr += 1) {
      requests = 0;
      const scheduler = newScheduler(config);
      scheduler.setDailyRemaining(dailyRemaining);

      for (let chunk = 0; chunk < config.maxRequestsPerRun + 2; chunk += 1) {
        await scheduler.runTask(request(), [MODEL]);
      }

      total += scheduler.budget.spent;
      dailyRemaining = Math.max(0, dailyRemaining - scheduler.budget.spent);
    }

    // The reserve is never crossed: whatever the batch did, at least
    // `dailyReserve` requests remain spendable at the end.
    expect(dailyRemaining).toBeGreaterThanOrEqual(config.dailyReserve);
    expect(total).toBeLessThan(dailyAllowance);
  });

  it("spends nothing at all once the day is exhausted", async () => {
    // Exhaustion must be visible rather than silent. A run that reports success
    // for work it never did is the failure this whole design refuses.
    const config = loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000" });
    const scheduler = newScheduler(config);
    scheduler.setDailyRemaining(0);

    requests = 0;
    const outcome = await scheduler.runTask(request(), [MODEL]);

    expect(requests).toBe(0);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.diagnostic).toBe("REQUEST_BUDGET_EXHAUSTED");
  });

  it("still works when the daily remaining count is unknown", async () => {
    // A failed quota preflight must not disable review. The reserve is then
    // unknowable, and the run budget alone is the bound — a worse guarantee than
    // normal, and better than refusing to review.
    const config = loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000" });
    const scheduler = newScheduler(config);
    scheduler.setDailyRemaining(null);

    requests = 0;
    const outcome = await scheduler.runTask(request(), [MODEL]);

    expect(outcome.ok).toBe(true);
    expect(requests).toBe(1);
  });
});
