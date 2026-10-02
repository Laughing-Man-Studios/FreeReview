/**
 * Documentation must not drift from the code it describes.
 *
 * ## Why this exists
 *
 * A documentation audit on 2026-10-01 found the README's model table did not
 * contain the model that actually ships as primary. It listed `qwen` as taking
 * JSON Schema, which 404s on every request; it listed `lfm` and `gemma` as
 * fallbacks, both of which had been disabled on measured evidence; and it had no
 * notion of capability mode or injection resistance, both of which turned out to
 * be the load-bearing discoveries of the evaluation.
 *
 * Nothing failed. Every claim was individually plausible and collectively wrong,
 * and no test would have caught it. These tests are that catch.
 *
 * The rule is narrow on purpose: assert the things that *changed under us* and
 * that a reader would act on. Asserting prose would rot into brittleness and
 * train the assertion to be deleted the first time it annoys someone.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS } from "../../src/config.js";

const read = (p: string): string => readFileSync(join(import.meta.dirname, "..", "..", p), "utf8");

const README = read("README.md");

/** Prose wraps in Markdown, so claims are matched against a whitespace-collapsed copy. */
const flat = (text: string): string => text.replace(/\s+/g, " ");
const PLAN = read("docs/execution-plan.md");
const SECURITY = read("SECURITY.md");
const EVAL = read("docs/model-evaluation.md");

const byId = (id: string) => DEFAULT_MODELS.find((m) => m.id === id);

describe("the README documents every action input", () => {
  // The second documentation audit found `github_token` and `strict_providers`
  // documented in action.yml but absent from the README's input table — so a
  // reader configuring the action could not discover either. Both were added in
  // earlier phases and both were missed.
  it("lists every input action.yml declares", () => {
    const declared = [...read("action.yml").matchAll(/^ {2}([a-z_]+):$/gm)].map((m) => m[1]!);
    const documented = new Set([...README.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!));

    // Only inputs belong here; outputs are declared in the same file and are
    // documented in their own table.
    const inputs = declared.filter((name) => !/^(status|findings_count|unanchored_count|files_reviewed|model_used|requests_used|review_url)$/.test(name));

    for (const name of inputs) {
      expect(documented.has(name), `action.yml declares '${name}' but the README input table omits it`).toBe(true);
    }
    expect(inputs.length).toBeGreaterThanOrEqual(10);
  });

  it("documents that strict_providers narrows availability", () => {
    // The trade is the whole point. A reader who sees only "pin your providers"
    // will set it and be surprised when reviews stop.
    expect(README).toMatch(/strict_providers/);
    expect(flat(README)).toMatch(/Narrows availability/i);
  });
});

describe("the README documents credential redaction", () => {
  it("states what is redacted and where", () => {
    expect(flat(README)).toMatch(/[Rr]edacts? credential-shaped/);
    for (const surface of ["review body", "step summary", "quoted source", "suggestion"]) {
      expect(README, `README does not say redaction covers the ${surface}`).toContain(surface);
    }
  });

  it("names the correct fix as something redaction must preserve", () => {
    // The false positive that would make redaction worse than none.
    expect(flat(README)).toMatch(/process\.env\.API_KEY/);
  });

  it("states the limitation rather than implying completeness", () => {
    expect(README).toMatch(/Not covered/i);
    expect(flat(README)).toMatch(/Rotating a leaked key is still the only fix/i);
  });
});

describe("the README states the open weakness rather than implying completeness", () => {
  it("says the fallback chain has no injection-resistant model", () => {
    // The single most important thing a prospective user should know, and the
    // thing a project with this premise is most tempted to bury.
    expect(README).toMatch(/fallback chain/i);
    expect(flat(README)).toMatch(/largest open weakness/i);
  });

  it("does not claim Phase 8 closed it", () => {
    expect(flat(PLAN)).toMatch(/fallback chain has no injection-resistant model past the primary/i);
  });
});

