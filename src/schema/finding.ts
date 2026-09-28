/**
 * The finding schema.
 *
 * This is the contract between the model and the reviewer, and the single most
 * consequential file in the project. Two properties matter more than the field
 * list:
 *
 * 1. **Validation is strict and non-coercing.** A finding that does not match
 *    this schema is rejected whole, never partially interpreted. Partial
 *    interpretation is how a model that returned prose instead of JSON ends up
 *    producing a confident-looking comment anchored to the wrong line.
 *
 * 2. **Every field is bounded.** All five fields are model-controlled strings
 *    that end up rendered into a review comment. Without a length cap a model
 *    can emit a megabyte of text into a PR comment, and the free-model quota
 *    makes large outputs a genuine cost rather than a hypothetical one.
 *
 * `path` is required, which the original design record omitted. Chunks span
 * multiple files (to conserve the 50/day request budget), so without a path a
 * quote cannot be attributed to a file and cannot be anchored at all.
 */

import { z } from "zod";

/**
 * Maximum length of `buggyCodeQuote`, in characters.
 *
 * Sized above any plausible anchor (the longest useful quote is a function
 * signature plus a few lines) and far below the input window. A quote longer
 * than this is the model having quoted a whole function, which anchors
 * ambiguously anyway.
 */
export const MAX_QUOTE_LENGTH = 1_200;

/**
 * Maximum length of `explanation`, in characters.
 *
 * A finding whose explanation runs longer than this has stopped explaining a
 * failure mode and started writing an essay, which is the signal that the model
 * is padding rather than reasoning.
 */
export const MAX_EXPLANATION_LENGTH = 2_000;

/** Maximum length of `suggestedCode`, in characters. */
export const MAX_SUGGESTION_LENGTH = 2_000;

/** Maximum findings accepted from one chunk. */
export const MAX_FINDINGS_PER_RESPONSE = 20;

/** Maximum length of a repository path, in characters. */
export const MAX_PATH_LENGTH = 400;

export const SEVERITIES = ["critical", "warning", "info"] as const;

/**
 * Severity, enum-constrained.
 *
 * Never coerced. `"high"` and `"error"` are not silently mapped to `critical`:
 * a model that cannot follow the enum has misunderstood the task, and quietly
 * repairing its vocabulary hides that. It is rejected, counted, and reported.
 */
export const severitySchema = z.enum(SEVERITIES);

/**
 * A path as reported in a finding.
 *
 * Only the characters that can legitimately appear in a repository path are
 * permitted. This is not about traversal — the path is matched against the set
 * of files in the pull request, so a traversal attempt is inert — but a path
 * containing a newline could break out of the fenced block in a review comment
 * and impersonate structure to anyone reading it.
 */
/** True if the string contains a C0/C1 control character. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const pathSchema = z
  .string()
  .min(1, "path is required")
  .max(MAX_PATH_LENGTH)
  .refine((value) => !hasControlCharacter(value), {
    message: "path must not contain control characters",
  })
  .refine((value) => value.trim() === value && value.length > 0, {
    message: "path must not have leading or trailing whitespace",
  });

/**
 * The quote that will be anchored.
 *
 * Trimmed rather than rejected on surrounding whitespace: models routinely wrap
 * a quote in a newline. The trim happens before anchoring, so it cannot change
 * which source text is matched beyond stripping the wrapper.
 */
const quoteSchema = z
  .string()
  .min(1, "buggyCodeQuote is required; a finding without a quote cannot be anchored")
  .max(MAX_QUOTE_LENGTH, `buggyCodeQuote must be at most ${MAX_QUOTE_LENGTH} characters`)
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    message: "buggyCodeQuote must not be whitespace only",
  });

const explanationSchema = z
  .string()
  .min(1, "explanation is required")
  .max(MAX_EXPLANATION_LENGTH, `explanation must be at most ${MAX_EXPLANATION_LENGTH} characters`)
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: "explanation must not be whitespace only" });

/**
 * Suggested replacement code.
 *
 * `null` is explicitly allowed and explicitly encouraged. The plan requires the
 * model not to invent a patch merely to populate a field, so an empty string is
 * treated as "no suggestion" rather than as a zero-length replacement, and a
 * whitespace-only suggestion is rejected outright — publishing a blank
 * suggestion block is worse than publishing none.
 */
