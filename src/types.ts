/**
 * Shared domain types.
 *
 * The through-line: everything below `AnchoredFinding` is derived from
 * untrusted data (the PR diff and the model's output). Everything from
 * `AnchoredFinding` onward is derived from deterministic local resolution and
 * is safe to publish.
 */

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type LineKind = "added" | "removed" | "context";

/** Which side of the diff a line belongs to. */
export type Side = "LEFT" | "RIGHT";

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface DiffLine {
  readonly kind: LineKind;
  /** Line number on the LEFT (pre-image) side. Null for added lines. */
  readonly oldLine: number | null;
  /** Line number on the RIGHT (post-image) side. Null for removed lines. */
  readonly newLine: number | null;
  /**
   * 1-based offset from the first `@@` header of the file, per GitHub's legacy
   * `position` semantics. Retained only as a debugging aid; the publisher uses
   * `line`/`side` exclusively.
   */
  readonly position: number;
  /** Line content WITHOUT the leading '+', '-', or ' ' marker. */
  readonly text: string;
  /** Whether GitHub will accept a review comment anchored to this line. */
  readonly isCommentable: boolean;
}

export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  /** New path. For renames/copies this is the destination path. */
  readonly path: string;
  /** Source path, for renames and copies only. */
  readonly previousPath?: string;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** GitHub reported no patch (binary or unsupported content). */
  readonly binary: boolean;
  /** GitHub returned a shortened or omitted patch for a large file. */
  readonly truncated: boolean;
  readonly hunks: readonly DiffHunk[];
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

export interface AnchorUnit {
  readonly lineNumber: number;
  readonly kind: LineKind;
  /** Whether a review comment can be anchored to this line. */
  readonly isCommentable: boolean;
}

export type AnchorRejectionCode =
  | "PATH_NOT_IN_PR"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_AMBIGUOUS"
  | "ANCHOR_RANGE_INVALID"
  | "ANCHOR_SIDE_MISMATCH"
  | "ANCHOR_CONTEXT_ONLY"
  | "ANCHOR_QUOTE_MALFORMED";

/** A resolved, uniquely-determined GitHub review-comment location. */
export interface Anchor {
  readonly path: string;
  readonly line: number;
  readonly side: Side;
  readonly startLine?: number;
  readonly startSide?: Side;
  /** Which ladder rung produced the match. Recorded for diagnostics. */
  readonly rung: number;
}

export type AnchorResolution =
  | { readonly ok: true; readonly anchor: Anchor }
  | {
      readonly ok: false;
      readonly code: AnchorRejectionCode;
      /** Which ladder rung was reached. Never contains source text. */
      readonly rung: number;
      readonly candidateCount: number;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// Model output
// ---------------------------------------------------------------------------

export type Severity = "critical" | "warning" | "info";

/**
 * A finding exactly as the model returned it, after schema validation.
 * Still untrusted: every field is model-controlled.
 */
export interface RawFinding {
  readonly path: string;
  readonly buggyCodeQuote: string;
  readonly explanation: string;
  readonly severity: Severity;
  readonly suggestedCode: string | null;
}

export interface RawFindingsResponse {
  readonly findings: readonly RawFinding[];
}

/** How a model's request was shaped, derived from its declared capabilities. */
export type CapabilityMode = "STRUCTURED" | "JSON_OBJECT" | "PROMPT_JSON";

// ---------------------------------------------------------------------------
// Validated, publishable
// ---------------------------------------------------------------------------

/**
 * A finding that passed every deterministic validation gate.
 *
 * Nothing here is model-supplied except `explanation`, `severity` and
 * `suggestedCode`, all of which are only ever rendered as text. The location —
 * the part that puts a comment on someone's line — comes exclusively from a
 * resolved `Anchor`.
 */
export interface AnchoredFinding {
  readonly path: string;
  readonly explanation: string;
  readonly severity: Severity;
  readonly suggestedCode: string | null;
  readonly anchor: Anchor;
  /** The anchored span's source text, for suggestion-range validation. */
  readonly anchoredText: string;
}

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------

/**
 * The immutable identity of a review run. Captured once, before any inference,
 * and re-verified before publication.
 */
export interface ReviewIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly baseSha: string;
  /** The exact commit under review. Findings are discarded if this changes. */
  readonly reviewHeadSha: string;
  /** Stamped into every LLM result so runs are attributable. */
  readonly promptVersion: string;
  readonly configVersion: string;
}
