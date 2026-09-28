/**
 * Quote normalisation ladder.
 *
 * A model quoting your code will be *nearly* right. It will drop a trailing
 * space, re-indent a block, or normalise CRLF. Rejecting those outright
 * discards real findings; accepting them too eagerly puts comments on the wrong
 * line.
 *
 * The ladder resolves that: try exact matching first, and only relax when exact
 * matching found nothing. The first rung that produces ANY match wins — and if
 * that rung produces more than one, the finding is rejected as ambiguous. We
 * never keep relaxing past an ambiguity, and we never pick the first of
 * several.
 *
 * Note the direction of relaxation: later rungs normalise *more* aggressively,
 * so they can only ever produce equal or more matches. A rung that was
 * ambiguous cannot be disambiguated by going deeper. That is why falling
 * through on ambiguity would be pointless as well as unsafe.
 */

export type LineTransform = (line: string) => string;

const stripCR: LineTransform = (line) => line.replace(/\r$/, "");

const rstrip: LineTransform = (line) => line.replace(/[ \t]+$/, "");

/**
 * Strip ALL leading whitespace from a line.
 *
 * Not a common-prefix dedent, which would need the quote's indent to coincide
 * with the segment's — and if it coincided, an exact match would already have
 * succeeded. This is the rung that rescues a re-indented quote, and it is
 * lossy by design: it is only reached after exact, CRLF, and trailing-whitespace
 * matching have all failed.
 */
const stripLeading: LineTransform = (line) => line.replace(/^[ \t]+/, "");

const collapseInner: LineTransform = (line) => line.replace(/[ \t]+/g, " ");

/**
 * Rung transforms, applied cumulatively. Index N applies RUNGS[0..N].
 */
const RUNGS: readonly (readonly LineTransform[])[] = [
  /* L0 */ [],
  /* L1 */ [stripCR],
  /* L2 */ [stripCR, rstrip],
  /* L3 */ [stripCR, rstrip, stripLeading],
  /* L4 */ [stripCR, rstrip, stripLeading, collapseInner],
];

export const RUNG_COUNT = RUNGS.length;

export const RUNG_LABELS: readonly string[] = [
  "exact",
  "crlf",
  "trailing-whitespace",
  "reindent",
  "collapsed-whitespace",
];

/** Apply rung `rung` to a single line. */
export function transformLine(line: string, rung: number): string {
  const transforms = RUNGS[clampRung(rung)] ?? [];
  let out = line;
  for (const transform of transforms) out = transform(out);
  return out;
}

/** Apply rung `rung` to a block of lines. */
export function transformLines(lines: readonly string[], rung: number): string[] {
  return lines.map((line) => transformLine(line, rung));
}

/**
 * Split a quote into lines and normalise it at the given rung.
 *
 * An empty or whitespace-only quote yields no lines, which the resolver treats
 * as malformed rather than as a match against a blank line.
 */
export function normaliseQuote(quote: string, rung: number): string[] {
  const lines = quote.split("\n");
  // A trailing newline in the quote is an artefact of copying, not content.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return transformLines(lines, rung);
}

function clampRung(rung: number): number {
  if (!Number.isInteger(rung) || rung < 0) return 0;
  if (rung >= RUNGS.length) return RUNGS.length - 1;
  return rung;
}
