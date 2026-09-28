/**
 * Deterministic anchor resolution.
 *
 * The goal, in one sentence:
 *
 *   Resolve a finding to exactly one valid GitHub diff location, or refuse to
 *   publish it inline.
 *
 * Everything here is a rejection path. The model is untrusted, its quote is
 * untrusted, and the only correct response to ambiguity is to decline. A
 * comment on the wrong line is worse than no comment: it costs a maintainer's
 * trust in the whole tool.
 *
 * The resolver is pure and synchronous, and depends on no LLM. Its inputs are
 * a file-level index (see `diff/index.ts`) and a `(path, quote)` pair.
 */

import type { Segment } from "../diff/index.js";
import type { FileIndex } from "../diff/index.js";
import type { Anchor, AnchorRejectionCode, AnchorResolution, LineKind, Side } from "../types.js";
import { RUNG_LABELS, normaliseQuote, transformLines } from "./normalize.js";

/** Shortest quote worth matching. Below this, collisions are overwhelmingly likely. */
export const MIN_QUOTE_LENGTH = 3;

/** Longest quote accepted from a model, before normalisation. */
export const MAX_QUOTE_LENGTH = 2_000;

/** A match must start at a line boundary. */
interface Match {
  readonly segment: Segment;
  readonly side: Side;
  /** Index into the segment's line array. */
  readonly startIndex: number;
  readonly length: number;
  readonly rung: number;
}

export interface ResolveInput {
  /** Repository-relative path, as supplied by the model. */
  readonly path: string;
  /** Source text the model claims is buggy. */
  readonly quote: string;
  readonly index: FileIndex;
  /** The PR's file paths, for the traversal guard. */
  readonly prFilePaths: ReadonlySet<string>;
}

/**
 * Resolve a quote to a unique diff location.
 *
 * `prFilePaths` is the PR's own file set. A path outside it is rejected before
 * any matching, which also blocks path-traversal shapes like `../../etc/passwd`.
 */
export function resolveAnchor(input: ResolveInput): AnchorResolution {
  const { path, quote, index, prFilePaths } = input;

  // --- 1. Path guard ----------------------------------------------------
  // Checked against the PR's declared file set rather than only against the
  // index, so a path that happens to match nothing is rejected for the right
  // reason. NFC-normalised because model output and GitHub paths can differ in
  // Unicode composition.
  const normalisedPath = path.normalize("NFC");
  if (!prFilePaths.has(normalisedPath)) {
    return reject("PATH_NOT_IN_PR", 0, 0, "The reported path is not one of this pull request's files.");
  }
  if (index.path !== normalisedPath) {
    return reject("PATH_NOT_IN_PR", 0, 0, "No diff index exists for the reported path.");
  }

  // --- 2. Quote guards ---------------------------------------------------
  if (quote.trim().length === 0) {
    return reject("ANCHOR_QUOTE_MALFORMED", 0, 0, "The quote is empty.");
  }
  if (quote.trim().length < MIN_QUOTE_LENGTH) {
    // A one or two character quote is almost always accidental — a brace, a
    // semicolon — and a comment anchored to it is noise. Collision-prone short
    // quotes are better declined than guessed at.
    return reject(
      "ANCHOR_QUOTE_MALFORMED",
      0,
      0,
      `The quote is only ${quote.trim().length} character(s); at least ${MIN_QUOTE_LENGTH} are required.`,
    );
  }
  if (quote.length > MAX_QUOTE_LENGTH) {
    return reject(
      "ANCHOR_QUOTE_MALFORMED",
      0,
      0,
      `The quote is ${quote.length} characters; the limit is ${MAX_QUOTE_LENGTH}.`,
    );
  }

  const quoteLineCount = countQuoteLines(quote);
  if (quoteLineCount > 20) {
    return reject(
      "ANCHOR_QUOTE_MALFORMED",
      0,
      0,
      `The quote spans ${quoteLineCount} lines; the limit is 20.`,
    );
  }

  // --- 3. Ladder ---------------------------------------------------------
  // For each rung, find every match across every segment on every side.
  // The first rung with at least one match decides the outcome.
  let deepestRungReached = 0;

  for (let rung = 0; rung < RUNG_LABELS.length; rung += 1) {
    const needle = normaliseQuote(quote, rung);
    if (needle.length === 0 || needle.every((line) => line.length === 0)) {
      // Nothing but blank lines; further relaxation cannot make it more
      // specific, and matching blank lines is almost always a mistake.
      deepestRungReached = rung;
      break;
    }

    const matches: Match[] = [];
    for (const segment of index.segments) {
      const haystack = transformLines(
        segment.lines.map((line) => line.text),
        rung,
      );
      collectMatches(needle, haystack, (startIndex) => {
        matches.push({ segment, side: segment.side, startIndex, length: needle.length, rung });
      });
    }

    if (matches.length === 0) {
      deepestRungReached = rung;
      continue;
    }

    // Collapse matches covering the SAME underlying lines.
    //
    // This matters more than it looks. A context line exists on both sides at
    // the same line number, so an unchanged line matches once on LEFT and once
    // on RIGHT. Counting those as two would make every context-only quote
    // "ambiguous" and would render the context-only rejection unreachable. They
    // are one location, not two.
    //
    // Where a span does contain a change, only one side can match it: a span
    // containing an added line has no LEFT counterpart with the same text, and a
    // span containing a removed line has no RIGHT counterpart. So collapsing by
    // line numbers never merges two genuinely different places.
    const distinct = collapseByLocation(matches);

    if (distinct.length > 1) {
      return reject(
        "ANCHOR_AMBIGUOUS",
        rung,
        distinct.length,
        `The quote matches ${distinct.length} locations in this file ` +
          `(${RUNG_LABELS[rung]} match). Ambiguous anchors are declined rather ` +
          "than guessed.",
      );
    }

    return buildAnchor(distinct[0] as Match);
  }

  return reject(
    "ANCHOR_NOT_FOUND",
    deepestRungReached,
    0,
    "The quote does not appear in the diff, even after whitespace normalisation.",
  );
}

