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
import { STAGE_A, STAGE_B } from "./lib/fixtures.js";
import { createCache, type ResponseCache } from "./lib/cache.js";
import {
  aggregate,
  formatAggregate,
  scoreFixture,
  type AggregateScore,
  type FixtureScore,
} from "./lib/score.js";
import { findingsFromResponse, jitteredDelay, loadFixture, renderFixtureForEval } from "./lib/harness.js";
import { DEFAULT_MODELS, loadConfig, OpenRouterClient, Scheduler, buildChatRequest } from "./lib/harness.js";
import { PROMPT_VERSION } from "../src/prompt/version.js";
import { reviewModeFor, supportedModesFor } from "../src/config.js";
import type { ModelDefinition, PrivacyMode } from "../src/config.js";
import type { CapabilityMode } from "../src/types.js";

/** Requests per minute. Deliberately well under the platform's 20. */
const EVAL_RPM = 10;
const MINUTE_MS = 60_000;
const DELAY_BETWEEN_REQUESTS_MS = MINUTE_MS / EVAL_RPM;

/** Consecutive rate-limited failures before a model is parked. */
const CIRCUIT_BREAKER_THRESHOLD = 4;

/**
 * The candidate field.
 *
 * Every model is evaluated under the privacy mode it would actually be selected
 * in: `ling` under `strict` because it is the only ZDR-capable model and strict
 * is the default, everything else under `relaxed`. Running a non-ZDR model under
 * strict produces a 404 on every request and tells us nothing about the model.
 *
 * The two models disabled for privacy reasons in the catalog are included here
 * deliberately. `enabled` is a *shipping* decision; this is a *measurement*, and
 * the question being asked is whether they earn a place in the fallback chain
 * for a consumer who has chosen `relaxed`. Their privacy terms are a reason not
 * to enable them by default, not a reason never to evaluate them.
 */
const MODELS: readonly { id: string; privacyMode: PrivacyMode }[] = [
  { id: "inclusionai/ling-3.0-flash-sante:free", privacyMode: "strict" },
  { id: "qwen/qwen3.8-27b:free", privacyMode: "relaxed" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", privacyMode: "relaxed" },
  { id: "liquid/lfm-2.5-2.6b:free", privacyMode: "relaxed" },
  { id: "google/gemma-4-31b-it:free", privacyMode: "relaxed" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", privacyMode: "relaxed" },
  { id: "poolside/laguna-s-2.1:free", privacyMode: "relaxed" },
  { id: "thinkingmachines/inkling-small:free", privacyMode: "relaxed" },
];

/**
 * Resolve the real catalog definition for a model.
 *
 * This exists because the first version of this file *constructed* a definition
 * inline with `supportsResponseFormat: false, supportsJsonSchema: false`, which
 * forced every model into PROMPT_JSON regardless of what it actually supports.
 * That evaluated `ling` natively while degrading both structured-output models,
 * and then reported the degraded models as worse — which is how `qwen` came to
 * be carrying four duplicates and a 2/2 injection-compliance score it may not
 * actually deserve.
 *
 * The catalog is the single source of truth for what a model supports. If a
 * capability changes there, it must not have to be mirrored here.
 */
function definitionFor(modelId: string): ModelDefinition {
  const found = DEFAULT_MODELS.find((m) => m.id === modelId);
  if (found === undefined) {
    throw new Error(
      `No catalog entry for ${modelId}. Add it to DEFAULT_MODELS rather than ` +
        `constructing a definition here — a hand-built definition is how the ` +
        `capability flags got out of sync in the first place.`,
    );
  }
  // `enabled` is a shipping default; evaluating a disabled model is the point.
  return { ...found, enabled: true };
}

interface Args {
  readonly stage: "a" | "b";
  readonly noCache: boolean;
  readonly maxRequests: number;
  readonly models: readonly string[];
  readonly outDir: string;
  /** Measure every supported mode, not just the catalog's preference. */
  readonly sweep: boolean;
  /** Independent passes per (model, mode), for a spread rather than a point. */
  readonly repeat: number;
}

function parseArgs(argv: readonly string[]): Args {
  const models: string[] = [];
  let noCache = false;
  let stage: "a" | "b" = "a";
  // Generous default: 15 fixtures x 3 models is 45 requests, and retries plus
  // fallbacks need headroom. The ceiling exists to stop an interrupted run
  // costing three times what it should.
  let maxRequests = 120;
  let outDir = join(import.meta.dirname, "results");
  let sweep = false;
  let repeat = 1;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-cache") noCache = true;
    else if (arg === "--max-requests") maxRequests = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--out") outDir = argv[++i] ?? outDir;
    else if (arg === "--model") models.push(argv[++i] ?? "");
    else if (arg?.startsWith("--model=")) models.push(arg.slice("--model=".length));
    else if (arg === "--stage") {
      const value = argv[++i];
      if (value !== "a" && value !== "b") {
        throw new Error(`--stage must be 'a' or 'b', got ${JSON.stringify(value ?? "")}`);
      }
      stage = value;
    } else if (arg === "--sweep") sweep = true;
    else if (arg === "--repeat") repeat = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10));
  }

  return {
    stage,
    noCache,
    maxRequests,
    outDir,
    sweep,
    repeat,
    models: models.length > 0 ? models : MODELS.map((m) => m.id),
  };
}

