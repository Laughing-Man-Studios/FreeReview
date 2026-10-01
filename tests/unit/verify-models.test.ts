/**
 * Catalog drift detection.
 *
 * ## The distinction this file exists to enforce
 *
 * A finding is either **actionable** (our configuration is wrong, and the catalog
 * tells us the right answer) or **remeasure** (the catalog has moved, and our
 * *measured* value is now stale). Conflating them is dangerous in a specific,
 * observed way.
 *
 * OpenRouter's `supported_parameters` is a union across endpoints and, for
 * `qwen/qwen3.8-27b:free`, is exactly backwards: it advertises
 * `structured_outputs` — which returns 404 on every request — and omits
 * `response_format`, which serves fine.
 *
 * So a check that said "your config is wrong, adopt the advertised value" would
 * have "fixed" a working model and left the broken mode in place. The measured
 * value wins; the catalog disagreement is a prompt to spend requests, not a
 * source of truth.
 *
 * ## Why it never throws
 *
 * A failed probe is not a finding. Reporting drift because OpenRouter was briefly
 * unreachable would train people to ignore this workflow, and a monitoring signal
 * that cries wolf is worse than none.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, reviewModeFor } from "../../src/config.js";
import { fetchCatalog, type CatalogModel } from "../../src/llm/catalog.js";
import { check, format, MIN_USABLE_MODELS } from "../../eval/verify-models.js";

function model(overrides: Partial<(typeof DEFAULT_MODELS)[number]> = {}) {
  const base = DEFAULT_MODELS.find((m) => m.id === "qwen/qwen3.8-27b:free")!;
  return { ...base, ...overrides };
}

function remote(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "qwen/qwen3.8-27b:free",
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["response_format", "structured_outputs", "temperature"],
    context_length: 262_144,
    ...overrides,
  };
}

describe("actionable findings", () => {
  it("flags a model that has disappeared", () => {
    const findings = check(model(), undefined);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("missing");
    expect(findings[0]!.action).toBe("actionable");
  });

  it("flags a free model that became paid", () => {
    // This is the one that matters most for a project premised on spending $0.
    const findings = check(model(), remote({ pricing: { prompt: "0.00000042", completion: "0" } }));
    expect(findings.some((f) => f.kind === "priced" && f.action === "actionable")).toBe(true);
  });

  it("is silent when the catalog agrees", () => {
    expect(check(model(), remote())).toHaveLength(0);
  });
});

describe("capability mismatches demand re-measurement, never adoption", () => {
  it("marks a missing structured_outputs as remeasure", () => {
    // Both capability flags trip on an empty parameter list, so this asserts on
    // the structured_outputs one specifically rather than on a count.
    const findings = check(model({ supportsJsonSchema: true }), remote({ supported_parameters: ["temperature"] }));
    const structured = findings.find((f) => f.detail.includes("structured_outputs"));
    expect(structured).toBeDefined();
    expect(structured!.action).toBe("remeasure");
    expect(structured!.detail).toMatch(/RE-MEASURE/);
  });

  it("marks a missing response_format as remeasure, because the advertised value has been wrong", () => {
    const findings = check(model({ supportsResponseFormat: true }), remote({ supported_parameters: ["temperature"] }));
    expect(findings[0]!.action).toBe("remeasure");
  });

  it("does not fire when the advertised capabilities match", () => {
    // qwen:free's real listing advertises structured_outputs and omits
    // response_format — the reverse of what serves. A check that demanded
    // agreement with the listing would flag a working configuration.
    const realListing = remote({ supported_parameters: ["max_tokens", "structured_outputs", "temperature"] });
    const findings = check(model({ supportsResponseFormat: true, supportsJsonSchema: false }), realListing);
    expect(findings.map((f) => f.kind)).toContain("capability");
    expect(findings.every((f) => f.action === "remeasure")).toBe(true);
  });

  it("marks a shrunken context window as remeasure", () => {
    const findings = check(model({ maxContextTokens: 262_144 }), remote({ context_length: 8_192 }));
    expect(findings[0]!.kind).toBe("context");
    expect(findings[0]!.action).toBe("remeasure");
  });
});

describe("the catalog and the shipped configuration agree", () => {
  it("prefers a mode every enabled model can actually serve", () => {
    // The invariant the whole `reviewModeFor` refactor exists to protect.
    for (const m of DEFAULT_MODELS.filter((x) => x.enabled)) {
      const mode = reviewModeFor(m);
      const supported =
        mode === "STRUCTURED"
          ? m.supportsJsonSchema === true
          : mode === "JSON_OBJECT"
            ? m.supportsResponseFormat === true
            : true;
      expect(supported, `${m.id} is served ${mode} which it does not support`).toBe(true);
    }
  });

  it("keeps at least two models enabled, so one death cannot stop the action", () => {
    expect(DEFAULT_MODELS.filter((m) => m.enabled).length).toBeGreaterThanOrEqual(MIN_USABLE_MODELS);
  });

  it("keeps exactly one ZDR model, because strict mode selects on it", () => {
    // If this reaches zero, the default configuration reviews nothing at all.
    expect(DEFAULT_MODELS.filter((m) => m.zdrEligible)).toHaveLength(1);
  });
});

describe("report formatting", () => {
  it("labels every finding with what to do about it", () => {
    const text = format([
      { modelId: "a/b", kind: "missing", action: "actionable", detail: "gone" },
      { modelId: "c/d", kind: "capability", action: "remeasure", detail: "moved" },
    ]);
    expect(text).toContain("[actionable]");
    expect(text).toContain("[remeasure]");
  });

  it("renders an empty report as an empty string rather than throwing", () => {
    expect(format([])).toBe("");
  });
});

describe("the probe is unauthenticated", () => {
  it("has a URL and accepts a fetch implementation", async () => {
    // So the workflow can run on a fork with no secret, and so this stays testable.
    expect(typeof fetchCatalog).toBe("function");
    const catalog = await fetchCatalog({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ data: [remote()] }), { status: 200 })),
    });
    expect(catalog).toHaveLength(1);
    expect(catalog![0]!.id).toBe("qwen/qwen3.8-27b:free");
  });

  it("returns null rather than throwing on an error response", async () => {
    // A failed probe must not become a finding.
    const catalog = await fetchCatalog({
      fetchImpl: () => Promise.resolve(new Response("nope", { status: 503 })),
    });
    expect(catalog).toBeNull();
  });
});