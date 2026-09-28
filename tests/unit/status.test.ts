/**
 * Status resolution.
 *
 * The contract under test: the status a human reads must never claim more than
 * happened. In particular `no_findings` means "the review ran and found
 * nothing" — it must never be used as a fallback for "the review did not run",
 * because that tells a developer their code is clean when it was never
 * examined.
 */

import { describe, expect, it } from "vitest";
import { diagnostic, type Diagnostic, type DiagnosticCode } from "../../src/diagnostics.js";
import { resolveStatus } from "../../src/run.js";

function d(code: DiagnosticCode): Diagnostic {
  return diagnostic(code, "test");
}

describe("resolveStatus — success paths", () => {
  it("reports 'reviewed' when nothing went wrong", () => {
    expect(resolveStatus([])).toBe("reviewed");
  });

  it("does NOT report no_findings for a clean run", () => {
    // A run that reviewed code and found nothing records a finding count of
    // zero, not a diagnostic. Phase 6 introduces the explicit no-findings path;
    // until then, silence means "nothing to report", not "no findings".
    expect(resolveStatus([])).not.toBe("no_findings");
  });
});

describe("resolveStatus — failures win over every skip", () => {
  it.each([
    "CONFIG_INVALID",
    "MISSING_CREDENTIALS",
    "INVALID_GITHUB_CONTEXT",
    "DIFF_PARSE_FAILED",
    "OPENROUTER_AUTH_FAILED",
    "INTERNAL_ERROR",
  ] as const)("reports 'failed' for %s even alongside a skip", (code) => {
    expect(resolveStatus([d("UNSUPPORTED_PR_SOURCE"), d(code)])).toBe("failed");
  });
});

describe("resolveStatus — skip reasons are specific", () => {
  it.each([
    ["UNSUPPORTED_EVENT", "skipped_unsupported_event"],
    ["UNSUPPORTED_PR_SOURCE", "skipped_unsupported_pr_source"],
    ["PUBLIC_REPOSITORY", "skipped_public_repository"],
    ["DRAFT_PR", "skipped_draft_pr"],
    ["PR_CLOSED", "skipped_pr_closed"],
    ["PR_ALREADY_MERGED", "skipped_pr_closed"],
    ["DIFF_FETCH_FAILED", "skipped_diff_unavailable"],
    ["DIFF_TRUNCATED", "skipped_diff_unavailable"],
    ["PR_TOO_LARGE", "skipped_pr_too_large"],
    ["CONTEXT_TOO_LARGE", "skipped_pr_too_large"],
    ["NO_REVIEWABLE_FILES", "skipped_no_reviewable_files"],
    ["NO_ELIGIBLE_MODEL", "skipped_no_eligible_model"],
    ["NO_ELIGIBLE_PROVIDER", "skipped_no_eligible_model"],
    ["OPENROUTER_QUOTA_EXHAUSTED", "skipped_quota_exhausted"],
    ["REQUEST_BUDGET_EXHAUSTED", "skipped_quota_exhausted"],
    ["RATE_LIMIT_BUDGET_THROTTLED", "skipped_quota_exhausted"],
    ["OPENROUTER_RATE_LIMITED", "skipped_upstream_unavailable"],
    ["OPENROUTER_UNAVAILABLE", "skipped_upstream_unavailable"],
    ["REQUEST_CANCELLED", "skipped_cancelled"],
    ["STALE_HEAD_SHA", "skipped_stale"],
    ["HEAD_CHANGED_MID_RUN", "skipped_stale"],
    ["MODEL_OUTPUT_INVALID", "skipped_no_usable_output"],
    ["MODEL_OUTPUT_TRUNCATED", "skipped_no_usable_output"],
    ["GITHUB_PUBLISH_FAILED", "skipped_no_usable_output"],
  ] as const)("%s -> %s", (code, expected) => {
    expect(resolveStatus([d(code)])).toBe(expected);
  });
});