/**
 * Which request shapes to measure for a model.
 *
 * In sweep mode this is every shape its capabilities permit, so the catalog's
 * `preferredMode` can be chosen from data rather than asserted. The catalog only
 * records that STRUCTURED is *eligible* for `nemotron-3-super`; it cannot know
 * that STRUCTURED scores 0.47 against PROMPT_JSON's 0.87 until someone spends
 * the requests. This is the tool that spends them.
 */
function modesToMeasure(modelId: string, sweep: boolean): readonly CapabilityMode[] {
  const definition = definitionFor(modelId);
  return sweep ? supportedModesFor(definition) : [reviewModeFor(definition)];
}

/** Force a definition into a specific mode, overriding the catalog preference. */
function definitionInMode(modelId: string, mode: CapabilityMode): ModelDefinition {
  const base = definitionFor(modelId);
  return {
    ...base,
    supportsJsonSchema: mode === "STRUCTURED" ? true : false,
    supportsResponseFormat: mode === "PROMPT_JSON" ? false : true,
    preferredMode: mode,
  };
}

interface ModelRun {
  readonly modelId: string;
  readonly privacyMode: PrivacyMode;
  readonly mode: CapabilityMode;
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
  mode: CapabilityMode,
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

  const definition = definitionInMode(modelId, mode);

  const client = new OpenRouterClient({ config });
  const scheduler = new Scheduler({ client, config });
  const scores: FixtureScore[] = [];
  const stageFixtures = args.stage === "b" ? STAGE_B : STAGE_A;
  const injectionIds = new Set(stageFixtures.filter((f) => f.injection).map((f) => f.id));

  let requests = 0;
  let cacheHits = 0;
  let parseErrors = 0;
  let consecutiveRateLimits = 0;
  let parkedReason: string | null = null;

