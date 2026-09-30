/**
 * The evaluation harness.
 *
 * Turns a fixture into a real request, sends it, and turns the response back into
 * model findings. Deliberately reuses the shipped pipeline modules rather than
 * reimplementing them, because a harness that diverges from production measures
 * a system nobody ships.
 *
 * ## The one thing that differs from the action
 *
 * `privacyMode`. The action runs under whatever the consumer chose. The
 * evaluation runs each model under the mode it would actually be selected in:
 * the ZDR model under `strict` (which is the default and therefore what ships),
 * the others under `relaxed`. Running a non-ZDR model under `strict` would
 * produce a 404 for every request and tell us nothing about the model.
 *
 * ## Pacing
 *
 * 10 requests per minute, one at a time, with jitter. The binding constraint is
 * not the 1000/day ceiling but the single upstream provider behind the one ZDR
 * model, which was observed returning `429 upstream_provider_shared_pool` under
 * load during Phase 6. A full pass takes about 90 seconds instead of 20, and
 * that trade is worth it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { buildChunks, chunkStats } from "../../src/pipeline/chunk.js";
import { filterFiles } from "../../src/pipeline/filter.js";
import { buildIndex } from "../../src/diff/index.js";
import { renderChunk } from "../../src/diff/render.js";
import { buildChatRequest, parseResponse } from "../../src/prompt/index.js";
import { resolveAnchor } from "../../src/anchor/resolve.js";
import { estimatorFromConfig, type TokenEstimator } from "../../src/pipeline/tokens.js";
import { loadConfig, type Config, type ModelDefinition, type PrivacyMode } from "../../src/config.js";
import { OpenRouterClient } from "../../src/llm/client.js";
import { Scheduler } from "../../src/llm/scheduler.js";
import type { Fixture } from "./fixtures.js";
import { renderFile, renderFixtureJson } from "./render.js";
import type { ModelFinding } from "./score.js";
import type { DiffFile, FileStatus } from "../../src/types.js";

export interface LoadedFixture {
  readonly fixture: Fixture;
  readonly diffs: readonly DiffFile[];
  readonly index: ReturnType<typeof buildIndex>;
  readonly prFilePaths: ReadonlySet<string>;
}

/** Load a fixture from the committed artefacts, not the source module. */
export function loadFixture(root: string, fixture: Fixture): LoadedFixture {
  const dir = join(root, fixture.id);
  const head = JSON.parse(readFileSync(join(dir, "head.json"), "utf8")) as {
    filename: string;
    status: string;
    previous_filename?: string;
    patch: string;
  }[];

  const diffs = head.map((entry) =>
    parseUnifiedDiff(entry.patch, {
      path: entry.filename,
      status: entry.status as FileStatus,
      ...(entry.previous_filename === undefined ? {} : { previousPath: entry.previous_filename }),
    }),
  );

  return {
    fixture,
    diffs,
    index: buildIndex(diffs),
    prFilePaths: new Set(head.map((e) => e.filename)),
  };
}

/** Render a fixture's chunks, exactly as the action would. */
export interface RenderedFixture {
  readonly messages: readonly { path: string; fileCount: number }[];
  readonly chunks: ReturnType<typeof renderChunk>[];
  readonly estimator: TokenEstimator;
}

export function renderFixtureForEval(
  loaded: LoadedFixture,
  config: Config,
  context: { owner: string; repo: string; pullNumber: number; headSha: string; title: string },
): RenderedFixture {
  const estimator = estimatorFromConfig(config);
  const filtered = filterFiles(loaded.diffs, (text) => estimator.text(text));
  const chunks = buildChunks(filtered.included, estimator);
  const stats = chunkStats(chunks);

  const rendered = chunks.map((chunk) =>
    renderChunk(
      chunk,
      {
        owner: context.owner,
        repo: context.repo,
        pullNumber: context.pullNumber,
        headSha: context.headSha,
        pullTitle: context.title,
        fileCount: stats.files,
      },
      (text) => estimator.text(text),
    ),
  );

  return { messages: chunks.map(() => ({ path: "", fileCount: stats.files })), chunks: rendered, estimator };
}

export interface EvalModel {
  readonly id: string;
  readonly privacyMode: PrivacyMode;
  /** A ZDR model must be evaluated under strict; that is the mode it ships in. */
  readonly definition: ModelDefinition;
}

/**
 * Turn a raw response into model findings, anchoring each one.
 *
 * Anchoring is the same resolver the action uses, so a finding the harness
 * counts as correctly placed would also be publishable, and vice versa.
 */
export function findingsFromResponse(
  content: string,
  parsed: unknown,
  index: ReturnType<typeof buildIndex>,
  prFilePaths: ReadonlySet<string>,
): { findings: ModelFinding[]; parseError: string | null } {
  const result = parseResponse(content, parsed);
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    return { findings: [], parseError: detail || "unparseable response" };
  }

  const findings: ModelFinding[] = [];

  for (const raw of result.value.findings) {
    const fileIndex = index.get(raw.path.normalize("NFC"));
    const resolution =
      fileIndex === undefined
        ? ({ ok: false, code: "PATH_NOT_IN_PR", rung: 0, candidateCount: 0, detail: "no index" } as const)
        : resolveAnchor({ path: raw.path, quote: raw.buggyCodeQuote, index: fileIndex, prFilePaths });

    findings.push({
      path: raw.path,
      quote: raw.buggyCodeQuote,
      explanation: raw.explanation,
      severity: raw.severity,
      anchor: resolution.ok ? resolution.anchor : null,
      anchorError: resolution.ok ? null : resolution.code,
    });
  }

  return { findings, parseError: null };
}

/**
 * Sleep with full jitter.
 *
 * Full jitter rather than a fixed delay, so concurrent runs do not synchronise
 * and collide again on the same provider window.
 */
export function jitteredDelay(baseMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * baseMs));
}

export { loadConfig, OpenRouterClient, Scheduler, buildChatRequest, renderFile, renderFixtureJson };
export type { Config, ModelDefinition, PrivacyMode };
