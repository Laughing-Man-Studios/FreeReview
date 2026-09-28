/**
 * Post-parse validation.
 *
 * Schema validation (Phase 5) established that a finding is *well-formed*. This
 * establishes that it is *true of this pull request* — that the file it names is
 * in the PR, that the lines it anchored to actually exist, and that its
 * suggestion would replace what it claims to replace.
 *
 * Everything here is deterministic and local. The model proposes; this decides.
 *
 * ## What is checked, and why each check exists
 *
 * 1. **Path in the PR.** Not a formality: the schema requires `path` so
 *    multi-file chunks can attribute a finding, and a path outside the PR means
 *    the model attributed a quote to a file it was never shown. A finding with
 *    an unknown path is discarded rather than published at the top of the
 *    review, because a path-less comment reads as being about the change in
 *    general, which is a claim the model has not earned.
 *
 * 2. **The anchored text is what the model quoted.** A finding that anchors
 *    successfully to line N but whose quote matches nothing at N has been
 *    resolved to a location the model did not describe. The anchor ladder is
 *    already strict about this, but the check is cheap and the failure mode —
 *    a comment attached to real code that the model never assessed — is exactly
 *    the kind of confident wrongness this project exists to avoid.
 *
 * 3. **A suggestion replaces the anchored span.** GitHub's suggestion block
 *    replaces the range you give it. A model that supplies a suggestion while
 *    anchoring to a single line has almost certainly written a replacement for
 *    a function, and applying it would delete code the model never saw. This is
 *    rejected, not warned about, because a wrong suggestion is worse than none.
 *
 * 4. **Reasoning a cited failure mode.** A finding must name what breaks. Not
 *    checkable against ground truth locally — but a length floor and a
 *    vagueness screen catch the degenerate case of a model padding output, and
 *    the *measurement* of real quality is Phase 7's job, not this function's.
 */

import type { AnchoredFinding, Anchor, RawFinding, Severity, Side } from "../types.js";
import type { FileIndex, IndexLine } from "../diff/index.js";

/** A finding that passed parse-time schema validation and reached validation. */
export interface Candidate {
  readonly finding: RawFinding;
  readonly anchor: Anchor;
  /** The source text the anchor covers, from the index. */
  readonly anchoredText: string;
}

export type ValidationRejectionCode =
  | "PATH_NOT_IN_PR"
  | "ANCHOR_TEXT_MISMATCH"
  | "SUGGESTION_SPAN_TOO_SMALL"
  | "EXPLANATION_TOO_THIN"
  | "SUGGESTION_NOT_A_REPLACEMENT";

export interface ValidationRejection {
  readonly code: ValidationRejectionCode;
  readonly path: string;
  /** Structured metadata only. Never source text — these reach the summary. */
  readonly detail: string;
  readonly severity: Severity;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: AnchoredFinding }
  | { readonly ok: false; readonly rejection: ValidationRejection };

/**
 * Minimum explanation length.
 *
 * A one-word explanation cannot describe a failure mode. Set low deliberately:
 * this is a floor against degenerate output, not a quality judgement. Whether
 * an explanation is *good* is measured in Phase 7 against ground truth, and a
 * local heuristic for "good" would just be a second, worse rubric.
 */
export const MIN_EXPLANATION_LENGTH = 20;

/**
 * Longest anchored span a single-line suggestion may replace.
 *
 * GitHub applies a suggestion across the whole range, so a one-line suggestion
 * anchored to a 40-line function would delete 39 lines the model never
 * mentioned. Anything wider than this is rejected rather than silently narrowed
 * — narrowing would apply code the model wrote to a location it did not choose.
 */
export const MAX_SUGGESTION_SPAN_LINES = 1;

/** Phrases that indicate an explanation is asserting rather than explaining. */
const VAGUE_PREFIXES = ["looks fine", "looks good", "fine", "ok", "okay", "good", "nice"];

function isThin(explanation: string): boolean {
  const trimmed = explanation.trim().toLowerCase();
  if (trimmed.length < MIN_EXPLANATION_LENGTH) return true;
  if (VAGUE_PREFIXES.some((prefix) => trimmed === prefix || trimmed === `${prefix}.`)) return true;
  return false;
}

/**
 * Retrieve the source text an anchor covers, and the lines it covers.
 *
 * Returns null when the anchor does not correspond to anything in the index,
 * which should be impossible if the anchor came from this index — and the null
 * is handled rather than assumed away, because a comment published at a line
 * that does not exist is rejected by GitHub anyway and would fail the whole
 * review.
 */
export function anchoredLines(
  anchor: Anchor,
  index: ReadonlyMap<string, FileIndex>,
): readonly IndexLine[] | null {
  const fileIndex = index.get(anchor.path.normalize("NFC"));
  if (fileIndex === undefined) return null;

  const start = anchor.startLine ?? anchor.line;

  for (const segment of fileIndex.segments) {
    if (segment.side !== anchor.side) continue;

    const collected = segment.lines.filter(
      (line) => line.lineNumber >= start && line.lineNumber <= anchor.line,
    );

    // A contiguous run only. A gap means the range spans a hunk boundary, which
    // GitHub will not accept as a single range.
    if (collected.length === 0) continue;
    if (collected.length !== anchor.line - start + 1) continue;
    if (collected[0]?.lineNumber !== start) continue;
    if (collected[collected.length - 1]?.lineNumber !== anchor.line) continue;

    return collected;
  }

  return null;
}

/** The text of an anchor's range, newline-joined. */
export function anchoredText(anchor: Anchor, index: ReadonlyMap<string, FileIndex>): string | null {
  const lines = anchoredLines(anchor, index);
  return lines === null ? null : lines.map((line) => line.text).join("\n");
}

