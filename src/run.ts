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
import {
  capabilityModeFor,
  ConfigError,
  debugPayloadsFromEnv,
  eligibleModels,
  loadConfig,
  type Config,
  type ModelDefinition,
} from "./config.js";
import { evaluateModel, fetchCatalog, fetchQuota, quotaDecision } from "./llm/catalog.js";
import { OpenRouterClient } from "./llm/client.js";
import { Scheduler } from "./llm/scheduler.js";
import { buildChatRequest, parseResponse } from "./prompt/index.js";
import { createLogger, type Diagnostic, type DiagnosticCode, type Logger } from "./diagnostics.js";
import { GithubClient, GithubError } from "./github/client.js";
import { parseEventContext } from "./github/context.js";
import { getPullRequest, listPullRequestFiles, type PrFile } from "./github/pr.js";
import { renderChunk, type RenderedChunk } from "./diff/render.js";
import { parseUnifiedDiff } from "./diff/parse.js";
import { buildChunks, chunkStats } from "./pipeline/chunk.js";
import { filterFiles } from "./pipeline/filter.js";
import { checkChangedLines, checkChunkBudgets, selectAffordableChunks } from "./pipeline/size-gate.js";
import { estimatorFromConfig } from "./pipeline/tokens.js";
import { evaluateEligibility, type EligibilityResult } from "./pipeline/eligibility.js";
import { CONFIG_VERSION, PROMPT_VERSION } from "./prompt/version.js";
import type { DiffFile, FileStatus, RawFinding } from "./types.js";

/**
 * Map GitHub's file status onto the parser's vocabulary.
 *
 * GitHub reports `removed` where the diff vocabulary says `deleted`, and adds
 * `changed`/`unchanged`, which are not file statuses at all. Anything
 * unrecognised is treated as `modified` rather than rejected, because a new
 * status value should not stop a review.
 */
