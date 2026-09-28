/**
 * The JSON Schema sent as `response_format.json_schema`.
 *
 * Only used in `STRUCTURED` mode, on models that advertise `structured_outputs`
 * and are therefore paired with `provider.require_parameters: true`. That
 * pairing is the whole reason this file is narrow: the schema must be one
 * OpenRouter's structured-output enforcement accepts, which in practice means
 * **every** object needs `additionalProperties: false` and an exhaustive
 * `required` list. A missing one does not degrade gracefully — it excludes every
 * endpoint and yields a 503.
 *
 * Deliberately not derived by reflecting over the Zod schema. A reflection-based
 * generator would be one more moving part whose output nobody has read, and this
 * schema is sent verbatim to a third party. It is written out, and
 * `tests/unit/json-schema.test.ts` asserts it stays consistent with the Zod
 * validator field by field — so if the two ever diverge, a test fails rather
 * than a review silently coming back empty.
 */

import {
  MAX_EXPLANATION_LENGTH,
  MAX_FINDINGS_PER_RESPONSE,
  MAX_PATH_LENGTH,
  MAX_QUOTE_LENGTH,
  MAX_SUGGESTION_LENGTH,
  SEVERITIES,
  type ValidatedFinding,
} from "./finding.js";

/** The validated finding type, re-exported so callers need one import. */
export type { ValidatedFinding };

export const FINDINGS_SCHEMA_NAME = "code_review_findings";

/**
 * `suggestedCode` is `["string", "null"]` rather than a nullable-only field.
 *
 * OpenRouter's structured-output enforcement requires every property to appear
 * in `required`; a property that may be omitted cannot also be constrained.
 * Making it explicitly nullable with a default of `null` means the model always
 * emits the key, and the prompt carries the instruction not to invent a patch to
 * populate it.
 */
export const findingsJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS_PER_RESPONSE,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "buggyCodeQuote", "explanation", "severity", "suggestedCode"],
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PATH_LENGTH,
            description:
              "The file path, copied exactly from the 'File:' header in the diff. " +
              "A finding whose path is not among the files shown cannot be anchored and will be dropped.",
          },
          buggyCodeQuote: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUOTE_LENGTH,
            description:
              "Exact source text copied verbatim from the diff, with no line numbers and no " +
              "leading +/- markers. This is the only thing used to place the comment, so it must " +
              "match the diff character for character.",
          },
          explanation: {
            type: "string",
            minLength: 1,
            maxLength: MAX_EXPLANATION_LENGTH,
            description:
              "The specific failure mode: what breaks, under what input or timing, and what the " +
              "consequence is. Not a restatement of the code.",
          },
          severity: {
            type: "string",
            enum: [...SEVERITIES],
          },
          suggestedCode: {
            type: ["string", "null"],
            maxLength: MAX_SUGGESTION_LENGTH,
            description:
              "Replacement code for the quoted lines, or null. Use null unless a concrete " +
              "replacement is obvious; do not invent a patch to fill this field.",
          },
        },
      },
    },
  },
};

/** The full `response_format` value. */
export function buildFindingsResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: FINDINGS_SCHEMA_NAME,
      strict: true,
      schema: findingsJsonSchema,
    },
  };
}
