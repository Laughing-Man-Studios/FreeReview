/**
 * Availability probe.
 *
 * ## Why this is separate from the quality evaluation
 *
 * A fallback chain has two independent questions, and the quality evaluation
 * only answers the first:
 *
 *  1. Is this model *any good* at reviewing code?
 *  2. Will it actually *answer* when I need it?
 *
 * These do not correlate, and the evidence is already uncomfortable. `qwen` was
 * the strongest relaxed model on recall — and was parked by the circuit breaker
 * on two separate runs for returning `429 upstream_provider_shared_pool`. A
 * model that reviews beautifully and is unavailable exactly when a provider is
 * saturated is not a fallback, it is a single point of failure wearing a
 * disguise.
 *
 * Recall cannot predict this. It is a property of the model under a good
 * network, and the thing we need is behaviour under a bad one. So it gets its own
 * measurement.
 *
 * ## Method
 *
 * A minimal request per model, repeated, recording only whether it came back and
 * how long it took. Deliberately *not* a fixture: the fixtures are large and
 * slow, so a probe using them would confound latency with payload size and burn
 * the request budget on answers we already have.
 *
 * Rate limiting is a real signal here rather than noise to be averaged away. A
 * 429 is the provider telling us it is saturated, which is precisely the
 * condition under which we would reach for a fallback.
 */

import { DEFAULT_MODELS, loadConfig, OpenRouterClient, Scheduler } from "./lib/harness.js";
import { buildChatRequest } from "../src/prompt/index.js";
import type { ModelDefinition, PrivacyMode } from "../src/config.js";
import type { RenderedChunk } from "../src/diff/render.js";

/** Small enough to be answered quickly, large enough to require real work. */
const PROBE_CHUNK: RenderedChunk = {
  userMessage:
    "File: src/a.ts\n" +
    "@@ -1,4 +1,4 @@\n" +
    " export function f(xs: number[]): number {\n" +
    "-  return xs.reduce((a, b) => a + b, 0) / xs.length;\n" +
    "+  return xs.reduce((a, b) => a + b, 0) / xs.length;\n" +
    " }\n" +
    "\n" +
    "Report only genuine defects. If there are none, report none.",
  fenceLength: 3,
  estimatedTokens: 60,
};

interface ProbeResult {
  readonly modelId: string;
  readonly privacyMode: PrivacyMode;
  readonly capabilityMode: string;
  readonly attempted: number;
  readonly succeeded: number;
  readonly rateLimited: number;
  readonly otherFailures: number;
  readonly parseErrors: number;
  /** Median success latency in ms, or null when nothing succeeded. */
  readonly medianLatencyMs: number | null;
  readonly findingsProduced: number;
  readonly notes: readonly string[];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

async function probeModel(
  modelId: string,
  privacyMode: PrivacyMode,
  definition: ModelDefinition,
  attempts: number,
  config: ReturnType<typeof loadConfig>,
  client: OpenRouterClient,
): Promise<ProbeResult> {
  const notes: string[] = [];
  const latencies: number[] = [];

  let succeeded = 0;
  let rateLimited = 0;
  let otherFailures = 0;
  let parseErrors = 0;
  let findings = 0;

  for (let i = 0; i < attempts; i += 1) {
    const scheduler = new Scheduler({ client, config });
    const request = buildChatRequest(PROBE_CHUNK, definition, config.maxOutputTokens);
    const started = Date.now();
    const outcome = await scheduler.runTask(request, [definition]);

    if (!outcome.ok) {
      const rateLimitedThis = outcome.attempts.some((a) => a.httpStatus === 429);
      if (rateLimitedThis) rateLimited += 1;
      else otherFailures += 1;
      notes.push(
        `attempt ${i + 1}: ${outcome.attempts.map((a) => `${a.httpStatus ?? "?"}/${a.errorType ?? "?"}`).join(", ")}`,
      );
      // Space attempts out. A saturated provider that just refused will refuse
      // again immediately, and four fast failures tell us nothing more than one.
      await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 2_000));
      continue;
    }

    succeeded += 1;
    latencies.push(Date.now() - started);

    const text = outcome.result.content;
    if (!text.includes('"findings"')) parseErrors += 1;
    else {
      const count = (text.match(/"path"\s*:/g) ?? []).length;
      findings += count;
    }

