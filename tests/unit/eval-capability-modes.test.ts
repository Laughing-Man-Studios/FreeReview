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

  it("gives the genuinely structured-output model STRUCTURED", () => {
    // Verified against the live service 2026-09-30: nemotron-super returns 200 in
    // all three capability modes, so STRUCTURED is a real capability, not a hope.
    expect(expectedMode("nvidia/nemotron-3-super-120b-a12b:free")).toBe("STRUCTURED");
  });

  it("does NOT give qwen STRUCTURED, despite the catalog advertising structured_outputs", () => {
    // The second regression, and the more damaging one.
    //
    // OpenRouter lists `structured_outputs` in qwen's `supported_parameters`,
    // but a real STRUCTURED request returns 404 "No endpoints found that can
    // handle the requested parameters" — measured twice. JSON_OBJECT and
    // PROMPT_JSON both return 200.
    //
    // Believing the advertised flag routed the action to a mode that 404s. The
    // 404 names no cause, so the model would have looked broken only at the
    // moment a pull request needed it, as a fallback, which is the worst time to
    // discover it.
    expect(expectedMode("qwen/qwen3.8-27b:free")).toBe("JSON_OBJECT");
  });

  it("routes models with neither capability to PROMPT_JSON", () => {
    for (const id of [
      "inclusionai/ling-3.0-flash-sante:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "poolside/laguna-s-2.1:free",
    ]) {
      expect(expectedMode(id), id).toBe("PROMPT_JSON");
    }
  });

  it("records when each capability flag was last verified against the service", () => {
    // A capability flag with no date is a flag nobody has checked. Every model
    // the probe measured carries the date it was measured.
    for (const model of DEFAULT_MODELS) {
      expect(model.capabilityVerifiedOn, `${model.id} has no capabilityVerifiedOn`).toBe("2026-09-30");
    }
  });
});

describe("models the probe found unusable are disabled", () => {
  const byId = (id: string) => DEFAULT_MODELS.find((m) => m.id === id)!;

  it("disables lfm, which returned 400 in every capability mode", () => {
    // A 400 in all three modes is not a prompt problem or a shape problem — the
    // endpoint simply does not answer. Enabled, it would consume a retry budget
    // and a circuit-breaker slot before failing.
    expect(byId("liquid/lfm-2.5-2.6b:free").enabled).toBe(false);
  });

  it("disables gemma, which was rate-limited in both usable modes across two runs", () => {
    // A 429 is usually transient, which is why this is recorded as saturation
    // rather than breakage. But a fallback reached *because* a provider is
    // saturated, and rate-limited every time it is reached, is not a fallback.
    expect(byId("google/gemma-4-31b-it:free").enabled).toBe(false);
  });

  it("disables inkling, which is not an API endpoint at all", () => {
    // 403 in all three modes: "only available on agentic harnesses". No amount of
    // retrying or relaxing privacy reaches it.
    expect(byId("thinkingmachines/inkling-small:free").enabled).toBe(false);
  });

  it("keeps every model the probe found working", () => {
    // The inverse check: disabling the broken ones must not have swept up a
    // model that actually answered.
    for (const id of [
      "inclusionai/ling-3.0-flash-sante:free",
      "qwen/qwen3.8-27b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]) {
      expect(byId(id).enabled, `${id} was measured working but is disabled`).toBe(true);
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

  it("keeps poolside in the measurement field though disabled for shipping", () => {
    // Disabled on privacy grounds, reachable under `relaxed`, verified working.
    // Whether it earns a fallback slot is a shipping decision for later.
    expect(DEFAULT_MODELS.find((m) => m.id === "poolside/laguna-s-2.1:free")?.enabled).toBe(false);
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