const suggestionSchema = z
  .string()
  .max(MAX_SUGGESTION_LENGTH, `suggestedCode must be at most ${MAX_SUGGESTION_LENGTH} characters`)
  .transform((value) => value.trim())
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional()
  .default(null);

export const rawFindingSchema = z
  .object({
    path: pathSchema,
    buggyCodeQuote: quoteSchema,
    explanation: explanationSchema,
    severity: severitySchema,
    suggestedCode: suggestionSchema,
  })
  // A finding object with extra keys is a model that returned something other
  // than what was asked for. Rejecting is safer than ignoring: the extra field
  // is usually a corrected `lineNumber` or an `anchor` the model invented, and
  // silently dropping it hides that the model was trying to place the comment
  // itself.
  .strict();

/**
 * The top-level response.
 *
 * `findings` is required and must be an array. A response that omits the key
 * entirely is ambiguous between "no findings" and "malformed", and those two
 * mean opposite things: the first is a clean review, the second is a model that
 * did not comply. Only an explicit empty array counts as a clean review.
 */
export const rawFindingsResponseSchema = z
  .object({
    findings: z.array(rawFindingSchema).max(MAX_FINDINGS_PER_RESPONSE, {
      message: `a chunk may produce at most ${MAX_FINDINGS_PER_RESPONSE} findings`,
    }),
  })
  .strict();

export type RawFindingInput = z.input<typeof rawFindingSchema>;
export type RawFindingParsed = z.output<typeof rawFindingSchema>;

/** The validated response shape, after transforms have run. */
export type ValidatedFinding = RawFindingParsed;

/** The validated response, matching the `RawFindingsResponse` domain type. */
export type ValidatedFindingsResponse = {
  readonly findings: readonly ValidatedFinding[];
};

/**
 * Validate a parsed response, reporting every problem rather than the first.
 *
 * A model that returns three findings with three different schema violations
 * should be told about all three. Failing on the first means the repair prompt
 * addresses one problem, the model fixes it, and the next run trips the second —
 * turning one request into three against a 50/day budget.
 */
export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `findings[1].severity`. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * Render a Zod issue path as a JS-style accessor path.
 *
 * Zod 4 emits `findings.0.severity`. The repair prompt quotes these paths back
 * at the model, and a model reasoning about `findings[1].severity` gets there
 * faster than one reasoning about `findings.1.severity` — and a smaller model may
 * not get there at all. The path is also read by a human in a step summary.
 */
function issuePath(error: z.core.$ZodIssue): string {
  if (error.path.length === 0) return "(root)";
  return error.path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc === "" ? String(segment) : `${acc}.${String(segment)}`;
  }, "");
}

export function validateFindingsResponse(input: unknown): ValidationResult<ValidatedFindingsResponse> {
  const result = rawFindingsResponseSchema.safeParse(input);

  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issuePath(issue),
      message: issue.message,
    })),
  };
}

/**
 * Validate a single finding.
 *
 * Used by the repair path, which re-validates one finding at a time so a
 * malformed finding does not cost the whole response.
 */
export function validateFinding(input: unknown): ValidationResult<ValidatedFinding> {
  const result = rawFindingSchema.safeParse(input);

  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issuePath(issue),
      message: issue.message,
    })),
  };
}

/**
 * Describe the schema as a compact instruction for the prompt.
 *
 * Used in `PROMPT_JSON` mode, where no `response_format` is sent and the prompt
 * has to carry the whole contract. Kept derived from the same constants the
 * validator uses, so the prompt cannot drift from the schema it describes.
 *
 * **Every value shown is valid JSON.** A placeholder written as bare
 * `<placeholder>` rather than a quoted string teaches a model to emit invalid
 * JSON — and in `PROMPT_JSON` mode, where nothing enforces the shape, that is
 * the single most expensive mistake available. `tests/unit/schema.test.ts`
 * parses this string and fails if it is not valid JSON.
 */
export function describeSchema(): string {
  return [
    '{"findings":[{"path":"src/example.ts",',
    '"buggyCodeQuote":"const x = 1;",',
    '"explanation":"x is never incremented, so the loop cannot terminate.",',
    `"severity":"${SEVERITIES[0]}",`,
    '"suggestedCode":null}]}',
  ].join("");
}