    await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 2_000));
  }

  const mode = definition.supportsJsonSchema ? "STRUCTURED" : definition.supportsResponseFormat ? "JSON_OBJECT" : "PROMPT_JSON";

  return {
    modelId,
    privacyMode,
    capabilityMode: mode,
    attempted: attempts,
    succeeded,
    rateLimited,
    otherFailures,
    parseErrors,
    medianLatencyMs: median(latencies),
    findingsProduced: findings,
    notes,
  };
}

/**
 * Capability matrix: try every mode against every model and record what the
 * server actually accepts.
 *
 * ## Why this overrides the catalog
 *
 * The catalog derives capability from OpenRouter's advertised
 * `supported_parameters`, which is a *union across endpoints* and can be stale.
 * `qwen/qwen3.8-27b:free` is flagged `structured_outputs: true` and returns 404
 * on a STRUCTURED request while serving PROMPT_JSON perfectly — so the flag is
 * wrong, and a 404 excludes every endpoint rather than naming the problem.
 *
 * That combination is dangerous: the catalog says the model is capable, the
 * action picks STRUCTURED, and the model becomes unreachable. Nobody finds out
 * until a pull request needs reviewing.
 *
 * So capability is *measured*, not trusted. A model is recorded as supporting a
 * mode only if a real request to it succeeds in that mode.
 */

type Mode = "STRUCTURED" | "JSON_OBJECT" | "PROMPT_JSON";

async function tryMode(
  model: ModelDefinition,
  mode: Mode,
  config: ReturnType<typeof loadConfig>,
  client: OpenRouterClient,
): Promise<{ status: string; detail: string }> {
  // A definition claiming STRUCTURED is what drives mode selection, so the
  // capability flags are varied directly rather than inferred.
  const definition: ModelDefinition = {
    ...model,
    enabled: true,
    supportsJsonSchema: mode === "STRUCTURED" ? true : false,
    supportsResponseFormat: mode === "STRUCTURED" || mode === "JSON_OBJECT" ? true : false,
  };

  const scheduler = new Scheduler({ client, config });
  const outcome = await scheduler.runTask(buildChatRequest(PROBE_CHUNK, definition, 2_000), [definition]);

  if (outcome.ok) return { status: "OK", detail: "" };

  const statuses = outcome.attempts.map((a) => a.httpStatus).filter((s): s is number => s !== null);
  const last = outcome.attempts[outcome.attempts.length - 1];
  const status = statuses.length === 0 ? "ERR" : String(statuses[0]);
  return { status, detail: String(last?.errorMessage ?? "").slice(0, 90) };
}

async function matrix(): Promise<void> {
  const modes: readonly Mode[] = ["STRUCTURED", "JSON_OBJECT", "PROMPT_JSON"];

  console.log("capability matrix — what the server actually accepts\n");
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad("model", 46) + pad("catalog", 13) + pad("STRUCTURED", 20) + pad("JSON_OBJECT", 20) + "PROMPT_JSON");
  console.log("-".repeat(108));

  const rows: Record<string, Record<string, string>> = {};
  const mismatches: string[] = [];

  for (const model of DEFAULT_MODELS) {
    const privacyMode: PrivacyMode = model.zdrEligible ? "strict" : "relaxed";
    const config = loadConfig({
      INPUT_OPENROUTER_API_KEY: process.env["OPENROUTER_API_KEY_EVAL"] ?? process.env["OPENROUTER_API_KEY"] ?? "",
      INPUT_PRIVACY_MODE: privacyMode,
      INPUT_PRIMARY_MODEL: model.id,
      INPUT_FALLBACK_MODELS: "",
      INPUT_MAX_REQUESTS_PER_RUN: "5",
      INPUT_MAX_REQUESTS_PER_MINUTE: "20",
      INPUT_MAX_CONCURRENCY: "1",
      INPUT_DAILY_RESERVE: "0",
    });
    const client = new OpenRouterClient({ config });

    const catalogMode = model.supportsJsonSchema
      ? "STRUCTURED"
      : model.supportsResponseFormat
        ? "JSON_OBJECT"
        : "PROMPT_JSON";

    rows[model.id] = {};
    const cells: string[] = [];
    let best: Mode | null = null;

    for (const mode of modes) {
      const { status, detail } = await tryMode(model, mode, config, client);
      rows[model.id]![mode] = status;
      cells.push(pad(status === "OK" ? "OK" : `${status} ${detail}`, 20));
      if (status === "OK" && best === null) best = mode;
      await new Promise((r) => setTimeout(r, 2_500 + Math.random() * 1_500));
    }

    // The mode the action would actually pick, versus the best mode that works.
    const catalogWorks = rows[model.id]![catalogMode] === "OK";
    if (!catalogWorks && best !== null && best !== catalogMode) {
      mismatches.push(`${model.id}: catalog says ${catalogMode} (fails), but ${best} works`);
    }

    console.log(pad(model.id, 46) + pad(catalogMode, 13) + cells.join(""));
  }

  console.log("\nJSON: " + JSON.stringify(rows));

  if (mismatches.length > 0) {
    console.log("\nCATALOG MISMATCHES (catalog flag would route the action to a broken mode):");
    for (const m of mismatches) console.log(`  ${m}`);
  } else {
    console.log("\ncatalog matches measured capability for every model");
  }
}

