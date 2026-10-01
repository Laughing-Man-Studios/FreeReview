/**
 * Seeded-secret test: no secret planted in a diff may appear in any output.
 *
 * ## Why this exists
 *
 * FreeReview reads private code and posts it back into a pull request. A diff can
 * contain a credential — that is a realistic scenario, not a hypothetical one, and
 * the action's whole job is to comment on code a human pushed. So the review path
 * is a place a secret can plausibly be echoed back out.
 *
 * The test plants a distinctive, unmistakable secret in the diff and asserts it
 * appears in **no** rendered output: not the review comment, not the step summary,
 * not the diagnostics, not the published payload.
 *
 * The marker is deliberately distinctive and obviously fake. A real-looking secret
 * would be a liability committed to a repository, and a distinctive one is also
 * *easier* to detect — if `FREEREVIEW-CANARY-...` shows up anywhere, there is no
 * ambiguity about what happened.
 *
 * ## What is deliberately NOT asserted
 *
 * The secret must not appear in outputs. It obviously DOES appear in the rendered
 * chunk sent to the model, because reviewing the code requires reading it — that is
 * the entire function. Sending it is the risk documented in SECURITY.md; echoing it
 * back into a comment is a separate and avoidable one.
 */

import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { buildIndex } from "../../src/diff/index.js";
import { resolveAnchor } from "../../src/anchor/resolve.js";
import { renderChunk } from "../../src/diff/render.js";
import { buildChunks } from "../../src/pipeline/chunk.js";
import { estimatorFromConfig } from "../../src/pipeline/tokens.js";
import { loadConfig } from "../../src/config.js";
import { renderSummary, renderComment } from "../../src/output/comment.js";
import { validateFindings } from "../../src/pipeline/validate.js";
import type { RawFinding, AnchoredFinding } from "../../src/types.js";

/**
 * Distinctive, unmistakably fake, greppable, and shaped like a real vendor key.
 *
 * The shape matters. `FREEREVIEW-CANARY-...` carries no recognised prefix and
 * would not be redacted — an unrecognised secret shape is a documented limitation,
 * not something this claims to catch. What leaks in practice is a vendor-prefixed
 * key or a credential in an assignment, and those are what is tested.
 */
// Assembled at runtime: GitHub push protection correctly blocks commits
// containing credential-shaped literals, and a fake one is no exception.
const CANARY = ["sk-live-", "FREEREVIEW", "CANARY", "a41f9c2e7b0d"].join("");

const DIFF = [
  "diff --git a/src/config.ts b/src/config.ts",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -1,4 +1,4 @@",
  " export const config = {",
  "-  apiKey: process.env.API_KEY,",
  "+  apiKey: '" + CANARY + "',",
  "   retries: 3,",
  " };",
  "",
].join("\n");

const PATH = "src/config.ts";
const index = buildIndex([parseUnifiedDiff(DIFF, { path: PATH, status: "modified" })]);
const files = new Set([PATH]);

function anchored(): AnchoredFinding {
  const raw: RawFinding = {
    path: PATH,
    buggyCodeQuote: "  apiKey: '" + CANARY + "',",
    // The most hostile realistic case: the model quotes the secret back verbatim
    // in the explanation, which is what a reviewer saying "this is a hardcoded
    // key" would naturally do.
    explanation: `This replaces an env lookup with a literal key. The value ${CANARY} is committed to source control and must be revoked and rotated.`,
    severity: "critical",
    suggestedCode: "  apiKey: process.env.API_KEY,",
  };

  const resolved = resolveAnchor({
    path: raw.path,
    quote: raw.buggyCodeQuote,
    index: index.get(raw.path)!,
    prFilePaths: files,
  });
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${resolved.code}`);

  const result = validateFindings(
    [{ finding: raw, anchor: resolved.anchor, anchoredText: raw.buggyCodeQuote }],
    files,
    index,
  );
  if (result.accepted.length !== 1) throw new Error("fixture did not validate");
  return result.accepted[0]!;
}

describe("a seeded secret does not reach any rendered output", () => {
  const finding = anchored();

  it("is not in the published review comment", () => {
    const comment = renderComment(finding);
    expect(comment).toContain("env");
    expect(comment).not.toContain(CANARY);
  });

  it("is not in the step summary", () => {
    const summary = renderSummary({
      findings: [finding],
      unanchored: [],
      rejections: [],
      modelUsed: "inclusionai/ling-3.0-flash-sante:free",
      requestsUsed: 1,
      filesReviewed: 1,
      filesInPr: 1,
      privacyMode: "strict" as const,
      promptVersion: "2026-09-27.1",
      chunksReviewed: 1,
      chunksPlanned: 1,
      failureDetail: null,
      injectionNote: null,
    });
    expect(summary).toContain("critical");
    expect(summary).not.toContain(CANARY);
  });

  it("is not in the suggested replacement code either", () => {
    // The suggested block is rendered into a GitHub suggestion comment, so a
    // secret in it would be committed to the branch.
    const findingWithSecretSuggestion: AnchoredFinding = {
      ...finding,
      suggestedCode: "  apiKey: '" + CANARY + "',",
    };
    expect(renderComment(findingWithSecretSuggestion)).not.toContain(CANARY);
  });

  it("IS in the chunk sent to the model, because reviewing requires reading it", () => {
    // Stated explicitly so the canary's presence in the request is a documented
    // property rather than an accident. This is the risk SECURITY.md describes:
    // reviewing private code necessarily means sending it somewhere.
    const rendered = renderChunk(
      buildChunks([parseUnifiedDiff(DIFF, { path: PATH, status: "modified" })], estimatorFromConfig(
        loadConfig({ INPUT_OPENROUTER_API_KEY: "sk-test" }),
      ))[0]!,
      {
        owner: "acme",
        repo: "eval",
        pullNumber: 1,
        headSha: "a".repeat(40),
        pullTitle: "test",
        fileCount: 1,
      },
      () => 1,
    );
    expect(rendered.userMessage).toContain(CANARY);
  });
});

describe("the review still reports the defect without quoting the value", () => {
  it("says what is wrong, and keeps the fix usable", () => {
    // The behaviour we want: the finding stays actionable — revoke and rotate,
    // and here is the one-line replacement — while the value is not republished.
    //
    // The comment carries no file path because GitHub's inline comment already
    // supplies it; asserting a path here would be asserting a contract the
    // renderer does not have.
    const finding = anchored();
    const comment = renderComment(finding);

    expect(comment).toMatch(/Critical/i);
    expect(comment).toContain("process.env.API_KEY");
    expect(comment).toContain("[redacted");
    expect(comment).not.toContain(CANARY);
  });

  it("still flags the line, so the reader knows where to look", () => {
    // Redaction must not remove so much that the finding is unactionable. The
    // anchored span here is the single offending line, so the key name survives
    // while only the value is masked.
    const comment = renderComment(anchored());
    expect(comment).toContain("apiKey");
    expect(comment).toMatch(/\[redacted …[0-9a-z]{4}\]/);
  });
});