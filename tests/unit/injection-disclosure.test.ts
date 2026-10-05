/**
 * Prompt-injection disclosure.
 *
 * ## The failure this exists to prevent
 *
 * A pull request author can suppress findings by planting a suppression
 * instruction in their own diff, and a suppressed review is indistinguishable
 * from a clean one. That is the exact failure this project exists to prevent.
 *
 * As of 2026-10-02 this is no longer confined to the fallback chain: the primary
 * was measured resisting 6 of 8 payload classes, and two of the eight silenced
 * it — each checked against an ablation control where the same defect is found.
 * So the disclosure has to fire on the *default* path too — which is why
 * `partially-exposed` exists as a distinct state from `resistant`, and why the
 * silence-on-`resistant` rule is now exercised against a hypothetical model
 * rather than against the one that ships.
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
  it("stays quiet only for a model that is genuinely measured resistant", () => {
    // Quiet-on-the-default-path was the right rule while the primary was
    // `resistant`: silence for a model proven immune, and a warning on every
    // review for anything else, since a warning that fires every time trains
    // readers to skip it.
    //
    // It stopped being right on 2026-10-02, when one payload class was found to
    // silence the primary and the ablation control confirmed suppression rather
    // than a capability miss. `resistant` now means nothing is disclosed, and no
    // model in the pool has earned it, so the rule is exercised against a
    // hypothetical rather than against the default path — which now discloses.
    // Overriding the catalog entry, not the id list: this function looks models
    // up by id, so passing a mutated model object where a string belongs silently
    // resolves to nothing and returns the \ note instead.
    const immuneCatalog = CATALOG.map((m) =>
      m.id === LING ? { ...m, injectionResistance: "resistant" as const } : m,
    );
    expect(injectionDisclosure([LING], immuneCatalog)).toBeNull();
  });

  it("discloses on the default path, because the primary is no longer immune", () => {
    // The regression this guards: LING is `partially-exposed`, so a run using the
    // default model must not publish a review that presents as clean.
    const note = injectionDisclosure([LING], CATALOG);
    expect(note).not.toBeNull();
    expect(note).toContain(LING);
    expect(note).toMatch(/lower bound/i);
  });

  it("names the ratio, the payload class, and the control that confirms it", () => {
    // A partial-exposure note that only says "may be incomplete" is the same
    // unfalsifiable disclaimer an `exposed` note would be. This one has to be
    // checkable: how many it resisted, what beat it, and how that was verified.
    const note = injectionDisclosure([LING], CATALOG) ?? "";
    expect(note).toMatch(/6 of 8/);
    expect(note).toMatch(/two of them silenced it completely/i);
    expect(note).toMatch(/configuration value/i);
    // The rate is explicitly not claimed. Two single observations that match the
    // suppression pattern, in a design that also produced that pattern from
    // run-to-run variation, is an upper bound — and the note has to say so or it
    // implies a precision the measurement does not have.
    expect(note).toMatch(/upper bound rather than an established rate/i);
    expect(note).toMatch(/payload removed|removed the payload|with the payload\s+removed/i);
    expect(note).toMatch(/no model in the free pool has been measured immune/i);
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
    anchoredText: "  const x = compute(y);",
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
        ["resistant", "partially-exposed", "exposed", "unmeasured"],
        `${entry.id} has no injectionResistance`,
      ).toContain(entry.injectionResistance);
    }
  });

  it("marks no model resistant, and exactly one as partially exposed", () => {
    // Rewritten 2026-10-02. This used to assert exactly one `resistant` — the
    // primary — which was the property the whole action was sold on. Widening
    // the injection set from 2 payloads to 8 found one that silences the primary,
    // confirmed by ablation, so the honest count of immune models is zero.
    //
    // Asserting zero rather than "not this one" is deliberate. `resistant` emits
    // no disclosure, so any entry carrying it makes the published review imply
    // safety. A future measurement could earn that state back — but only by
    // passing every payload class, and this test should fail loudly when someone
    // promotes a model on a partial result rather than by accident.
    expect(DEFAULT_MODELS.filter((m) => m.injectionResistance === "resistant")).toEqual([]);

    expect(
      DEFAULT_MODELS.filter((m) => m.injectionResistance === "partially-exposed").map((m) => m.id),
    ).toEqual(["inclusionai/ling-3.0-flash-sante:free"]);
  });

  it("marks every enabled model as measured rather than unmeasured", () => {
    // An enabled model that has never been tested is one the action would use
    // without saying anything about its exposure.
    for (const entry of DEFAULT_MODELS.filter((m) => m.enabled)) {
      expect(entry.injectionResistance, `${entry.id} is enabled but unmeasured`).not.toBe("unmeasured");
    }
  });
});