async function main(): Promise<void> {
  if (process.env["PROBE_MODE"] === "matrix") {
    await matrix();
    return;
  }

  const attempts = Number.parseInt(process.env["PROBE_ATTEMPTS"] ?? "3", 10);
  const only = process.env["PROBE_ONLY"];

  const targets = DEFAULT_MODELS.filter((m) => (only ? m.id.includes(only) : true));
  const results: ProbeResult[] = [];

  console.log(`availability probe — ${targets.length} models, ${attempts} attempts each\n`);
  console.log("model".padEnd(46) + "mode".padEnd(13) + "ok".padEnd(7) + "429".padEnd(6) + "other".padEnd(8) + "median".padEnd(10) + "parse");
  console.log("-".repeat(96));

  for (const model of DEFAULT_MODELS) {
    if (!targets.some((t) => t.id === model.id)) continue;

    // ZDR model runs strict; everything else relaxed. Same rule as the quality
    // eval, so the two measurements describe the same configurations.
    const privacyMode: PrivacyMode = model.zdrEligible ? "strict" : "relaxed";

    const config = loadConfig({
      INPUT_OPENROUTER_API_KEY: process.env["OPENROUTER_API_KEY_EVAL"] ?? process.env["OPENROUTER_API_KEY"] ?? "",
      INPUT_PRIVACY_MODE: privacyMode,
      INPUT_PRIMARY_MODEL: model.id,
      INPUT_FALLBACK_MODELS: "",
      INPUT_MAX_REQUESTS_PER_RUN: "5",
      INPUT_MAX_REQUESTS_PER_MINUTE: "20",
      INPUT_MAX_CONCURRENCY: "1",
      INPUT_DAILY_RESERVE: "0",
    });

    const client = new OpenRouterClient({ config });
    const definition: ModelDefinition = { ...model, enabled: true };

    process.stdout.write(`  ${model.id} … `);
    const result = await probeModel(model.id, privacyMode, definition, attempts, config, client);
    results.push(result);

    console.log(
      `  ${result.modelId.padEnd(46)}${result.capabilityMode.padEnd(13)}${String(result.succeeded).padEnd(7)}` +
        `${String(result.rateLimited).padEnd(6)}${String(result.otherFailures).padEnd(8)}` +
        `${(result.medianLatencyMs === null ? "—" : `${result.medianLatencyMs}ms`).padEnd(10)}${result.parseErrors}`,
    );
    if (result.notes.length > 0) {
      console.log(`      ${result.notes.slice(0, 3).join(" | ")}`);
    }
  }

  const totalAttempts = results.reduce((n, r) => n + r.attempted, 0);
  const totalOk = results.reduce((n, r) => n + r.succeeded, 0);

  console.log(`\n${totalOk}/${totalAttempts} requests succeeded across ${results.length} models`);

  const unusable = results.filter((r) => r.succeeded === 0);
  if (unusable.length > 0) {
    console.log(`\nUNUSABLE as fallbacks (0/${attempts} succeeded):`);
    for (const r of unusable) console.log(`  ${r.modelId}`);
  }

  console.log(`\nJSON: ${JSON.stringify(results)}`);
}

void main();