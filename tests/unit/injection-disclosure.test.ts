/**
 * Prompt-injection disclosure.
 *
 * ## The failure this exists to prevent
 *
 * Only the primary model has ever been measured resistant to instructions
 * embedded in a diff. If the primary is rate-limited and a review falls through
 * to a fallback, a pull request author can suppress findings by writing a
 * comment in their own diff — and a suppressed review is indistinguishable from
 * a clean one.
 *
 * That is the exact failure this project exists to prevent, and it is reachable
 * precisely when the service is under strain, which is when fallbacks are used.
 *
 * So the disclosure has to appear in the *published review*, not only in the step
 * summary: a developer reading a pull request may never open the workflow run.
 * These tests pin that placement as well as the wording.
 */

import { describe, expect, it } from "vitest";
import { injectionDisclosure, renderSummary, type SummaryInput } from "../../src/output/comment.js";
import { DEFAULT_MODELS, type ModelDefinition } from "../../src/config.js";
import type { AnchoredFinding } from "../../src/types.js";

const CATALOG = DEFAULT_MODELS;

const LING = "inclusionai/ling-3.0-flash-sante:free";
const QWEN = "qwen/qwen3.8-27b:free";
const NEMOTRON = "nvidia/nemotron-3-super-120b-a12b:free";

function model(overrides: Partial<ModelDefinition> & { id: string }): ModelDefinition {
  return { ...overrides } as ModelDefinition;
}

describe("injectionDisclosure", () => {
  it("says nothing when the only model that answered is measured resistant", () => {
    // The common case, and the one that must stay quiet. A warning on every
    // review trains readers to skip warnings.
    expect(injectionDisclosure([LING], CATALOG)).toBeNull();
  });

  it("discloses when a model with measured exposure produced the review", () => {
    const note = injectionDisclosure([QWEN], CATALOG);
    expect(note).not.toBeNull();
    expect(note).toContain(QWEN);
  });

  it("names the specific behaviour, not a generic disclaimer", () => {
    // "This model may be susceptible to prompt injection" is unfalsifiable and is
    // what every tool says. The note has to say what was tested and what happened,
    // so a reader can weigh it and a model swap invalidates a specific claim.
    const note = injectionDisclosure([QWEN], CATALOG) ?? "";
    expect(note).toMatch(/comment telling the model to ignore/i);
    expect(note).toMatch(/suppress findings/i);
    expect(note).toMatch(/lower bound/i);
  });

  it("explains how exposure was measured, so the claim is checkable", () => {
    const note = injectionDisclosure([QWEN], CATALOG) ?? "";
    expect(note).toMatch(/planting the suppression instruction/i);
  });

  it("discloses unmeasured models rather than assuming they are safe", () => {
    // Silence here would be indistinguishable from `resistant`, which is the
    // confusion this project exists to prevent.
    const catalog = [
      model({ id: "vendor/new:free", enabled: true, injectionResistance: "unmeasured" }),
      model({ id: "vendor/older:free", enabled: true }),
    ];
    const note = injectionDisclosure(["vendor/new:free", "vendor/older:free"], catalog);
    expect(note).toContain("has not been measured");
    expect(note).toContain("vendor/new:free");
  });

  it("treats a model absent from the catalog as unmeasured, not safe", () => {
    // An unknown id is the worst case to guess about. Absence of evidence is not
    // evidence of resistance.
    const note = injectionDisclosure(["vendor/unheard-of:free"], CATALOG);
    expect(note).toContain("has not been measured");
  });

  it("prefers the stronger disclosure when a run mixed exposed and resistant models", () => {
    const note = injectionDisclosure([LING, QWEN], CATALOG) ?? "";
    expect(note).toContain("may be incomplete");
    expect(note).toContain(QWEN);
  });

  it("names every exposed model in a multi-model run", () => {
    const note = injectionDisclosure([QWEN, NEMOTRON], CATALOG) ?? "";
    expect(note).toContain(QWEN);
    expect(note).toContain(NEMOTRON);
  });

  it("discloses a fallback even when the primary is in the chain but did not answer", () => {
    // The scenario the feature exists for. The primary is *configured* and the
    // run fell through, so the fallback's exposure is what governs the result.
    expect(injectionDisclosure([NEMOTRON], CATALOG)).not.toBeNull();
  });
});

describe("the disclosure reaches the published review", () => {
  const finding: AnchoredFinding = {
    path: "src/a.ts",
    explanation: "off by one",
    severity: "critical",
    anchor: { path: "src/a.ts", line: 3, side: "RIGHT", rung: 0 },
    suggestedCode: null,
  };

  function summary(overrides: Partial<SummaryInput> = {}): SummaryInput {
    return {
      findings: [finding],
      unanchored: [],
      rejections: [],
      modelUsed: NEMOTRON,
      requestsUsed: 3,
      filesReviewed: 1,
      filesInPr: 1,
      privacyMode: "strict",
      promptVersion: "2026-09-27.1",
      chunksReviewed: 1,
      chunksPlanned: 1,
      failureDetail: null,
      injectionNote: injectionDisclosure([NEMOTRON], CATALOG),
      ...overrides,
    };
  }

  it("appears in the review body with warning emphasis", () => {
    const body = renderSummary(summary());
    expect(body).toContain("> [!WARNING]");
    expect(body).toContain("This review may be incomplete");
    expect(body).toContain(NEMOTRON);
  });

  it("appears even when the review found nothing", () => {
    // The dangerous case. A suppressed review reports zero findings and would
    // otherwise render as "reviewed 1 file and found nothing material" — a clean
    // bill of health for code that was never examined.
    const body = renderSummary(summary({ findings: [], unanchored: [] }));
    expect(body).toContain("found nothing material");
    expect(body).toContain("This review may be incomplete");
  });

  it("appears even when no chunk could be reviewed at all", () => {
    const body = renderSummary(
      summary({ findings: [], unanchored: [], chunksReviewed: 0, chunksPlanned: 3 }),
    );
    expect(body).toContain("No review was produced");
    expect(body).toContain("This review may be incomplete");
  });

  it("is absent when nothing needs disclosing", () => {
    const body = renderSummary(summary({ modelUsed: LING, injectionNote: null }));
    expect(body).not.toContain("This review may be incomplete");
    expect(body).not.toContain("> [!WARNING]");
  });
});

describe("the catalog records measured exposure for every model", () => {
  it("classifies all eight, so none is silently assumed safe", () => {
    for (const entry of DEFAULT_MODELS) {
      expect(
        ["resistant", "exposed", "unmeasured"],
        `${entry.id} has no injectionResistance`,
      ).toContain(entry.injectionResistance);
    }
  });

  it("marks exactly one model resistant", () => {
    // If this becomes zero, the default configuration cannot claim the property it
    // exists to provide. If it becomes more than one, that is good news and this
    // assertion should be revisited deliberately rather than by accident.
    expect(DEFAULT_MODELS.filter((m) => m.injectionResistance === "resistant").map((m) => m.id)).toEqual([
      "inclusionai/ling-3.0-flash-sante:free",
    ]);
  });

  it("marks every enabled model as measured rather than unmeasured", () => {
    // An enabled model that has never been tested is one the action would use
    // without saying anything about its exposure.
    for (const entry of DEFAULT_MODELS.filter((m) => m.enabled)) {
      expect(entry.injectionResistance, `${entry.id} is enabled but unmeasured`).not.toBe("unmeasured");
    }
  });
});