/**
 * Convert a unique match into a GitHub anchor, applying the quality gate.
 *
 * This is where the "context-only" rejection lives, and it is the single
 * highest-leverage precision control in the project. GitHub will happily accept
 * a review comment on an unchanged context line — but a finding about code the
 * pull request did not touch is noise, and noise is what makes a human stop
 * reading the tool.
 */
function buildAnchor(match: Match): AnchorResolution {
  const { segment, side, startIndex, length, rung } = match;
  const endIndex = startIndex + length - 1;

  const first = segment.lines[startIndex];
  const last = segment.lines[endIndex];

  // Defensive: a match we constructed must always have real lines behind it.
  if (first === undefined || last === undefined) {
    return reject("ANCHOR_NOT_FOUND", rung, 1, "Match resolved to no line.");
  }

  const span = segment.lines.slice(startIndex, endIndex + 1);
  const hasChange = span.some((line) => line.kind !== "context");

  // LEFT is permitted to be change-free: a finding about deleted code is
  // anchored on the removal, and the removed line is itself the change. A
  // RIGHT-side range with no added line is a comment on untouched code.
  if (!hasChange && side === "RIGHT") {
    return reject(
      "ANCHOR_CONTEXT_ONLY",
      rung,
      1,
      "The quote matches only unchanged context lines. Findings must point at " +
        "added or removed code.",
    );
  }

  const anchor: Anchor = {
    path: segment.filePath,
    line: last.lineNumber,
    side,
    ...(length > 1 && first.lineNumber !== last.lineNumber
      ? { startLine: first.lineNumber, startSide: side }
      : {}),
    rung,
  };

  return { ok: true, anchor };
}

/**
 * Windowed substring search.
 *
 * Matches must begin at a line boundary, so a quote that starts mid-line is
 * not a match. Implemented directly rather than with `indexOf` over a joined
 * string because line boundaries must be tracked, and because the haystack is
 * per-segment so a match can never span a hunk gap.
 */
function collectMatches(
  needle: readonly string[],
  haystack: readonly string[],
  onMatch: (startIndex: number) => void,
): void {
  if (needle.length === 0 || needle.length > haystack.length) return;

  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) onMatch(start);
  }
}

/**
 * Collapse matches that cover the same underlying lines into one location.
 *
 * A context line has the same line number on both sides, so LEFT and RIGHT
 * matches over pure context describe one place. Where both sides matched,
 * RIGHT is preferred: it is the side a comment attaches to, and it is the side
 * that survives when the span also contains an added line.
 */
function collapseByLocation(matches: readonly Match[]): Match[] {
  const byLocation = new Map<string, Match>();

  for (const match of matches) {
    // Identity is the offset WITHIN the hunk, never the line number.
    //
    // A context line has the same line number on both sides only when the
    // hunk's oldStart equals its newStart. In `@@ -1,1 +5,1 @@` the context
    // line is old 1 and new 5, because earlier lines shifted. Keying on line
    // numbers therefore made every context quote look like it matched in two
    // places and rejected it as ambiguous — on any PR where a hunk's two
    // starts differ, which is most of them. A property test found this; reading
    // the code had not.
    const key = `${match.segment.hunkIndex}:${match.startIndex}:${match.length}`;

    const existing = byLocation.get(key);
    // A pure-context span exists on both sides and is one location. Prefer
    // RIGHT: it is the side a comment attaches to, and the side that survives
    // when the span also contains an added line. A span containing a removed
    // line has no RIGHT counterpart, so it is unaffected.
    if (existing === undefined || (existing.side === "LEFT" && match.side === "RIGHT")) {
      byLocation.set(key, match);
    }
  }

  return [...byLocation.values()];
}

/**
 * Count the quote's lines the way the matcher will see them.
 *
 * A trailing newline is an artefact of copying, not an extra line, so it does
 * not count.
 */
function countQuoteLines(quote: string): number {
  const lines = quote.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function reject(
  code: AnchorRejectionCode,
  rung: number,
  candidateCount: number,
  detail: string,
): AnchorResolution {
  return { ok: false, code, rung, candidateCount, detail };
}

/**
 * Resolve a batch of findings, returning anchors and rejections separately.
 *
 * Rejections carry only structured metadata and a reason. They never carry
 * source text, because they end up in the step summary and the review body.
 */
export function resolveAnchors(
  inputs: readonly { path: string; quote: string }[],
  index: ReadonlyMap<string, FileIndex>,
  prFilePaths: ReadonlySet<string>,
): { anchors: Map<string, AnchorResolution>; order: string[] } {
  const anchors = new Map<string, AnchorResolution>();
  const order: string[] = [];

  for (const input of inputs) {
    const key = `${input.path} ${input.quote}`;
    if (anchors.has(key)) continue;
    order.push(key);

    const fileIndex = index.get(input.path.normalize("NFC"));
    anchors.set(
      key,
      fileIndex === undefined
        ? {
            ok: false,
            code: "PATH_NOT_IN_PR",
            rung: 0,
            candidateCount: 0,
            detail: "No diff index exists for the reported path.",
          }
        : resolveAnchor({ path: input.path, quote: input.quote, index: fileIndex, prFilePaths }),
    );
  }

  return { anchors, order };
}

/** Whether a line kind represents a change to the file. */
export function isChange(kind: LineKind): boolean {
  return kind !== "context";
}
