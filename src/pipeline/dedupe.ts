/**
 * Local deduplication.
 *
 * Multiple chunks can produce the same finding, because a file's context can be
 * split across chunk boundaries and reviewed twice, and because a model
 * independently notices the same defect in overlapping context.
 *
 * ## What is NOT the dedupe key
 *
 * Explanation text. Two genuinely distinct findings can be described in similar
 * words — "this loop never terminates" and "this loop can spin forever" — and
 * deduplicating on prose merges them, losing a real finding. Worse, the merge is
 * silent: the reader sees one comment and cannot tell two were collapsed.
 *
 * ## What IS the dedupe key
 *
 * The *location*, from the deterministic resolver. Two findings that resolved to
 * the same (path, side, start, end) range are the same comment by definition:
 * publishing both would put two comments on one line saying the same thing.
 *
 * That makes dedupe a property of anchoring rather than of language, which is
 * the right shape — it inherits the resolver's guarantees instead of adding a
 * second, weaker notion of sameness.
 *
 * ## Why severity is not a tiebreaker
 *
 * When two findings share a location, the one that survives is the more severe.
 * This is a judgement, so it is bounded: a model claiming two different
 * severities for one line is inconsistent, and the merge records that in the
 * summary rather than resolving it silently.
 */

import type { AnchoredFinding, Severity } from "../types.js";

/** The identity of a published comment location. */
export function anchorKey(finding: AnchoredFinding): string {
  const { anchor } = finding;
  const start = anchor.startLine ?? anchor.line;
  return [anchor.path, anchor.side, start, anchor.line].join(":");
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/**
 * Whether two findings at the same location are duplicates or distinct
 * observations that happen to land together.
 *
 * Same location *and* substantially the same explanation is a duplicate. Same
 * location with a materially different explanation is two real observations —
 * a `critical` data-loss risk and an `info` naming concern on the same line are
 * both worth saying — and collapsing them loses information.
 */
function isDuplicate(a: AnchoredFinding, b: AnchoredFinding): boolean {
  const left = a.explanation.toLowerCase().replace(/\s+/g, " ").trim();
  const right = b.explanation.toLowerCase().replace(/\s+/g, " ").trim();
  if (left === right) return true;

  // Jaccard similarity over word sets. Cheap, order-insensitive, and
  // deliberately not a fuzzy-match library: a false merge loses a real finding,
  // and a false split produces a duplicate comment, which is merely annoying.
  const words = (text: string): Set<string> =>
    new Set(
      text
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );

  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size === 0 || rightWords.size === 0) return false;

  let shared = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) shared += 1;
  }

  return shared / (leftWords.size + rightWords.size - shared) >= 0.7;
}

export interface DedupeResult {
  readonly kept: AnchoredFinding[];
  /** How many were dropped, for the step summary. */
  readonly dropped: number;
  /**
   * Locations where two findings were merged. Recorded so the summary can say
   * so, rather than presenting a merged review as if nothing was combined.
   */
  readonly merges: readonly { path: string; line: number; keptSeverity: Severity }[];
}

/**
 * Deduplicate anchored findings, keeping the more severe at each location.
 *
 * Input order is preserved for the survivors, so the most severe finding keeps
 * the position the first occurrence had rather than jumping to the end.
 */
export function dedupe(findings: readonly AnchoredFinding[]): DedupeResult {
  const kept: AnchoredFinding[] = [];
  const indexByKey = new Map<string, number>();
  const merges: { path: string; line: number; keptSeverity: Severity }[] = [];

  for (const finding of findings) {
    const key = anchorKey(finding);
    const at = indexByKey.get(key);

    if (at === undefined) {
      indexByKey.set(key, kept.length);
      kept.push(finding);
      continue;
    }

    const existing = kept[at];
    if (existing === undefined) continue;

    if (!isDuplicate(existing, finding)) {
      // Same line, genuinely different observations. Both are kept, so the key
      // can no longer index a single slot for this location.
      indexByKey.delete(key);
      kept.push(finding);
      continue;
    }

    merges.push({ path: finding.path, line: finding.anchor.line, keptSeverity: existing.severity });

    // The more severe claim survives. Both may be legitimate readings, but a
    // review that overstates severity erodes trust faster than one that
    // understates it, so the higher of the two is the safer default.
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
      kept[at] = finding;
      merges[merges.length - 1] = {
        path: finding.path,
        line: finding.anchor.line,
        keptSeverity: finding.severity,
      };
    }
  }

  return { kept, dropped: findings.length - kept.length, merges };
}
