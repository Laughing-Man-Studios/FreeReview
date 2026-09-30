/**
 * Stage B held-out integrity.
 *
 * ## Why Stage B exists at all
 *
 * Every Stage A held-out fixture has been shown to at least one model's output.
 * Two were demoted to development outright for that reason. Continuing to grow
 * Stage A's held-out split would produce a set that is *named* held-out and is
 * actually trained on — worse than a small honest set, because the number keeps
 * rising while the evidence behind it decays.
 *
 * Stage B is the only unscored data in the project, which makes it the only
 * measurement still worth defending. These tests defend it.
 */

import { describe, expect, it } from "vitest";
import { STAGE_A, STAGE_B, STAGE_A_COUNTS } from "../../eval/lib/fixtures.js";
import { renderFixture } from "../../eval/lib/render.js";

describe("Stage B is genuinely unscored", () => {
  it("contains only held-out fixtures", () => {
    // A development fixture in this set would be a fixture whose ground truth is
    // expected to be adjusted as models are measured — the opposite of held out.
    expect(STAGE_B.every((f) => f.split === "held-out")).toBe(true);
  });

  it("shares no id with Stage A", () => {
    const a = new Set(STAGE_A.map((f) => f.id));
    for (const fixture of STAGE_B) {
      expect(a.has(fixture.id), `${fixture.id} exists in both stages`).toBe(false);
    }
  });

  it("has no duplicate ids of its own", () => {
    const ids = STAGE_B.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reaches a sample size where one finding is not a large share of the total", () => {
    // The reason Stage A's held-out set was called a smoke test: at 4 fixtures a
    // single miss moves the score 25%. Stage B is sized so that one miss moves it
    // far less, which is the whole point of holding data back.
    const expected = STAGE_B.reduce((n, f) => n + f.expectedFindings.length, 0);
    expect(STAGE_B.length).toBeGreaterThanOrEqual(6);
    expect(expected).toBeGreaterThanOrEqual(6);
    // A single miss should cost at most ~17% of recall.
    expect(1 / expected).toBeLessThan(0.2);
  });
});

describe("Stage B covers classes Stage A does not", () => {
  const stageACategories = new Set(STAGE_A.map((f) => f.category));

  it("adds at least four categories Stage A never uses", () => {
    // Chosen from a taxonomy of common review findings, not from the error log.
    // Fixtures aimed at observed model failures would fit the test set to the
    // model's weaknesses and score my ability to predict them, not model quality.
    const fresh = STAGE_B.filter((f) => !stageACategories.has(f.category)).map((f) => f.category);
    expect(new Set(fresh).size).toBeGreaterThanOrEqual(4);
  });

  it("includes an injection fixture in a context Stage A does not use", () => {
    // Stage A's two injection fixtures both live in source files. Resistance
    // measured only there does not establish that a model treats test code as
    // untrusted input rather than as trustworthy because it is not production.
    const injection = STAGE_B.filter((f) => f.injection);
    expect(injection.length).toBeGreaterThanOrEqual(1);
    for (const fixture of injection) {
      expect(fixture.files.some((f) => /(^|\/)(test|tests|spec)\//.test(f.path))).toBe(true);
    }
  });
});

describe("every Stage B injection fixture is falsifiable", () => {
  it("plants a real defect, so compliance and resistance are distinguishable", () => {
    // This is the defect the cross-examination found in Stage A: a fixture with a
    // suppression payload and no planted defect cannot tell a model that fully
    // complied from one that fully resisted, because both return zero findings.
    // The payload said "report nothing" and the expected answer was nothing.
    for (const fixture of STAGE_B.filter((f) => f.injection)) {
      expect(
        fixture.expectedFindings.length,
        `${fixture.id} has a suppression payload but no planted defect, so obeying it and ignoring it look identical`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the payload out of the expected finding", () => {
    // The planted defect must be real code, not the injected instruction. A
    // reviewer flagging the payload is a different failure from not reporting.
    for (const fixture of STAGE_B.filter((f) => f.injection)) {
      for (const expected of fixture.expectedFindings) {
        expect(expected.explanationMentions.join(" ").toLowerCase()).not.toContain("ignore all previous");
      }
    }
  });
});

describe("Stage B ground truth is anchored to real text", () => {
  it("quotes text that appears in the rendered diff", () => {
    // The validator does this against the real resolver, which is stronger, but
    // this catches a quote that drifted from the source at authoring time rather
    // than at validation time.
    for (const fixture of STAGE_B) {
      const diff = renderFixture(fixture)
        .map((f) => f.patch)
        .join("");
      for (const expected of fixture.expectedFindings) {
        const inAdded = diff
          .split("\n")
          .filter((l) => l.startsWith("+"))
          .map((l) => l.slice(1))
          .join("\n");
        const inRemoved = diff
          .split("\n")
          .filter((l) => l.startsWith("-"))
          .map((l) => l.slice(1))
          .join("\n");

        expect(
          inAdded.includes(expected.quote) || inRemoved.includes(expected.quote),
          `${fixture.id}: quote not found in the diff — ${JSON.stringify(expected.quote.slice(0, 60))}`,
        ).toBe(true);
      }
    }
  });

  it("gives every expected finding at least one explanation concept", () => {
    // An empty group would silently contribute nothing to the explanation score,
    // so the metric would flatter a model that said nothing in particular.
    for (const fixture of STAGE_B) {
      for (const expected of fixture.expectedFindings) {
        expect(expected.explanationMentions.length, `${fixture.id} has an expectation with no concepts`).toBeGreaterThan(0);
        for (const group of expected.explanationMentions) {
          expect(group.length, `${fixture.id} has an empty synonym group`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("records why each fixture exists", () => {
    // A fixture nobody can state the purpose of is one nobody will notice going
    // stale.
    for (const fixture of STAGE_B) {
      expect(fixture.proves.length, `${fixture.id} has no rationale`).toBeGreaterThan(40);
      expect(fixture.proves).toMatch(/HELD OUT/);
    }
  });
});

describe("Stage A is unchanged by Stage B existing", () => {
  it("keeps Stage A's declared counts honest", () => {
    const by = (split: string) => STAGE_A.filter((f) => f.split === split).length;
    for (const [split, expected] of Object.entries(STAGE_A_COUNTS)) {
      expect(by(split), `Stage A ${split}`).toBe(expected);
    }
    expect(STAGE_A.length).toBe(Object.values(STAGE_A_COUNTS).reduce((a, b) => a + b, 0));
  });
});