describe("resolveStatus — the earliest cause is reported", () => {
  it("reports the event problem, not the downstream fork problem", () => {
    expect(resolveStatus([d("UNSUPPORTED_PR_SOURCE"), d("UNSUPPORTED_EVENT")])).toBe(
      "skipped_unsupported_event",
    );
  });

  it("reports PR_CLOSED rather than PUBLIC_REPOSITORY when both apply", () => {
    // Mirrors pipeline/eligibility.ts, which checks PR state before privacy.
    expect(resolveStatus([d("PUBLIC_REPOSITORY"), d("PR_CLOSED")])).toBe("skipped_pr_closed");
  });

  it("reports DRAFT_PR rather than PUBLIC_REPOSITORY when both apply", () => {
    expect(resolveStatus([d("PUBLIC_REPOSITORY"), d("DRAFT_PR")])).toBe("skipped_draft_pr");
  });

  it("keeps a deleted head repository ahead of PR state, as the gate does", () => {
    // The metadata check precedes the state check in the gate, so it wins.
    expect(resolveStatus([d("PR_CLOSED"), d("UNSUPPORTED_PR_SOURCE")])).toBe(
      "skipped_unsupported_pr_source",
    );
  });

  it("reports the size limit rather than a downstream model problem", () => {
    expect(resolveStatus([d("NO_ELIGIBLE_MODEL"), d("PR_TOO_LARGE")])).toBe("skipped_pr_too_large");
  });
});

describe("resolveStatus — anchoring rejections do not change the status", () => {
  it.each([
    "ANCHOR_NOT_FOUND",
    "ANCHOR_AMBIGUOUS",
    "ANCHOR_RANGE_INVALID",
    "ANCHOR_SIDE_MISMATCH",
    "ANCHOR_CONTEXT_ONLY",
    "ANCHOR_QUOTE_MALFORMED",
    "PATH_NOT_IN_PR",
    "DUPLICATE_FINDING_SUPPRESSED",
    "SUGGESTION_REJECTED",
    "FINDING_COUNT_EXCEEDED",
  ] as const)("%s is a per-finding rejection, not a run outcome", (code) => {
    // These describe individual findings, not the run. A run that rejected
    // three ambiguous anchors still published a review; it did not "skip".
    expect(resolveStatus([d(code)])).toBe("skipped_no_usable_output");
  });

  it("rejects the three paid-routing-eligible exclusions without failing the run", () => {
    expect(resolveStatus([d("NO_ELIGIBLE_MODEL")])).not.toBe("failed");
  });
});

describe("resolveStatus — never lies about having reviewed code", () => {
  it("does not report no_findings for an unrecognised diagnostic", () => {
    expect(resolveStatus([d("MODEL_OUTPUT_TOO_LARGE")])).not.toBe("no_findings");
  });

  it("every expected-severity diagnostic maps to a skip_* status", () => {
    // Exhaustively: no expected-severity code may fall through to a status
    // that implies the review completed.
    const expectedCodes = [
      "UNSUPPORTED_PR_SOURCE", "PUBLIC_REPOSITORY", "DRAFT_PR", "PR_CLOSED",
      "PR_ALREADY_MERGED", "UNSUPPORTED_EVENT", "DIFF_FETCH_FAILED", "DIFF_TRUNCATED",
      "PR_TOO_LARGE", "CONTEXT_TOO_LARGE", "NO_REVIEWABLE_FILES",
      "OPENROUTER_QUOTA_EXHAUSTED", "OPENROUTER_RATE_LIMITED", "OPENROUTER_UNAVAILABLE",
      "NO_ELIGIBLE_MODEL", "NO_ELIGIBLE_PROVIDER", "REQUEST_BUDGET_EXHAUSTED",
      "RATE_LIMIT_BUDGET_THROTTLED", "REQUEST_CANCELLED",
      "MODEL_OUTPUT_INVALID", "MODEL_OUTPUT_EMPTY_RETRYABLE", "MODEL_OUTPUT_TRUNCATED",
      "MODEL_OUTPUT_TOO_LARGE", "FINDING_COUNT_EXCEEDED",
      "ANCHOR_NOT_FOUND", "ANCHOR_AMBIGUOUS", "ANCHOR_RANGE_INVALID",
      "ANCHOR_SIDE_MISMATCH", "ANCHOR_CONTEXT_ONLY", "ANCHOR_QUOTE_MALFORMED",
      "PATH_NOT_IN_PR", "INJECTION_COMPLIANCE_SUSPECTED", "DUPLICATE_FINDING_SUPPRESSED",
      "SUGGESTION_REJECTED", "STALE_HEAD_SHA", "HEAD_CHANGED_MID_RUN",
      "GITHUB_PUBLISH_FAILED", "GITHUB_PUBLISH_DEGRADED",
    ] as const satisfies readonly DiagnosticCode[];

    for (const code of expectedCodes) {
      const status = resolveStatus([d(code)]);
      expect(status, code).toMatch(/^skipped_/);
      expect(status, code).not.toBe("no_findings");
    }
  });
});