function normaliseFileStatus(status: PrFile["status"]): FileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "modified";
  }
}

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

  // --- 7. Model eligibility and quota ------------------------------------
  // Both probes are free and both exist to avoid spending a request on
  // something knowable in advance. Neither is fatal: a probe failure degrades to
  // the configured assumptions, because refusing to review whenever OpenRouter
  // has a bad minute would make the tool useless.
  const catalog = await fetchCatalog();
  const usableModels = eligibleModels(config).filter((model) => {
    const mode = capabilityModeFor(model);
    const entry = evaluateModel(model, catalog, {
      inputTokens: config.maxInputTokens,
      outputTokens: config.maxOutputTokens,
      mode,
    });
    if (entry.problem === null) return true;
    logger.debug("model not usable", { model: model.id, reason: entry.problem });
    return false;
  });

  if (usableModels.length === 0) {
    logger.log(
      "NO_ELIGIBLE_MODEL",
      catalog === null
        ? "No configured model is usable, and the OpenRouter catalog could not be read to " +
          "confirm why. Check that the configured models are free, present, and support the " +
          "required capabilities."
        : "No configured free model satisfies this configuration. Under strict privacy, a " +
          "model must have a ZDR endpoint with no data collection, which not every free " +
          "provider offers. Try privacy_mode=relaxed or a different model.",
      { configured: config.models.length, catalog_available: catalog !== null },
    );
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }

  logger.info("eligible models", {
    count: usableModels.length,
    primary: usableModels[0]?.id,
    catalog: catalog === null ? "unavailable" : "verified",
  });

  // --- 8. Coarse size gate ------------------------------------------------
  // Rejected before any parsing, because it is the cheap decision and its only
  // job is to avoid spending quota on a PR that could never produce a useful
  // review.
  const sizeGate = checkChangedLines({
    totalChangedLines,
    maxChangedLines: config.maxChangedLines,
    filesConsidered: changedFileCount,
  });
  if (!sizeGate.ok) {
    logger.record(sizeGate.diagnostic);
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }

  // --- 8. Parse every available patch ------------------------------------
  // One file that fails to parse is skipped rather than failing the run, and
  // reported as a coverage gap. A single corrupt patch from GitHub should not
  // prevent review of the other 39 files.
  const estimator = estimatorFromConfig(config);
  const parsed: DiffFile[] = [];
  let parseFailures = 0;

  for (const entry of files) {
    if (entry.patch === undefined) continue;
    try {
      parsed.push(
        parseUnifiedDiff(entry.patch, {
          path: entry.filename,
          status: normaliseFileStatus(entry.status),
          ...(entry.previous_filename === undefined
            ? {}
            : { previousPath: entry.previous_filename }),
        }),
      );
    } catch (error) {
      parseFailures += 1;
      logger.debug("could not parse a file's patch", {
        path: entry.filename,
        reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
      });
    }
  }

  if (parseFailures > 0) {
    logger.log(
      "DIFF_PARSE_FAILED",
      `${parseFailures} file diff(s) could not be parsed and were skipped. ` +
        "The rest of the pull request was still processed.",
      { failed: parseFailures, parsed: parsed.length },
    );
  }

  // --- 9. Filter and chunk -----------------------------------------------
  const filtered = filterFiles(parsed, (text) => estimator.text(text));

  for (const change of filtered.dependencyChanges) {
    logger.annotation(`Dependency change: ${change}`);
  }
  for (const gap of filtered.coverageGaps) {
    logger.log(
      "DIFF_TRUNCATED",
      `Not fully reviewed: ${gap.path} — ${gap.detail}`,
      { path: gap.path },
    );
  }
  logger.debug("files filtered", {
    included: filtered.included.length,
    excluded: filtered.excluded.length,
  });

  if (filtered.included.length === 0) {
    logger.log(
      "NO_REVIEWABLE_FILES",
      changedFileCount > 0
        ? `None of the ${changedFileCount} changed files contained reviewable source. ` +
          "This usually means the change is only assets, generated output, or lockfiles."
        : "The pull request has no changed files to review.",
      { changed_files: changedFileCount },
    );
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }

  const chunks = buildChunks(filtered.included, estimator);
  const stats = chunkStats(chunks);

  logger.info("review context built", {
    files: stats.files,
    chunks: stats.chunks,
    max_chunk_tokens: stats.maxChunkTokens,
    budget_tokens: estimator.budgetForChunk(),
    split_hunks: stats.splitHunks,
  });

  if (chunks.length === 0) {
    logger.log(
      "CONTEXT_TOO_LARGE",
      "The reviewable diff could not be packed into a single request. " +
        "Raise max_input_tokens or review a smaller pull request.",
      { budget_tokens: estimator.budgetForChunk() },
    );
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }

  // --- 10. Render and verify the budget ---------------------------------
  // The renderer adds a banner, fence, and file headers on top of what the
  // chunker measured, so the check is against the *rendered* cost. This is a
  // runtime assertion: sending a request we expect to be rejected wastes one of
  // 50 daily requests.
  const rendered = chunks.map((chunk) =>
    renderChunk(
      chunk,
      {
        owner: identity.owner,
        repo: identity.repo,
        pullNumber: identity.pullNumber,
        headSha: identity.reviewHeadSha,
        pullTitle: pr.title,
        fileCount: stats.files,
      },
      (text) => estimator.text(text),
    ),
  );

  const budgetCheck = checkChunkBudgets(
    rendered.map((r) => r.estimatedTokens),
    estimator,
  );
  if (!budgetCheck.ok) {
    logger.record(budgetCheck.diagnostic);
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }

  const affordable = selectAffordableChunks(chunks, config.maxRequestsPerRun);
  if (affordable.dropped > 0) {
    logger.annotation(
      `This pull request produced ${chunks.length} chunks but only ` +
        `${affordable.selected.length} fit within max_requests_per_run ` +
        `(${config.maxRequestsPerRun}). ${affordable.dropped} chunk(s) were not reviewed.`,
    );
  }

  // --- Quota preflight ----------------------------------------------------
  // Placed after chunk selection because the comparison is against the number
  // of requests actually planned, which is only known once the run budget has
  // trimmed the chunk list. The scheduler receives the *true* remaining count
  // and applies the reserve itself, so the two cannot drift.
  const quota = await fetchQuota(config);
  const decision = quotaDecision(quota, config.dailyReserve, affordable.selected.length);

  if (!decision.proceed) {
    logger.log("OPENROUTER_QUOTA_EXHAUSTED", decision.reason, {
      remaining: quota?.remaining ?? undefined,
      limit: quota?.limit ?? undefined,
    });
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }
  logger.info("quota", { detail: decision.reason, free_tier: quota?.isFreeTier ?? undefined });

  logger.info("context ready", {
    chunks_to_review: affordable.selected.length,
    dropped: affordable.dropped,
    prompt_tokens: rendered.reduce((sum, r) => sum + r.estimatedTokens, 0),
  });

  // --- 11. Review ------------------------------------------------------
  // The first code path that spends quota. Everything above it is free.
  //
  // Findings are collected across chunks without being anchored or published
  // yet. Validation, deduplication, stale-checking, and publication are Phase 6;
  // stopping here means the output is "the model said this" and nothing more,
  // which is the honest state of affairs at this boundary.
  const openRouter = new OpenRouterClient({ config });
  const scheduler = new Scheduler({ client: openRouter, config });
  // The scheduler needs the true remaining count and applies the reserve itself.
  scheduler.setDailyRemaining(quota?.remaining ?? null);

  const findings: RawFinding[] = [];
  const modelsUsed = new Set<string>();
  let chunksReviewed = 0;

  for (const [index] of affordable.selected.entries()) {
    // Every eligible model is offered, in priority order. The scheduler reaches
    // a later one only through a failure that warrants it, so this does not
    // fan out across the pool. The primary seeds the request shape; the
    // scheduler substitutes the model id per attempt.
    const outcome = await scheduler.runTask(
      buildChatRequest(
        rendered[index] as RenderedChunk,
        usableModels[0] as ModelDefinition,
        config.maxOutputTokens,
      ),
      usableModels,
    );

    if (!outcome.ok) {
      logger.log(outcome.diagnostic, `Chunk ${index + 1} could not be reviewed.`, {
        requests_spent: outcome.requestsSpent,
        attempts: outcome.attempts.map((a) => `${a.modelId}:${a.outcome}`).join(", "),
      });
      continue;
    }

    modelsUsed.add(outcome.result.modelId);
    chunksReviewed += 1;

    const parsed = parseResponse(outcome.result.content, outcome.result.parsed);
    if (!parsed.ok) {
      logger.log(
        parsed.unparseable ? "MODEL_OUTPUT_INVALID" : "MODEL_OUTPUT_INVALID",
        `Chunk ${index + 1} returned output that did not match the finding schema.`,
        { issues: parsed.issues.slice(0, 4).map((i) => `${i.path}: ${i.message}`).join("; ") },
      );
      continue;
    }

    for (const note of parsed.notes) {
      logger.debug("model output note", { chunk: index, note });
    }

    // A model that returns nothing is a valid answer, and the single most useful
    // one. It must not be recorded as a failure, and it must not be allowed to
    // silently become "this file is clean" in the summary.
    if (parsed.value.findings.length === 0) {
      logger.debug("chunk reviewed, no findings", { chunk: index });
    }

    findings.push(
      ...parsed.value.findings.map(
        (f): RawFinding => ({
          path: f.path,
          buggyCodeQuote: f.buggyCodeQuote,
          explanation: f.explanation,
          severity: f.severity,
          suggestedCode: f.suggestedCode,
        }),
      ),
    );

    logger.debug("chunk reviewed", {
      chunk: index,
      findings: parsed.value.findings.length,
      model: outcome.result.modelId,
      prompt_tokens: outcome.result.usage.promptTokens,
      completion_tokens: outcome.result.usage.completionTokens,
    });
  }

  const requestsUsed = scheduler.budget.spent;

  logger.info("review complete", {
    chunks_reviewed: chunksReviewed,
    chunks_planned: affordable.selected.length,
    findings: findings.length,
    requests_used: requestsUsed,
  });

  if (findings.length > config.maxFindingsPerChunk * Math.max(1, chunksReviewed)) {
    logger.log(
      "FINDING_COUNT_EXCEEDED",
      `The model produced ${findings.length} findings across ${chunksReviewed} chunks, above the ` +
        `configured expectation of ${config.maxFindingsPerChunk} per chunk. This usually means the ` +
        "model is padding with stylistic observations rather than reporting defects.",
      { findings: findings.length, chunks: chunksReviewed },
    );
  }

  // Phase 6 anchors, deduplicates, and publishes. Until then nothing reaches a
  // pull request, which is deliberate: an unanchored finding has no safe
  // destination.
  return finish(
    logger,
    {
      ...baseOutputs(),
      files_reviewed: String(stats.files),
      findings_count: String(findings.length),
      model_used: [...modelsUsed].join(","),
      requests_used: String(requestsUsed),
    },
    "skipped_publisher_not_implemented",
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
