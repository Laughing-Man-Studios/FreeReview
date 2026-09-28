/**
 * JSON extraction from model text.
 *
 * A fallback path, not the primary correctness mechanism. It exists because the
 * free model pool includes endpoints with no `response_format` support at all
 * (`PROMPT_JSON` mode), and because free models wrap JSON in prose and markdown
 * fences often enough that a bare `JSON.parse` would fail on a perfectly good
 * answer and spend a repair request to find out.
 *
 * ## Why not a greedy regex
 *
 * The obvious implementation is `/\{[\s\S]*\}/`, which matches from the first
 * `{` to the last `}`. That is wrong in a way that produces confident garbage:
 * given a model that emitted an example object in its preamble followed by the
 * real one, the greedy match joins them into `{"example": ...{"findings":[...]}`,
 * which is a *syntactically valid* JSON object with the wrong shape. It fails
 * schema validation, so it is caught — but it burns a repair request first.
 *
 * Instead: scan for balanced braces while respecting string literals and
 * escapes, and try each candidate from longest to shortest. A JSON object
 * containing another object as a *value* is still found correctly, because
 * balance is tracked, not pattern-matched.
 *
 * ## Order of operations
 *
 * 1. `JSON.parse` the whole text. The common case in structured modes, and the
 *    only case in `STRUCTURED`.
 * 2. Strip a markdown code fence and retry. Cheap, and extremely common.
 * 3. Brace-scan and try candidates, longest first.
 * 4. `jsonrepair` once, then 1–3 again. Last resort, bounded to a single call.
 *
 * Each step is bounded, so a pathological response cannot cause unbounded work.
 */

import { jsonrepair } from "jsonrepair";

export interface ExtractResult {
  readonly value: unknown;
  /** Which strategy succeeded, for diagnostics. */
  readonly strategy: "direct" | "unfenced" | "extracted" | "repaired";
  /** How many brace-balanced candidates were tried, for diagnostics. */
  readonly candidatesTried: number;
}

/**
 * Longest text we will attempt to repair.
 *
 * `jsonrepair` is quadratic in pathological cases and a model can be talked into
 * emitting a very large response. Beyond this the repair cannot succeed within
 * the run budget, and the caller is better served by a rejection.
 */
const MAX_REPAIR_LENGTH = 100_000;

/** Maximum brace-balanced candidates to try before giving up. */
const MAX_CANDIDATES = 24;

/**
 * Strip a markdown code fence.
 *
 * Handles the ```json and bare ``` forms, and a fence that is never closed —
 * models truncate mid-fence often enough that requiring closure would discard
 * otherwise-valid JSON.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();

  const fenced = /^(`{3,})[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)(?:\r?\n\1[ \t]*)?$/.exec(trimmed);
  if (fenced !== null) return (fenced[2] ?? "").trim();

  // Unclosed fence: take everything after the opening line.
  const unclosed = /^(`{3,})[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*)$/.exec(trimmed);
  if (unclosed !== null) {
    const body = (unclosed[2] ?? "").trim();
    // Only strip a trailing fence marker if one is actually present, otherwise
    // the closing ``` becomes part of the JSON and breaks the parse.
    return body.replace(/\r?\n?`{3,}[ \t]*$/, "").trim();
  }

  return trimmed;
}

/**
 * Yield brace-balanced object candidates, longest first.
 *
 * Tracks string state and escapes so a `{` inside a string literal does not
 * open a scope, and a `\"` does not end a string.
 */
export function* braceCandidates(text: string): Generator<string> {
  const found: { start: number; end: number }[] = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end !== -1) {
      found.push({ start: i, end });
      // Skip past this object; anything nested inside it was already covered.
      i = end;
    }
  }

  // Longest first. A whole-response object beats a nested `findings` object,
  // and both beat a fragment in the preamble.
  found.sort((a, b) => b.end - b.start - (a.end - a.start));
  yield* found.map((f) => text.slice(f.start, f.end + 1));
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether a parsed value could plausibly be the findings response.
 *
 * Only objects and arrays qualify. This guard exists because `jsonrepair` will
 * happily wrap bare prose into a JSON string: given "I found no issues in this
 * diff." it returns `"I found no issues in this diff."`, which parses
 * successfully. Without it, a model that ignored the output format entirely is
 * reported as a *schema* failure rather than an *unparseable* response — and the
 * repair prompt then tells it to fix a field-shape problem it never had.
 *
 * The distinction matters because the two get different messages and different
 * levels of trust. A shape error earns a list of specific field paths, which is
 * useful feedback. Telling a model its prose is the wrong shape is not.
 */
function couldBeResponse(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * Extract a JSON value from model output.
 *
 * Returns `null` when nothing object-shaped was found. An object that is
 * parseable but fails schema validation is returned as-is, because deciding that
 * it is the wrong shape is schema validation's job, not this function's.
 */
export function extractJson(raw: string): ExtractResult | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // 1. Direct parse. In STRUCTURED mode this is the only path taken.
  const direct = tryParse(text);
  if (direct.ok && couldBeResponse(direct.value)) {
    return { value: direct.value, strategy: "direct", candidatesTried: 0 };
  }

  // 2. Unwrap a markdown fence.
  const unfenced = stripCodeFence(text);
  if (unfenced !== text) {
    const parsed = tryParse(unfenced);
    if (parsed.ok && couldBeResponse(parsed.value)) {
      return { value: parsed.value, strategy: "unfenced", candidatesTried: 0 };
    }
  }

  // 3. Brace-balanced candidates, longest first.
  let tried = 0;
  for (const candidate of braceCandidates(unfenced)) {
    tried += 1;
    if (tried > MAX_CANDIDATES) break;
    const parsed = tryParse(candidate);
    if (parsed.ok && couldBeResponse(parsed.value)) {
      return { value: parsed.value, strategy: "extracted", candidatesTried: tried };
    }
  }

  // 4. Bounded repair, then the cheap strategies again. A model that emitted
  //    trailing commas or an unterminated string is one edit away from valid,
  //    and that is a common enough failure to be worth one attempt.
  if (text.length <= MAX_REPAIR_LENGTH) {
    try {
      const repaired = jsonrepair(text);
      const parsed = tryParse(repaired);
      if (parsed.ok && couldBeResponse(parsed.value)) {
        return { value: parsed.value, strategy: "repaired", candidatesTried: tried };
      }

      const repairedUnfenced = stripCodeFence(repaired);
      if (repairedUnfenced !== repaired) {
        const reparsed = tryParse(repairedUnfenced);
        if (reparsed.ok && couldBeResponse(reparsed.value)) {
          return { value: reparsed.value, strategy: "repaired", candidatesTried: tried };
        }
      }
    } catch {
      // jsonrepair throws on input it cannot make sense of. That is a normal
      // outcome here, not an error worth propagating.
    }
  }

  return null;
}