/**
 * Whether every line in the anchor's range is commentable.
 *
 * GitHub rejects a review comment anchored to a line outside the diff. Checking
 * locally means one bad finding is dropped instead of the entire review
 * failing with a 422.
 */
export function allCommentable(lines: readonly IndexLine[]): boolean {
  return lines.length > 0 && lines.every((line) => line.isCommentable);
}

/**
 * Whether a quote plausibly describes the text it anchored to.
 *
 * A containment check, not equality: the resolver already normalises across
 * several rungs (whitespace, indentation, casing), so requiring equality here
 * would reject findings the ladder deliberately accepted. What this catches is
 * the case where the ladder matched a *substring* of a much longer span — a
 * model that quoted three lines and anchored to forty.
 */
function quoteDescribesText(quote: string, text: string): boolean {
  const normalise = (value: string): string => value.replace(/\s+/g, " ").trim();
  const q = normalise(quote);
  const t = normalise(text);
  return t.includes(q) || q.includes(t);
}

/**
 * Validate one anchored finding.
 *
 * `prFilePaths` is the PR's own file set, not the index's keys: the index only
 * contains files that survived filtering, and a finding naming a filtered-out
 * file is still naming a real file in the PR. Using the wrong set would report
 * a filtered file as "not in the PR", which is a confusing and wrong message.
 */
export function validateFinding(
  candidate: Candidate,
  prFilePaths: ReadonlySet<string>,
  index: ReadonlyMap<string, FileIndex>,
): ValidationResult {
  const { finding, anchor } = candidate;

  // The finding's path and the anchor's path must agree. They are set from
  // different places — one from the model, one from the resolver's own view of
  // the diff — and `anchoredText` reads the *anchor's* path. A disagreement
  // means the comment would be rendered as being about one file while the quoted
  // code came from another, which is the most confusing possible failure and
  // passes every other check.
  if (finding.path.normalize("NFC") !== anchor.path.normalize("NFC")) {
    return {
      ok: false,
      rejection: {
        code: "PATH_NOT_IN_PR",
        path: finding.path,
        severity: finding.severity,
        detail:
          "The finding's path and the location it resolved to name different files, so " +
          "the quoted code and the reported file disagree.",
      },
    };
  }

  if (!prFilePaths.has(finding.path)) {
    return {
      ok: false,
      rejection: {
        code: "PATH_NOT_IN_PR",
        path: finding.path,
        severity: finding.severity,
        detail:
          "The finding names a file that is not part of this pull request, so it " +
          "cannot be placed on a line.",
      },
    };
  }

  const text = anchoredText(anchor, index);
  if (text === null) {
    return {
      ok: false,
      rejection: {
        code: "ANCHOR_TEXT_MISMATCH",
        path: finding.path,
        severity: finding.severity,
        detail: "The anchor does not correspond to any line in the diff.",
      },
    };
  }

  if (!quoteDescribesText(finding.buggyCodeQuote, text)) {
    // The anchor resolved, but to a span the model's quote does not describe.
    // Publishing here would attach a confident assessment to code the model
    // never actually read.
    return {
      ok: false,
      rejection: {
        code: "ANCHOR_TEXT_MISMATCH",
        path: finding.path,
        severity: finding.severity,
        detail:
          "The resolved location does not contain the quoted text, so the finding " +
          "would be attached to code the model did not quote.",
      },
    };
  }

  if (isThin(finding.explanation)) {
    return {
      ok: false,
      rejection: {
        code: "EXPLANATION_TOO_THIN",
        path: finding.path,
        severity: finding.severity,
        detail:
          "The explanation does not describe a specific failure mode, so the finding " +
          "would be noise in the review.",
      },
    };
  }

  if (finding.suggestedCode !== null) {
    const lines = anchoredLines(anchor, index) ?? [];
    if (lines.length > MAX_SUGGESTION_SPAN_LINES) {
      // A suggestion is applied across the whole anchored range. A one-line
      // replacement for a multi-line span deletes whatever was in between.
      return {
        ok: false,
        rejection: {
          code: "SUGGESTION_SPAN_TOO_SMALL",
          path: finding.path,
          severity: finding.severity,
          detail:
            `A suggestion is anchored to a ${lines.length}-line range. Applying it would ` +
            "replace lines the model did not propose, so the suggestion was dropped. The " +
            "finding is still reported.",
        },
      };
    }
  }

  // A suggestion that cannot be rendered safely loses the suggestion, not the
  // finding. The observation is still valid and the defect is still real;
  // discarding it over a defect in an optional field would throw away a correct
  // report because the model formatted a string badly.
  let suggestion = finding.suggestedCode;
  if (suggestion !== null && /`{3,}/.test(suggestion)) {
    suggestion = null;
  }

  return {
    ok: true,
    value: {
      path: finding.path,
      explanation: finding.explanation,
      severity: finding.severity,
      suggestedCode: suggestion,
      anchor,
      anchoredText: text,
    },
  };
}

/**
 * Validate a batch, keeping accepted findings and rejections separately.
 *
 * A rejection never carries source text. These records reach the step summary
 * and the published review, and the whole privacy posture of this action rests
 * on untrusted diff content not being echoed back into places a reader will see
 * it attributed to the reviewer.
 */
export function validateFindings(
  candidates: readonly Candidate[],
  prFilePaths: ReadonlySet<string>,
  index: ReadonlyMap<string, FileIndex>,
): { accepted: AnchoredFinding[]; rejected: ValidationRejection[] } {
  const accepted: AnchoredFinding[] = [];
  const rejected: ValidationRejection[] = [];

  for (const candidate of candidates) {
    const result = validateFinding(candidate, prFilePaths, index);
    if (result.ok) accepted.push(result.value);
    else rejected.push(result.rejection);
  }

  return { accepted, rejected };
}

export type { Side };
