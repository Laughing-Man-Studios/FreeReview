/**
 * Run orchestration.
 *
 * Exported separately from `index.ts` so tests can drive a run without the
 * module self-executing on import. This module decides *what happens in what
 * order*; every decision that can be made deterministically lives in a
 * subsystem module.
 *
 * Phase 0 scope: config load, diagnostics, outputs, step summary. The review
 * pipeline is assembled in Phases 1-6.
 */

import { appendFileSync } from "node:fs";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createLogger, type Diagnostic, type DiagnosticCode, type Logger } from "./diagnostics.js";

export type RunStatus =
  | "reviewed"
  | "no_findings"
  | `skipped_${string}`
  | "failed";

export interface RunOutputs {
  status: RunStatus;
  findings_count: string;
  unanchored_count: string;
  files_reviewed: string;
  model_used: string;
  requests_used: string;
  review_url: string;
}

export function emptyOutputs(status: RunStatus): RunOutputs {
  return {
    status,
    findings_count: "0",
    unanchored_count: "0",
    files_reviewed: "0",
    model_used: "",
    requests_used: "0",
    review_url: "",
  };
}

/**
 * Append outputs to the workflow output file.
 *
 * GitHub's output file format is `KEY=value` per line. A value containing a
 * newline would be read as a malformed additional key, so newlines are
 * flattened rather than trusted.
 */
export function appendOutputs(outputs: RunOutputs, env: NodeJS.ProcessEnv = process.env): void {
  const path = env["GITHUB_OUTPUT"];
  if (!path) return;
  const keys = Object.keys(outputs) as (keyof RunOutputs)[];
  const body = keys.map((k) => `${k}=${outputs[k].replace(/[\r\n]+/g, " ")}`).join("\n");
  appendFileSync(path, `${body}\n`, "utf8");
}

export function appendStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = env["GITHUB_STEP_SUMMARY"];
  if (!path) return;
  appendFileSync(path, `${markdown}\n`, "utf8");
}

export function summarise(logger: Logger, outputs: RunOutputs): string {
  const counts = logger.counts();
  const rows = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, n]) => `| \`${code}\` | ${n} |`)
    .join("\n");

  return [
    "## FreeReview",
    "",
    `**Status:** \`${outputs.status}\``,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Findings published | ${outputs.findings_count} |`,
    `| Unanchored (not published inline) | ${outputs.unanchored_count} |`,
    `| Files reviewed | ${outputs.files_reviewed} |`,
    `| Model | ${outputs.model_used || "—"} |`,
    `| OpenRouter requests used | ${outputs.requests_used} |`,
    "",
    rows.length > 0
      ? ["### Diagnostics", "", "| Code | Count |", "| --- | --- |", rows].join("\n")
      : "_No diagnostics recorded._",
    "",
  ].join("\n");
}

/**
 * Derive the terminal status from the diagnostics recorded during the run.
 *
 * A run that recorded any `failure`-severity diagnostic is a failed run.
 * Otherwise the most specific skip reason observed wins, ordered by how early it
 * occurs in the pipeline, so the reported reason is the actual cause rather
 * than a downstream symptom.
 */
export function resolveStatus(diagnostics: readonly Diagnostic[]): RunStatus {
  if (diagnostics.some((d) => d.severity === "failure")) return "failed";

  const skipOrder: ReadonlyArray<readonly [RunStatus, ReadonlySet<DiagnosticCode>]> = [
    ["skipped_unsupported_pr_source", new Set(["UNSUPPORTED_PR_SOURCE", "PUBLIC_REPOSITORY"])],
    ["skipped_unsupported_event", new Set(["UNSUPPORTED_EVENT"])],
    ["skipped_draft_pr", new Set(["DRAFT_PR"])],
    ["skipped_pr_closed", new Set(["PR_CLOSED", "PR_ALREADY_MERGED"])],
    ["skipped_pr_too_large", new Set(["PR_TOO_LARGE", "CONTEXT_TOO_LARGE"])],
    ["skipped_no_reviewable_files", new Set(["NO_REVIEWABLE_FILES"])],
    ["skipped_no_eligible_model", new Set(["NO_ELIGIBLE_MODEL", "NO_ELIGIBLE_PROVIDER"])],
    [
      "skipped_quota_exhausted",
      new Set(["OPENROUTER_QUOTA_EXHAUSTED", "REQUEST_BUDGET_EXHAUSTED"]),
    ],
    [
      "skipped_upstream_unavailable",
      new Set(["OPENROUTER_RATE_LIMITED", "OPENROUTER_UNAVAILABLE"]),
    ],
    ["skipped_stale", new Set(["STALE_HEAD_SHA", "HEAD_CHANGED_MID_RUN"])],
  ];

  const codes = new Set(diagnostics.map((d) => d.code));
  for (const [status, members] of skipOrder) {
    if ([...members].some((code) => codes.has(code))) return status;
  }

  return diagnostics.length > 0 ? "no_findings" : "reviewed";
}

// `async` with no `await` yet: the pipeline assembled in Phases 1-6 supplies
// them. Keeping the signature promise-returning now means the step summary and
// the exit-code mapping are already written against the final shape and do not
// change when the pipeline lands.
// eslint-disable-next-line @typescript-eslint/require-await
export async function run(env: NodeJS.ProcessEnv = process.env): Promise<RunOutputs> {
  const probeLogger = createLogger();

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      probeLogger.log("CONFIG_INVALID", error.detail, { input: error.input });
      const outputs = emptyOutputs("failed");
      appendStepSummary(summarise(probeLogger, outputs), env);
      appendOutputs(outputs, env);
      return outputs;
    }
    throw error;
  }

  const logger = createLogger({ debug: config.debugPayloads });

  logger.info("FreeReview starting", {
    privacy_mode: config.privacyMode,
    models: config.models.length,
    max_requests_per_run: config.maxRequestsPerRun,
    max_input_tokens: config.maxInputTokens,
  });

  if (config.privacyMode === "relaxed") {
    logger.annotation(
      "privacy_mode=relaxed: this review was sent WITHOUT zero-data-retention enforcement. " +
        "Providers may retain prompts and outputs. Use privacy_mode=strict to require " +
        "provider.zdr=true and provider.data_collection='deny'.",
    );
  }

  if (config.debugPayloads) {
    logger.annotation(
      "debug_payloads=true: full prompt bodies and model responses will be written to the " +
        "workflow log. This exposes proprietary source code to anyone who can read the log.",
    );
  }

  // Phase 1 wires the pipeline here. Until then this run is a no-op that
  // reports honestly rather than pretending to have reviewed anything.
  const outputs = emptyOutputs("skipped_pipeline_not_implemented");
  appendStepSummary(summarise(logger, outputs), env);
  appendOutputs(outputs, env);
  return outputs;
}
