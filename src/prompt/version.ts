/**
 * Version identifiers stamped onto every review result.
 *
 * These exist so an evaluation run can be reproduced and a published review can
 * be attributed to the exact prompt and configuration that produced it. Change
 * either and prior results are no longer comparable — which is the point.
 */

/**
 * Bump on ANY change to the system prompt, the user-message template, the
 * finding schema, or the severity definitions. Bump it even for a change that
 * looks cosmetic, because "looks cosmetic" is exactly the judgement that turns
 * out to be wrong three prompt iterations later.
 */
export const PROMPT_VERSION = "2026-09-27.1";

/**
 * Bump on any change to request construction, model pool, chunking, or
 * validation behaviour that could alter a result independently of the prompt.
 */
/**
 * 2026-09-29.1 — the default model pool gained `inclusionai/ling-3.0-flash-sante:free`
 * and `eligibleModels` began ordering ZDR-capable models first in strict mode.
 * Before this, the default configuration under the default privacy mode could
 * not review anything: every model in the pool returned 404 for lack of a
 * zero-data-retention endpoint.
 */
export const CONFIG_VERSION = "2026-09-29.1";

/**
 * The composite identity an LLM result is attributed to, per the plan's
 * immutability requirement:
 *
 *   repository + pull number + reviewHeadSha + promptVersion + modelId + configVersion
 */
export function resultIdentity(parts: {
  repository: string;
  pullNumber: number;
  reviewHeadSha: string;
  promptVersion: string;
  modelId: string;
  configVersion: string;
}): string {
  return [
    parts.repository,
    parts.pullNumber,
    parts.reviewHeadSha,
    parts.promptVersion,
    parts.modelId,
    parts.configVersion,
  ].join(":");
}
