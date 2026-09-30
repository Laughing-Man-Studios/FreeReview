/**
 * The evaluation must measure each model in the mode it actually ships in.
 *
 * ## The regression these guard against
 *
 * The first version of `eval/run.ts` did not look up the model's catalog entry.
 * It *constructed* a definition inline with `supportsResponseFormat: false,
 * supportsJsonSchema: false` — which forced every model into PROMPT_JSON mode
 * regardless of what it supports.
 *
 * That is invisible in the results. Nothing errored, the numbers looked
 * reasonable, and the harness produced exactly as many findings as before. But
 * `ling` was being measured natively while both structured-output models were
 * being measured in a degraded mode, and the comparison drawn from that data
 * ranked the degraded models as worse. `qwen` in particular was left carrying a
 * duplicate count and an injection-compliance score that may never have been its
 * own.
 *
 * A harness that quietly mis-measures its subject is worse than no harness,
 * because the numbers look authoritative while pointing the wrong way.
 */

import { describe, expect, it } from "vitest";
import { capabilityModeFor, DEFAULT_MODELS } from "../../src/config.js";
import type { CapabilityMode } from "../../src/types.js";

/**
 * The mode each model is expected to run in, derived from the catalog rather
 * than restated here — restating it is how the two lists drift apart, which is
 * the entire failure mode.
 */
function expectedMode(modelId: string): CapabilityMode {
  const model = DEFAULT_MODELS.find((m) => m.id === modelId);
  if (model === undefined) throw new Error(`${modelId} is not in the catalog`);
  return capabilityModeFor(model);
}

describe("each catalog model runs in the mode its capabilities select", () => {
  it("gives the ZDR model PROMPT_JSON, because it has no structured-output support", () => {
    // This one is correct as it was: no response_format, no structured_outputs.
    expect(expectedMode("inclusionai/ling-3.0-flash-sante:free")).toBe("PROMPT_JSON");
  });

  it("gives the structured-output models STRUCTURED, not PROMPT_JSON", () => {
    // The regression. All three of these were previously forced to PROMPT_JSON by
    // a hand-built definition that ignored the catalog.
    for (const id of [
      "qwen/qwen3.8-27b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "liquid/lfm-2.5-2.6b:free",
    ]) {
      expect(expectedMode(id), id).toBe("STRUCTURED");
    }
  });

  it("gives a response_format-only model JSON_OBJECT", () => {
    // `structured_outputs` is absent, so `require_parameters: true` would
    // exclude every endpoint. JSON_OBJECT is the correct middle ground.
    expect(expectedMode("google/gemma-4-31b-it:free")).toBe("JSON_OBJECT");
  });

  it("routes models with neither capability to PROMPT_JSON", () => {
    for (const id of [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "poolside/laguna-s-2.1:free",
      "thinkingmachines/inkling-small:free",
    ]) {
      expect(expectedMode(id), id).toBe("PROMPT_JSON");
    }
  });
});

describe("no model is silently measured in a mode weaker than it supports", () => {
  it("holds for every catalog entry", () => {
    for (const model of DEFAULT_MODELS) {
      const mode = capabilityModeFor(model);

      if (model.supportsJsonSchema === true) {
        expect(mode, `${model.id} supports json_schema but selected ${mode}`).toBe("STRUCTURED");
      }
      if (model.supportsResponseFormat === true && model.supportsJsonSchema !== true) {
        expect(mode, `${model.id} supports response_format but selected ${mode}`).toBe("JSON_OBJECT");
      }
      if (model.supportsJsonSchema === false && model.supportsResponseFormat === false) {
        expect(mode, `${model.id} supports neither but selected ${mode}`).toBe("PROMPT_JSON");
      }
    }
  });
});

describe("the evaluation covers the whole candidate field", () => {
  it("includes the two models the catalog disables for privacy", () => {
    // They are disabled for *shipping* under the default privacy mode, but they
    // are reachable under `relaxed` and the fallback chain question is about
    // relaxed. Excluding them from measurement would leave a real decision
    // unmade.
    const disabled = DEFAULT_MODELS.filter((m) => !m.enabled);
    expect(disabled.map((m) => m.id)).toEqual(
      expect.arrayContaining(["poolside/laguna-s-2.1:free", "thinkingmachines/inkling-small:free"]),
    );
  });

  it("marks exactly one model ZDR-capable, since strict mode selects on it", () => {
    // If this ever becomes zero, the default configuration reviews nothing at all
    // under the default privacy mode — which is why the endpoint check is
    // re-verified in Phase 8 rather than assumed to hold.
    expect(DEFAULT_MODELS.filter((m) => m.zdrEligible).map((m) => m.id)).toEqual([
      "inclusionai/ling-3.0-flash-sante:free",
    ]);
  });
});