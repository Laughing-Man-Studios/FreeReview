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
import { ConfigError, debugPayloadsFromEnv, loadConfig, type Config } from "./config.js";
import { createLogger, type Diagnostic, type DiagnosticCode, type Logger } from "./diagnostics.js";
import { GithubClient, GithubError } from "./github/client.js";
import { parseEventContext } from "./github/context.js";
import { getPullRequest, listPullRequestFiles } from "./github/pr.js";
import { evaluateEligibility, type EligibilityResult } from "./pipeline/eligibility.js";
import { CONFIG_VERSION, PROMPT_VERSION } from "./prompt/version.js";

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
  return { status, ...baseOutputs() };
}

/**
 * The non-status half of a run's outputs. `finish()` derives `status` from the
 * recorded diagnostics, so callers only supply the metrics they have measured.
 */
export function baseOutputs(): Omit<RunOutputs, "status"> {
  return {
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
 *
 * `no_findings` is deliberately NOT a fallback. It means "the review completed
 * and identified nothing". Reporting it whenever a run recorded an unrecognised
 * diagnostic would tell a human their code is clean when in fact it was never
 * examined, which is the single most damaging thing this action could do. A run
 * that produced no usable review says so.
 */
export function resolveStatus(diagnostics: readonly Diagnostic[]): RunStatus {
  if (diagnostics.some((d) => d.severity === "failure")) return "failed";

  // Ordered to mirror pipeline/eligibility.ts exactly. The two must agree: the
  // gate returns on its first failing check, so if the status table preferred a
  // different check it would report a reason the gate never actually reached,
  // and a developer would chase the wrong problem.
  const skipOrder: ReadonlyArray<readonly [RunStatus, ReadonlySet<DiagnosticCode>]> = [
    // 1. event
    ["skipped_unsupported_event", new Set(["UNSUPPORTED_EVENT"])],
    // 2. structural metadata (also catches a deleted head repository)
    ["skipped_unsupported_pr_source", new Set(["UNSUPPORTED_PR_SOURCE"])],
    // 3. PR state
    ["skipped_pr_closed", new Set(["PR_ALREADY_MERGED", "PR_CLOSED"])],
    ["skipped_draft_pr", new Set(["DRAFT_PR"])],
    // 4. trust boundary: privacy, then provenance
    ["skipped_public_repository", new Set(["PUBLIC_REPOSITORY"])],
    // 5. everything downstream of the gate
    ["skipped_diff_unavailable", new Set(["DIFF_FETCH_FAILED", "DIFF_TRUNCATED"])],
    ["skipped_pr_too_large", new Set(["PR_TOO_LARGE", "CONTEXT_TOO_LARGE"])],
    ["skipped_no_reviewable_files", new Set(["NO_REVIEWABLE_FILES"])],
    ["skipped_no_eligible_model", new Set(["NO_ELIGIBLE_MODEL", "NO_ELIGIBLE_PROVIDER"])],
    [
      "skipped_quota_exhausted",
      new Set([
        "OPENROUTER_QUOTA_EXHAUSTED",
        "REQUEST_BUDGET_EXHAUSTED",
        "RATE_LIMIT_BUDGET_THROTTLED",
      ]),
    ],
    [
      "skipped_upstream_unavailable",
      new Set(["OPENROUTER_RATE_LIMITED", "OPENROUTER_UNAVAILABLE"]),
    ],
    ["skipped_cancelled", new Set(["REQUEST_CANCELLED"])],
    ["skipped_stale", new Set(["STALE_HEAD_SHA", "HEAD_CHANGED_MID_RUN"])],
    // Every remaining expected-severity code is something that stopped a
    // usable review from being produced.
    [
      "skipped_no_usable_output",
      new Set([
        "MODEL_OUTPUT_INVALID",
        "MODEL_OUTPUT_EMPTY_RETRYABLE",
        "MODEL_OUTPUT_TRUNCATED",
        "MODEL_OUTPUT_TOO_LARGE",
        "FINDING_COUNT_EXCEEDED",
        "INJECTION_COMPLIANCE_SUSPECTED",
        "GITHUB_PUBLISH_FAILED",
        "GITHUB_PUBLISH_DEGRADED",
      ]),
    ],
  ];

  const codes = new Set(diagnostics.map((d) => d.code));
  for (const [status, members] of skipOrder) {
    if ([...members].some((code) => codes.has(code))) return status;
  }

  // Diagnostics present but none recognised: the review did not complete, and
  // reporting "no findings" would be a lie.
  if (diagnostics.length > 0) return "skipped_no_usable_output";

  return "reviewed";
}

// The pipeline assembled in Phases 2-6 supplies the remaining `await`s.
// Keeping the signature promise-returning now means the step summary and the
// exit-code mapping are already written against the final shape.
export async function run(env: NodeJS.ProcessEnv = process.env): Promise<RunOutputs> {
  // One logger for the whole run. Diagnostics recorded before config is
  // validated must still reach the step summary.
  const logger = createLogger({ debug: debugPayloadsFromEnv(env) });

  // --- 1. Event context (no API call, no config needed) ------------------
  // Deliberately before config validation: an action triggered on the wrong
  // event should report that, not complain about a missing API key it was
  // never going to use.
  const eventResult = parseEventContext(env);
  if (!eventResult.ok) {
    logger.log(eventResult.code, eventResult.detail);
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }
  const event = eventResult.context;
  logger.debug("event context parsed", {
    owner: event.owner,
    repo: event.repo,
    pull: event.pullNumber,
    action: event.action,
  });

  // --- 2. Credentials (no API call) --------------------------------------
  const token = env["GITHUB_TOKEN"];
  if (token === undefined || token.length === 0) {
    logger.log(
      "MISSING_CREDENTIALS",
      "GITHUB_TOKEN is not available. Invoke this action from a GitHub Actions workflow with " +
        "'permissions: pull-requests: write'.",
    );
    return finish(logger, baseOutputs(), "failed");
  }

  // --- 3. Configuration --------------------------------------------------
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.log("CONFIG_INVALID", error.detail, { input: error.input });
      return finish(logger, baseOutputs(), "failed");
    }
    throw error;
  }

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

  // --- 4. PR metadata (one API call) -------------------------------------
  const client = new GithubClient({ token });

  let pr;
  try {
    pr = await getPullRequest(client, event.owner, event.repo, event.pullNumber);
  } catch (error) {
    if (error instanceof GithubError) {
      // A 404 or 403 against a private repository means "not visible to this
      // token", which is a credential problem rather than a skippable PR. It
      // must be an action failure: a silent pass here reports a green run for a
      // token that could not read anything.
      const code: DiagnosticCode =
        error.kind === "not_found" || error.kind === "forbidden"
          ? "INVALID_GITHUB_CONTEXT"
          : "DIFF_FETCH_FAILED";
      logger.log(
        code,
        `Could not read pull request #${event.pullNumber}: ${error.message}`,
        { status: error.status, kind: error.kind },
      );
      return finish(logger, baseOutputs(), error.kind === "server" ? "skipped_early_exit" : "failed");
    }
    throw error;
  }

  // --- 5. Eligibility gate (no further API calls) -------------------------
  const eligibility: EligibilityResult = evaluateEligibility({
    event,
    pr,
    promptVersion: PROMPT_VERSION,
    configVersion: CONFIG_VERSION,
  });

  if (!eligibility.eligible) {
    logger.record(eligibility.diagnostic);
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }

  const { identity, totalChangedLines, changedFileCount } = eligibility;
  logger.info("PR is eligible for review", {
    pull: identity.pullNumber,
    head: identity.reviewHeadSha.slice(0, 7),
    base: identity.baseSha.slice(0, 7),
    changed_lines: totalChangedLines,
    changed_files: changedFileCount,
  });

  // --- 6. Changed files (paginated) --------------------------------------
  // Phase 1 stops here. Diff parsing is Phase 2, context construction Phase 3.
  // The retrieval path is exercised now so pagination and truncation flags are
  // proven before anything depends on them.
  let files;
  try {
    files = await listPullRequestFiles(client, identity.owner, identity.repo, identity.pullNumber);
  } catch (error) {
    if (error instanceof GithubError) {
      logger.log("DIFF_FETCH_FAILED", `Could not list changed files: ${error.message}`, {
        status: error.status,
        kind: error.kind,
      });
      return finish(logger, baseOutputs(), "skipped_early_exit");
    }
    throw error;
  }

  const binaryCount = files.filter((f) => !f.patch).length;
  logger.info("changed files retrieved", {
    total: files.length,
    reported: changedFileCount,
    without_patch: binaryCount,
  });

  if (files.length < changedFileCount) {
    logger.log(
      "DIFF_TRUNCATED",
      `GitHub reported ${changedFileCount} changed files but returned ${files.length}. ` +
        "The change list was truncated and the review would be incomplete.",
      { reported: changedFileCount, received: files.length },
    );
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }

  // Phase 1 stops here. Diff parsing is Phase 2, context construction Phase 3.
  // The retrieval path is exercised now so pagination and truncation flags are
  // proven before anything depends on them.
  return finish(
    logger,
    { ...baseOutputs(), files_reviewed: String(files.length) },
    "skipped_pipeline_not_implemented",
  );
}

/**
 * Build a run's outputs, deriving `status` from the diagnostics recorded so
 * far. `statusHint` lets a caller express intent for the (rare) case where no
 * diagnostic explains the outcome; it is used only when the diagnostics are
 * silent.
 */
function finish(
  logger: Logger,
  partial: Omit<RunOutputs, "status">,
  statusHint: RunStatus,
): RunOutputs {
  const resolved = resolveStatus(logger.diagnostics);
  const outputs: RunOutputs = {
    ...partial,
    // A diagnostics-derived status is always more informative than the hint.
    status: resolved === "reviewed" && statusHint !== "reviewed" ? statusHint : resolved,
  };
  appendStepSummary(summarise(logger, outputs));
  appendOutputs(outputs);
  return outputs;
}