describe("the README model table matches the catalog", () => {
  it("names the model that actually ships as primary", () => {
    // The specific failure: the primary was absent from the table entirely, so a
    // reader had no way to learn which model the action actually uses.
    const primary = DEFAULT_MODELS.filter((m) => m.enabled).sort((a, b) => a.priority - b.priority)[0]!;
    expect(primary.id).toBe("inclusionai/ling-3.0-flash-sante:free");
    expect(README, "README omits the shipping primary").toContain(primary.id);
  });

  it("lists every catalog model", () => {
    for (const model of DEFAULT_MODELS) {
      expect(README, `README omits ${model.id}`).toContain(model.id);
    }
  });

  it("does not present a disabled model as usable", () => {
    for (const model of DEFAULT_MODELS.filter((m) => !m.enabled)) {
      // Each disabled model has a recorded reason that must be stated, so a
      // reader who finds one does not assume it was forgotten.
      expect(README, `README omits why ${model.id} is disabled`).toContain(model.id);
    }
    expect(README).toMatch(/Models excluded on measured evidence/i);
  });

  it("does not advertise structured output a model cannot actually serve", () => {
    // The production bug: qwen advertises `structured_outputs` and 404s on it.
    const qwen = byId("qwen/qwen3.8-27b:free")!;
    expect(qwen.supportsJsonSchema).toBe(false);
    expect(flat(README)).toMatch(/advertises .{0,80}404/i);
  });

  it("states that capability mode is chosen by measurement", () => {
    // Without this, a reader would reasonably assume the strongest advertised
    // capability is used, which is the rule that shipped recall 0.47.
    expect(flat(README)).toMatch(/preferredMode/);
    expect(README).toMatch(/eligib/i);
  });

  it("discloses that the primary is the only injection-resistant model", () => {
    expect(flat(README)).toMatch(/only model that has never followed instructions/i);
    expect(README).toMatch(/disclose/i);
  });

  it("does not overstate the injection guarantee", () => {
    // It is a real limitation, and saying otherwise would be the exact failure
    // mode this project exists to prevent.
    expect(README).toMatch(/limitation, not a solved problem/i);
  });
});

describe("the execution plan does not promise things that do not exist", () => {
  it("does not reference eval/thresholds.json as a deliverable", () => {
    // §12 promised a gate file that was never written. It now explains why it was
    // withheld rather than quietly dropping the mention.
    expect(PLAN).not.toMatch(/`eval\/thresholds\.json` — the v1 promotion gate/);
    // Both the section and the repository-layout tree used to claim it.
    expect(PLAN).toMatch(/`eval\/thresholds\.json` does not exist/i);
    expect(PLAN).not.toMatch(/eval\/\{run,score\}\.ts · eval\/thresholds\.json/);
    expect(PLAN).toMatch(/Not built, deliberately/i);
  });

  it("does not promise Stage B of a size it does not have", () => {
    expect(PLAN).not.toMatch(/Stage B \(18\)/);
  });

  it("marks the superseded shortlist as superseded rather than deleting it", () => {
    // The premise it encodes was wrong, and knowing that it was wrong is the
    // useful part of the record.
    expect(PLAN).toMatch(/superseded by 7b and 7c/i);
  });

  it("records Phase 7 as outstanding rather than complete", () => {
    expect(PLAN).toMatch(/prompt iteration outstanding/i);
  });

  it("does not claim anchor acceptance is a gate", () => {
    // Anchor *correctness* is the hard gate. Acceptance measures where a correct
    // finding was placed, which is not a defect — and conflating the two is how a
    // defensible placement becomes a scored miss.
    expect(PLAN).toMatch(/not a gate|which is why it is not a gate/i);
  });

  it("states why severity is not scored", () => {
    expect(flat(PLAN)).toMatch(/severity accuracy.{0,40}not measured/i);
  });
});

describe("the evaluation record is not stale", () => {
  it("reports the Stage B one-shot score", () => {
    expect(EVAL).toMatch(/Stage B — the one-shot score/);
  });

  it("states that all held-out data is spent", () => {
    // The single most consequential fact about future measurement. It must not be
    // buried, because a future contributor would otherwise plan against data that
    // does not exist.
    expect(EVAL).toMatch(/no uncontaminated held-out data/i);
  });

  it("records the measured variance so noise is not read as signal", () => {
    expect(EVAL).toMatch(/±0\.13|0\.13 to ±0\.26|Wilson/);
  });
});

describe("SECURITY.md claims are true", () => {
  it("may claim verified privacy posture, because the dates are populated", () => {
    // §8a was written when privacyVerifiedOn was set on zero models, which made
    // this claim false. It became true when the dates were filled in.
    const claimingVerification = /manually verified privacy posture[\s\S]{0,120}verification date recorded/.test(
      SECURITY,
    );
    if (claimingVerification) {
      for (const model of DEFAULT_MODELS.filter((m) => m.privacyEligible)) {
        expect(model.privacyVerifiedOn, `${model.id} is privacy-eligible but undated`).toBeDefined();
      }
    }
    expect(claimingVerification).toBe(true);
  });

  it("dates every model whose privacy posture we assert", () => {
    for (const model of DEFAULT_MODELS.filter((m) => m.privacyEligible)) {
      expect(model.privacyVerifiedOn, `${model.id} is privacy-eligible but undated`).toBeDefined();
    }
  });

  it("excludes the models whose providers train or log, and says why", () => {
    // These two are the exception that proves the rule: no date because the
    // posture is unacceptable, which is why they are excluded.
    for (const id of ["poolside/laguna-s-2.1:free", "thinkingmachines/inkling-small:free"]) {
      const model = byId(id)!;
      expect(model.privacyEligible).toBe(false);
      expect(model.enabled).toBe(false);
    }
  });
});