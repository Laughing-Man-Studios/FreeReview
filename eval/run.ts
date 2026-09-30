/**
 * Run the golden dataset against a shortlist of models.
 *
 * ## Budget discipline
 *
 * Every attempt counts against the daily allowance, including a cached hit
 * costing nothing. `--max-requests` is a hard ceiling for the whole run, not a
 * per-model budget, so an interrupted run cannot accidentally triple its cost.
 *
 * ## Pacing, and why it is slower than it needs to be
 *
 * Ten requests per minute at concurrency one, with jitter. The 1000/day ceiling
 * is not the binding constraint — the single upstream provider behind the one
 * ZDR-capable model is, and it was observed returning
 * `429 upstream_provider_shared_pool` under load. A pass that provokes throttling
 * wastes requests without producing information, so the harness deliberately
 * takes about 90 seconds where 20 would do.
 *
 * ## Circuit breaker
 *
 * A model that 429s repeatedly is parked for the rest of the run and reported.
 * Without it, one flaky provider silently consumes the entire budget belonging
 * to the models that do work — and the run looks like the models are bad rather
 * than unavailable.
 *
 * ## Cache
 *
 * Responses are cached by `(promptVersion, modelId, renderedChunk)`. With
 * `temperature: 0` and a fixed seed a response is a function of the request, so
 * a hit is exact rather than approximate. `--no-cache` exists for the case where
 * a provider-side change makes a fresh response genuinely informative, and a run
 * that uses it records that fact, because "the model improved" and "the
 * provider changed" are different conclusions.
 */

import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { STAGE_A } from "./lib/fixtures.js";
import { createCache, type ResponseCache } from "./lib/cache.js";
import {
  aggregate,
  formatAggregate,
  scoreFixture,
  type AggregateScore,
  type FixtureScore,
} from "./lib/score.js";
import { findingsFromResponse, jitteredDelay, loadFixture, renderFixtureForEval } from "./lib/harness.js";
import { loadConfig, OpenRouterClient, Scheduler, buildChatRequest } from "./lib/harness.js";
import { PROMPT_VERSION } from "../src/prompt/version.js";
import type { ModelDefinition, PrivacyMode } from "../src/config.js";

/** Requests per minute. Deliberately well under the platform's 20. */
const EVAL_RPM = 10;
const MINUTE_MS = 60_000;
const DELAY_BETWEEN_REQUESTS_MS = MINUTE_MS / EVAL_RPM;

/** Consecutive rate-limited failures before a model is parked. */
const CIRCUIT_BREAKER_THRESHOLD = 4;

const MODELS: readonly { id: string; privacyMode: PrivacyMode }[] = [
  // Ships under the default strict privacy: the only free model with a
  // zero-data-retention endpoint. Measured 2026-09-29.
  { id: "inclusionai/ling-3.0-flash-sante:free", privacyMode: "strict" },
  // Quality ceiling under relaxed. Both are structured-output capable, which the
  // ZDR model is not.
  { id: "qwen/qwen3.8-27b:free", privacyMode: "relaxed" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", privacyMode: "relaxed" },
];

interface Args {
  readonly noCache: boolean;
  readonly maxRequests: number;
  readonly models: readonly string[];
  readonly outDir: string;
}

function parseArgs(argv: readonly string[]): Args {
  const models: string[] = [];
  let noCache = false;
  // Generous default: 15 fixtures x 3 models is 45 requests, and retries plus
  // fallbacks need headroom. The ceiling exists to stop an interrupted run
  // costing three times what it should.
  let maxRequests = 120;
  let outDir = join(import.meta.dirname, "results");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-cache") noCache = true;
    else if (arg === "--max-requests") maxRequests = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--out") outDir = argv[++i] ?? outDir;
    else if (arg === "--model") models.push(argv[++i] ?? "");
    else if (arg?.startsWith("--model=")) models.push(arg.slice("--model=".length));
  }

  return {
    noCache,
    maxRequests,
    outDir,
    models: models.length > 0 ? models : MODELS.map((m) => m.id),
  };
}

interface ModelRun {
  readonly modelId: string;
  readonly privacyMode: PrivacyMode;
  readonly scores: FixtureScore[];
  readonly aggregate: AggregateScore;
  readonly requests: number;
  readonly cacheHits: number;
  readonly parseErrors: number;
  /** Set when the circuit breaker parked this model. */
  readonly parkedReason: string | null;
}

