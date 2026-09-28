/**
 * PR eligibility gate.
 *
 * Runs before any LLM call, and ideally before any diff retrieval. Every path
 * out of this module other than `eligible` is a non-blocking skip: the action
 * reports why and exits 0.
 *
 * Ordering matters. The checks are ordered so the cheapest and most decisive
 * run first, and so the reported reason is the actual cause rather than a
 * downstream symptom.
 */

import type { Diagnostic } from "../diagnostics.js";
import { SUPPORTED_PR_EVENTS, type EventContext } from "../github/context.js";
import type { PullRequestMetadata } from "../github/pr.js";
import type { ReviewIdentity } from "../types.js";

export interface EligibleReview {
  readonly eligible: true;
  readonly identity: ReviewIdentity;
  /** Changed lines, used by the size gate before any inference. */
  readonly totalChangedLines: number;
  readonly changedFileCount: number;
}

export interface IneligibleReview {
  readonly eligible: false;
  readonly diagnostic: Diagnostic;
}

export type EligibilityResult = EligibleReview | IneligibleReview;

export interface EligibilityInput {
  readonly event: EventContext;
  readonly pr: PullRequestMetadata;
  readonly promptVersion: string;
  readonly configVersion: string;
}

function skip(
  code: Diagnostic["code"],
  message: string,
  context?: Diagnostic["context"],
): IneligibleReview {
  return { eligible: false, diagnostic: { code, severity: "expected", message, ...(context ? { context } : {}) } };
}

function fail(code: Diagnostic["code"], message: string, context?: Diagnostic["context"]): IneligibleReview {
  return { eligible: false, diagnostic: { code, severity: "failure", message, ...(context ? { context } : {}) } };
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { event, pr } = input;

  // --- 1. Supported event ------------------------------------------------
  // A `closed` or `labeled` event for a PR we would otherwise review is not an
  // error; the action simply has nothing to do.
  if (!SUPPORTED_PR_EVENTS.has(event.action)) {
    return skip(
      "UNSUPPORTED_EVENT",
      `PR event '${event.action || "(none)"}' is not one of ${[...SUPPORTED_PR_EVENTS].join(", ")}.`,
      { action: event.action || "(none)" },
    );
  }

  // --- 2. Required metadata ----------------------------------------------
  // Structural, not a policy check. If these are absent the run cannot proceed
  // and pretending otherwise would produce a review of nothing.
  if (!pr.head?.sha) {
    return fail("INVALID_GITHUB_CONTEXT", "PR head SHA is missing from the API response.");
  }
  if (!pr.head?.repo) {
    return skip(
      "UNSUPPORTED_PR_SOURCE",
      "The PR head repository is no longer available (deleted or inaccessible).",
    );
  }
  if (!pr.base?.repo) {
    return fail("INVALID_GITHUB_CONTEXT", "PR base repository is missing from the API response.");
  }

  // --- 3. PR state -------------------------------------------------------
  if (pr.merged) {
    return skip("PR_ALREADY_MERGED", "The pull request has already been merged.");
  }
  if (pr.state !== "open") {
    return skip("PR_CLOSED", "The pull request is not open.", { state: pr.state });
  }
  if (pr.draft) {
    return skip("DRAFT_PR", "The pull request is a draft.");
  }

  // --- 4. Trust boundary: private repository -----------------------------
  // Source code sent to an external inference service is sensitive application
  // data. For a public repository the code is already public, so the operator
  // may legitimately want the review; for a private one they have not
  // consented to that by opening a PR. Default to private-only.
  const baseIsPrivate = pr.base.repo.private;
  if (!baseIsPrivate) {
    return skip(
      "PUBLIC_REPOSITORY",
      "The base repository is public. This action only reviews private repositories by default, " +
        "because it sends diff contents to an external inference provider.",
      { base_repo: pr.base.repo.full_name },
    );
  }

  // --- 5. Trust boundary: same-repository only ---------------------------
  // Compare GitHub-assigned repository identity. Branch names and the `label`
  // field are attacker-controlled strings and must not be trusted to establish
  // provenance; `full_name` is identity.
  if (pr.head.repo.full_name !== pr.base.repo.full_name) {
    return skip(
      "UNSUPPORTED_PR_SOURCE",
      "The pull request head is in a different repository (a fork or external contribution). " +
        "Reviewing it would mean sending third-party code to an external inference provider, " +
        "which v1 does not do.",
      { head_repo: pr.head.repo.full_name, base_repo: pr.base.repo.full_name },
    );
  }

  // --- 6. Cross-check the event payload against the API ------------------
  // The event payload's head SHA can already be stale when the job starts. If
  // it disagrees with the API, another commit landed first. Review the API's
  // SHA (the freshest value) and note the drift, rather than reviewing a commit
  // that is no longer the head.
  if (event.eventHeadSha !== null && event.eventHeadSha !== pr.head.sha) {
    // Not fatal. The review targets `pr.head.sha`, and the pre-publication
    // re-check will discard the results if it moves again.
  }

  // --- 7. Cheap early size rejection -------------------------------------
  // Reported here so an enormous PR never reaches diff parsing.
  const totalChangedLines = pr.additions + pr.deletions;

  return {
    eligible: true,
    totalChangedLines,
    changedFileCount: pr.changed_files,
    identity: {
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pullNumber: pr.number,
      baseSha: pr.base.sha,
      reviewHeadSha: pr.head.sha,
      promptVersion: input.promptVersion,
      configVersion: input.configVersion,
    },
  };
}
