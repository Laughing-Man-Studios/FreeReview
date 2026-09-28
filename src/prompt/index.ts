/**
 * Prompt, schema, and parsing — the assembly point.
 *
 * Re-exports the pieces the pipeline needs so callers have one import, and
 * provides `buildChatRequest`, which is the single place where a rendered chunk
 * becomes a chat-completions request.
 *
 * Kept as a facade rather than having `run.ts` compose four modules directly,
 * because the ordering of those four is a correctness property: the mode
 * determines the response format, the mode determines the prompt, and the parser
 * needs to know which of the two produced the payload. Getting that wrong means
 * sending a `json_schema` to a model that cannot enforce it (a 503) or
 * hand-parsing an API-enforced schema (unnecessary repair requests).
 */

import { buildSystemPrompt } from "./system.js";
import { buildUserMessage } from "./user.js";
import { FINDINGS_SCHEMA_NAME, findingsJsonSchema } from "../schema/json-schema.js";
import { capabilityModeFor, type ModelDefinition } from "../config.js";
import { parseFindingsResponse, type ParseResult } from "../parse/repair.js";
import type { ChatMessage, ChatRequest, JsonSchemaDefinition } from "../llm/client.js";
import type { CapabilityMode } from "../types.js";
import type { ValidatedFindingsResponse } from "../schema/finding.js";
import type { RenderedChunk } from "../diff/render.js";

export { PROMPT_VERSION, CONFIG_VERSION, resultIdentity } from "./version.js";
export { buildSystemPrompt } from "./system.js";
export { buildUserMessage } from "./user.js";
export {
  buildFindingsResponseFormat,
  findingsJsonSchema,
  FINDINGS_SCHEMA_NAME,
} from "../schema/json-schema.js";
export { describeSchema, SEVERITIES, MAX_FINDINGS_PER_RESPONSE } from "../schema/finding.js";

/** The schema in the shape `ChatRequest` expects. */
export const FINDINGS_SCHEMA: JsonSchemaDefinition = {
  name: FINDINGS_SCHEMA_NAME,
  strict: true,
  schema: findingsJsonSchema,
};

/**
 * Whether the model needs a strict JSON schema, only `json_object`, or neither.
 *
 * Delegates to the same `capabilityModeFor` the config layer uses, so there is
 * one answer to "what can this model do" rather than two that can disagree.
 */
export function modeForModel(model: ModelDefinition): CapabilityMode {
  return capabilityModeFor(model);
}

/**
 * Build the complete request for one chunk.
 *
 * `maxOutputTokens` is the caller's decision because it depends on the chunk:
 * a small diff does not need the full budget, and at 50 requests/day every
 * wasted output token is a wasted one.
 */
export function buildChatRequest(
  rendered: RenderedChunk,
  model: ModelDefinition,
  maxOutputTokens: number,
): ChatRequest {
  const mode = modeForModel(model);

  return {
    model,
    mode,
    messages: buildMessages(rendered, mode),
    // Only STRUCTURED mode receives a schema. Sending one in JSON_OBJECT mode
    // would claim an enforcement the endpoint does not provide, and sending
    // `require_parameters` with it would exclude every endpoint.
    ...(mode === "STRUCTURED" ? { schema: FINDINGS_SCHEMA } : {}),
    maxOutputTokens,
  };
}

export function buildMessages(rendered: RenderedChunk, mode: CapabilityMode): readonly ChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(mode) },
    { role: "user", content: buildUserMessage(rendered, mode) },
  ];
}

export interface ParsedFindings {
  readonly value: ValidatedFindingsResponse;
  readonly strategy: string;
  readonly notes: readonly string[];
}

/**
 * Parse a completed response into validated findings.
 *
 * `parsed` is the value the client extracted from a JSON body; it is preferred
 * when present, because an API-enforced schema is more trustworthy than
 * anything recovered from prose.
 */
export function parseResponse(content: string, parsed: unknown): ParseResult {
  return parseFindingsResponse(content, parsed);
}

export { parseFindingsResponse, buildRepairMessage, MAX_REPAIRS } from "../parse/repair.js";
export { extractJson, stripCodeFence, braceCandidates } from "../parse/extract.js";
export type { ParseResult, ParseStrategy } from "../parse/repair.js";