async function runModel(
  modelId: string,
  privacyMode: PrivacyMode,
  args: Args,
  cache: ResponseCache,
  budget: { spent: number },
): Promise<ModelRun> {
  const config = loadConfig({
    INPUT_OPENROUTER_API_KEY: process.env["OPENROUTER_API_KEY_EVAL"] ?? process.env["OPENROUTER_API_KEY"] ?? "",
    INPUT_PRIVACY_MODE: privacyMode,
    INPUT_PRIMARY_MODEL: modelId,
    INPUT_FALLBACK_MODELS: "",
    // The run budget here is the eval's own ceiling, not the action's default.
    // Clamped: the action caps a single run at 50 by design, and the eval may
    // legitimately want more. The eval enforces its own ceiling above.
    INPUT_MAX_REQUESTS_PER_RUN: String(Math.min(50, Math.max(1, args.maxRequests))),
    INPUT_MAX_REQUESTS_PER_MINUTE: String(EVAL_RPM),
    INPUT_MAX_CONCURRENCY: "1",
    INPUT_DAILY_RESERVE: "0",
  });

  const definition: ModelDefinition = {
    id: modelId,
    enabled: true,
    priority: 0,
    maxContextTokens: 262_144,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: true,
    zdrEligible: privacyMode === "strict",
  };

  const client = new OpenRouterClient({ config });
  const scheduler = new Scheduler({ client, config });
  const scores: FixtureScore[] = [];
  const injectionIds = new Set(STAGE_A.filter((f) => f.injection).map((f) => f.id));

  let requests = 0;
  let cacheHits = 0;
  let parseErrors = 0;
  let consecutiveRateLimits = 0;
  let parkedReason: string | null = null;

  for (const fixture of STAGE_A) {
    if (parkedReason !== null) break;
    if (budget.spent >= args.maxRequests) {
      parkedReason = `request budget exhausted (${budget.spent}/${args.maxRequests})`;
      break;
    }

    const loaded = loadFixture(join(import.meta.dirname, "fixtures", "stage-a"), fixture);
    const rendered = renderFixtureForEval(loaded, config, {
      owner: "acme",
      repo: "eval",
      pullNumber: 1,
      headSha: "a".repeat(40),
      title: "evaluation fixture",
    });

    const collected: ReturnType<typeof findingsFromResponse>["findings"] = [];

    for (const chunk of rendered.chunks) {
      if (budget.spent >= args.maxRequests) break;

      const key = {
        promptVersion: PROMPT_VERSION,
        modelId,
        renderedUserMessage: chunk.userMessage,
      };
      const cached = cache.get(key);

      let content: string;
      if (cached !== null) {
        content = cached.content;
        cacheHits += 1;
      } else {
        const outcome = await scheduler.runTask(
          buildChatRequest(chunk, definition, config.maxOutputTokens),
          [definition],
        );
        budget.spent += 1;
        requests += 1;

        if (!outcome.ok) {
          const rateLimited = outcome.attempts.some((a) => a.httpStatus === 429);
          if (rateLimited) {
            consecutiveRateLimits += 1;
            if (consecutiveRateLimits >= CIRCUIT_BREAKER_THRESHOLD) {
              parkedReason =
                `parked after ${consecutiveRateLimits} consecutive rate-limited requests ` +
                "(upstream provider saturation, not a model result)";
              break;
            }
          } else {
            consecutiveRateLimits = 0;
          }
          // A failed request is scored as "reported nothing", which is correct:
          // nothing was learned from it, and treating silence as a miss would
          // penalise the model for the provider's behaviour.
          continue;
        }

        consecutiveRateLimits = 0;
        content = outcome.result.content;
        cache.set(key, { content });
        await jitteredDelay(DELAY_BETWEEN_REQUESTS_MS);
      }

      const parsed = findingsFromResponse(content, null, loaded.index, loaded.prFilePaths);
      if (parsed.parseError !== null) parseErrors += 1;
      collected.push(...parsed.findings);
    }

    scores.push(
      scoreFixture({
        fixtureId: fixture.id,
        expected: fixture.expectedFindings,
        forbidden: fixture.forbiddenFindings,
        findings: collected,
      }),
    );
  }

  return {
    modelId,
    privacyMode,
    scores,
    aggregate: aggregate({ scores, injectionFixtureIds: injectionIds }),
    requests,
    cacheHits,
    parseErrors,
    parkedReason,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cache = createCache({
    dir: join(import.meta.dirname, ".cache"),
    enabled: !args.noCache,
  });
  const budget = { spent: 0 };

  console.log(`eval — Stage A, ${STAGE_A.length} fixtures, prompt ${PROMPT_VERSION}`);
  console.log(`  models: ${args.models.join(", ")}`);
  console.log(
    `  pacing ${EVAL_RPM}/min concurrency 1 · cache ${args.noCache ? "DISABLED" : "on"} · ` +
      `ceiling ${args.maxRequests} requests`,
  );
  console.log("");

  const runs: ModelRun[] = [];

  for (const modelId of args.models) {
    const privacyMode = MODELS.find((m) => m.id === modelId)?.privacyMode ?? "strict";
    process.stdout.write(`  ${modelId} … `);

    const run = await runModel(modelId, privacyMode, args, cache, budget);
    runs.push(run);

    console.log(
      `${run.requests} req, ${run.cacheHits} cached` +
        (run.parseErrors > 0 ? `, ${run.parseErrors} parse errors` : "") +
        (run.parkedReason === null ? "" : `, PARKED: ${run.parkedReason}`),
    );
    console.log(`    ${formatAggregate(run.modelId, run.aggregate)}`);

    if (budget.spent >= args.maxRequests) {
      console.log(`\n  request ceiling reached (${budget.spent}); stopping.`);
      break;
    }
  }

  console.log("");
  console.log("  summary");
  for (const run of runs) {
    console.log(`    ${formatAggregate(run.modelId, run.aggregate)}`);
  }
  console.log(
    `  cache ${cache.stats.hits} hits / ${cache.stats.misses} misses / ${cache.stats.writes} writes`,
  );
  console.log(`  requests spent: ${budget.spent}`);

  mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(args.outDir, `stage-a-${stamp}.json`);
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        promptVersion: PROMPT_VERSION,
        cacheDisabled: args.noCache,
        requestsSpent: budget.spent,
        cacheStats: cache.stats,
        runs: runs.map((r) => ({
          modelId: r.modelId,
          privacyMode: r.privacyMode,
          requests: r.requests,
          cacheHits: r.cacheHits,
          parseErrors: r.parseErrors,
          parkedReason: r.parkedReason,
          aggregate: r.aggregate,
          scores: r.scores,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`  written: ${outPath}`);
}

void main();
