/**
 * Bounded repair of an invalid model response.
 *
 * ## Why repair is a second *request* and not a local fix
 *
 * The plan calls for "bounded repair/retry". A purely local repair — patching up
 * the JSON — is tempting because it costs no quota. It is also the wrong tool
 * here, for one specific reason: the most common schema violation is a
 * *semantic* one, and it cannot be fixed without the model.
 *
 * A model that returns `severity: "high"` did not fail to understand JSON. It
 * failed to understand the severity vocabulary. Mapping `"high"` to `critical`
 * locally would produce a confident `critical` on a `warning`, and the reviewer
 * would publish a severity the model never claimed. Coercion here is worse than
 * rejection, because rejection is visible and coercion is not.
 *
 * What local repair *is* good for: the structural failures that have exactly one
 * faithful answer.
 *
 *  - A top-level array instead of `{findings: [...]}`. Unambiguous.
 *  - Trailing commas, unterminated strings, single quotes. Handled by
 *    `jsonrepair` in the extract step, not here.
 *  - A single finding object instead of a response. Unambiguous.
 *
 * What it is not good for: severity vocabulary, missing quotes, invented line
 * numbers, findings attributed to files not in the chunk. Those go back to the
 * model, once, with the specific errors.
 *
 * ## The budget
 *
 * One repair request maximum, per chunk. Each repair costs one of 50 daily
 * requests, so an unbounded repair loop would let a misbehaving model consume
 * the entire day's allowance. `maxRepairs` is enforced here and is a parameter so
 * tests can assert the bound without a real budget.
 */

import { validateFindingsResponse, type ValidatedFindingsResponse, type ValidationIssue } from "../schema/finding.js";
import { extractJson } from "./extract.js";

/** Maximum repair requests per chunk. */
export const MAX_REPAIRS = 1;

/**
 * How a response was obtained.
 *
 * These carry through to diagnostics rather than collapsing to a single
 * "parsed" value. The distinction between a direct parse and one recovered from
 * a fenced block inside prose is the difference between a model that followed
 * the format and one that nearly did not, which is exactly what Phase 7 needs to
 * measure when it compares models.
 */
export type ParseStrategy =
  /** API-enforced structured output. Highest trust. */
  | "structured"
  /** The response was JSON, with nothing wrapped around it. */
  | "direct"
  /** JSON inside a markdown fence. */
  | "unfenced"
  /** JSON recovered from surrounding prose. */
  | "extracted"
  /** `jsonrepair` had to fix the syntax. */
  | "repaired"
  /** A top-level shape was unambiguously wrapped locally. */
  | "repaired_locally";

export interface ParseSuccess {
  readonly ok: true;
  readonly value: ValidatedFindingsResponse;
  readonly strategy: ParseStrategy;
  /** Non-fatal notes, e.g. a local repair that was applied. */
  readonly notes: readonly string[];
}

export interface ParseFailure {
  readonly ok: false;
  /**
   * Whether a repair *request* could plausibly help.
   *
   * False means the response was not JSON at all, or was structurally
   * hopeless — a re-ask would only waste quota, and the caller should record
   * `MODEL_OUTPUT_INVALID` and move to the next chunk or model.
   */
  readonly repairable: boolean;
  readonly issues: readonly ValidationIssue[];
  /** True when the response was not parseable as JSON. */
  readonly unparseable: boolean;
  readonly notes: readonly string[];
}

export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Normalise a parseable value that has the wrong top-level shape.
 *
 * Only the two unambiguous cases are handled. Anything else is returned as-is so
 * schema validation reports it, which keeps the "why" visible instead of
 * guessing.
 */
function normaliseTopLevel(value: unknown): { value: unknown; note: string | null } {
  // A bare array of findings.
  if (Array.isArray(value)) {
    return { value: { findings: value }, note: "wrapped a bare findings array" };
  }

  // A single finding object.
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      typeof record["buggyCodeQuote"] === "string" ||
      typeof record["explanation"] === "string" ||
      typeof record["severity"] === "string"
    ) {
      return { value: { findings: [record] }, note: "wrapped a single finding object" };
    }
  }

  return { value, note: null };
}

/**
 * Parse a model response into validated findings.
 *
 * `structured` is the value already parsed out of the response by
 * `STRUCTURED`-mode enforcement. When present it is preferred over the text,
 * because an API-enforced schema is more trustworthy than anything recovered
 * from prose.
 */
export function parseFindingsResponse(raw: string, structured: unknown = null): ParseResult {
  const notes: string[] = [];

  let candidate: unknown = structured;
  let strategy: ParseStrategy = "structured";

  if (candidate === null) {
    const extracted = extractJson(raw);
    if (extracted === null) {
      return {
        ok: false,
        repairable: true,
        // A repair is worth one request: the model produced text, so it can be
        // asked again. What is *not* worth it is another parse attempt.
        issues: [
          {
            path: "(root)",
            message: "the response contained no parseable JSON object",
          },
        ],
        unparseable: true,
        notes,
      };
    }
    candidate = extracted.value;
    // Carry the extraction strategy through rather than collapsing it. A direct
    // parse and one recovered from prose are different model behaviours, and
    // Phase 7 compares models on exactly that.
    strategy = extracted.strategy;
    if (extracted.strategy === "repaired") {
      notes.push("the response needed local JSON repair before validation");
    }
  }

  const normalised = normaliseTopLevel(candidate);
  if (normalised.note !== null) {
    notes.push(normalised.note);
    strategy = "repaired_locally";
  }

  const validated = validateFindingsResponse(normalised.value);

  if (validated.ok) {
    return { ok: true, value: validated.value, strategy, notes };
  }

  return {
    ok: false,
    // Everything that reached schema validation is potentially a vocabulary
    // error the model itself must fix.
    repairable: true,
    issues: validated.issues,
    unparseable: false,
    notes,
  };
}

/**
 * Build the repair message.
 *
 * Specific, bounded, and carrying no repository content. It quotes the model's
 * own field names back at it, which is what makes a small model fix the right
 * thing; a generic "please return valid JSON" reliably produces the same invalid
 * JSON.
 */
export function buildRepairMessage(result: ParseFailure, maxIssues = 6): string {
  const lines: string[] = [
    "Your previous response could not be used.",
    "",
  ];

  if (result.unparseable) {
    lines.push(
      "It was not valid JSON. Respond with a single JSON object and nothing else —",
      "no prose before it, no prose after it, and no markdown code fence.",
    );
  } else {
    lines.push("The problems were:");
    for (const issue of result.issues.slice(0, maxIssues)) {
      lines.push(`- ${issue.path}: ${issue.message}`);
    }
    if (result.issues.length > maxIssues) {
      lines.push(`- (and ${result.issues.length - maxIssues} more)`);
    }
  }

  lines.push(
    "",
    "The required shape is:",
    '{"findings":[{"path":"<file path from the diff File: header>",',
    '"buggyCodeQuote":"<exact text copied from the diff>",',
    '"explanation":"<the failure mode>",',
    '"severity":"critical|warning|info",',
    '"suggestedCode":null}]}',
    "",
    'Use severity "critical", "warning", or "info" — no other value is accepted.',
    "Set suggestedCode to null unless a concrete replacement is obvious.",
    "Reply with the corrected JSON object only.",
  );

  return lines.join("\n");
}