  for (const fixture of stageFixtures) {
    if (parkedReason !== null) break;
    if (budget.spent >= args.maxRequests) {
      parkedReason = `request budget exhausted (${budget.spent}/${args.maxRequests})`;
      break;
    }

    const loaded = loadFixture(join(import.meta.dirname, "fixtures", `stage-${args.stage}`), fixture);
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

      const request = buildChatRequest(chunk, definition, config.maxOutputTokens);
      // Keyed on the built body, not the rendered diff: the system prompt is a
      // separate message and the key must see it. See cache.ts.
      const key = {
        promptVersion: PROMPT_VERSION,
        modelId,
        body: client.buildBody(request),
      };
      const cached = cache.get(key);

      let content: string;
      if (cached !== null) {
        content = cached.content;
        cacheHits += 1;
      } else {
        const outcome = await scheduler.runTask(request, [definition]);
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
    mode,
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

  const fixtures = args.stage === "b" ? STAGE_B : STAGE_A;
  const stageLabel = args.stage.toUpperCase();
  const oneShot = args.stage === "b" && args.repeat === 1 && !args.sweep;
  console.log(`eval — Stage ${stageLabel}, ${fixtures.length} fixtures, prompt ${PROMPT_VERSION}`);
  if (oneShot) {
    // Said before any request is spent, so the run cannot be mistaken for one more
    // measurement round that may be iterated against.
    console.log("  ONE-SHOT: Stage B has never been scored. Whatever this produces is final.");
  }
  console.log(`  models: ${args.models.join(", ")}`);
  console.log(
    `  pacing ${EVAL_RPM}/min concurrency 1 · cache ${args.noCache ? "DISABLED" : "on"} · ` +
      `ceiling ${args.maxRequests} requests`,
  );
  console.log("");

  const runs: ModelRun[] = [];

  for (const modelId of args.models) {
    const privacyMode = MODELS.find((m) => m.id === modelId)?.privacyMode ?? "strict";

    for (const mode of modesToMeasure(modelId, args.sweep)) {
      // Repeats exist because one pass is not a measurement. Two identical runs
      // of `ling` differed by 0.13 recall, so a single number cannot separate a
      // real mode difference from noise. The spread is reported, not averaged
      // away, because the spread is the finding.
      for (let pass = 1; pass <= args.repeat; pass += 1) {
        if (budget.spent >= args.maxRequests) break;

        const suffix = args.repeat > 1 ? ` [${mode} pass ${pass}/${args.repeat}]` : ` [${mode}]`;
        process.stdout.write(`  ${modelId}${suffix} … `);

        const run = await runModel(modelId, privacyMode, mode, args, cache, budget);
        runs.push(run);

        console.log(
          `${run.requests} req, ${run.cacheHits} cached` +
            (run.parseErrors > 0 ? `, ${run.parseErrors} parse errors` : "") +
            (run.parkedReason === null ? "" : `, PARKED: ${run.parkedReason}`),
        );
        console.log(
          `    recall=${run.aggregate.recall.toFixed(2)} precision=${run.aggregate.precision.toFixed(2)} ` +
            `anchor=${run.aggregate.primaryPlacementRate.toFixed(2)} expl=${run.aggregate.explanationScore.toFixed(2)} ` +
            `fp=${run.aggregate.falsePositives} dup=${run.aggregate.duplicates} ` +
            `forbidden=${run.aggregate.forbiddenViolations} injection=${run.aggregate.injectionCompliance}/${run.aggregate.injectionFixtures}`,
        );

        if (budget.spent >= args.maxRequests) {
          console.log(`\n  request ceiling reached (${budget.spent}); stopping.`);
          break;
        }
      }
    }

    if (budget.spent >= args.maxRequests) break;
  }

  console.log("");
  console.log("  summary");

  if (args.sweep || args.repeat > 1) {
    // Group by model+mode so the sweep answer is legible: which mode, and how
    // much the number moves between passes.
    const grouped = new Map<string, ModelRun[]>();
    for (const run of runs) {
      const key = `${run.modelId} ${run.mode}`;
      grouped.set(key, [...(grouped.get(key) ?? []), run]);
    }

    for (const [key, group] of grouped) {
      const recalls = group.map((g) => g.aggregate.recall);
      const min = Math.min(...recalls);
      const max = Math.max(...recalls);
      const mean = recalls.reduce((a, b) => a + b, 0) / recalls.length;
      const injections = group.map((g) => g.aggregate.injectionCompliance).join(",");

      console.log(
        `    ${key.padEnd(56)} recall mean=${mean.toFixed(2)} range=${min.toFixed(2)}-${max.toFixed(2)} ` +
          `prec=${group[0]!.aggregate.precision.toFixed(2)} injection=${injections}`,
      );
    }

    // Where the sweep disagrees with the catalog, say so explicitly. A silent
    // mismatch is how a hand-maintained preference rots.
    if (args.sweep) {
      const catalog = new Map<string, CapabilityMode>();
      for (const run of runs) {
        if (!catalog.has(run.modelId)) catalog.set(run.modelId, reviewModeFor(definitionFor(run.modelId)));
      }
      console.log("\n  catalog preference vs measured best");
      for (const run of runs) {
        const current = catalog.get(run.modelId)!;
        if (run.mode !== current) continue;
        const peers = runs.filter((r) => r.modelId === run.modelId);
        const best = peers.reduce((a, b) => (b.aggregate.recall > a.aggregate.recall ? b : a));
        if (best.mode !== current && best.aggregate.recall - run.aggregate.recall > 0.05) {
          console.log(
            `    ${run.modelId}: catalog says ${current} (recall ${run.aggregate.recall.toFixed(2)}) ` +
              `but ${best.mode} scored ${best.aggregate.recall.toFixed(2)} — update preferredMode`,
          );
        }
      }
    }
  } else {
    for (const run of runs) {
      console.log(`    ${formatAggregate(run.modelId, run.aggregate)}`);
    }
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
