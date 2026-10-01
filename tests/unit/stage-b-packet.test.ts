/**
 * The Stage B review packet must quote the fixtures that will actually be scored.
 *
 * The packet is copied into another harness by hand, so it is a copy of the
 * ground truth rather than the ground truth itself. A copy drifts: I first
 * transcribed all six diffs by hand into the document and four of the six no
 * longer matched the committed artefacts — different hunk headers, trimmed
 * context, an edited line. A reviewer examining a diff that is not the one the
 * harness will send is examining a fiction, and would report on a fixture that
 * does not exist.
 *
 * The Stage A version of this document had the same hazard and no check for it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_B } from "../../eval/lib/fixtures.js";

const PACKET = join(import.meta.dirname, "..", "..", "docs", "second-opinion-stage-b-review.md");
const text = readFileSync(PACKET, "utf8");

/** Strip the `index` line, which is git plumbing and not worth quoting. */
function normalise(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .join("\n")
    .trim();
}

describe("the Stage B packet quotes the fixtures verbatim", () => {
  const blocks = [...text.matchAll(/```diff\n(.*?)```/gs)].map((m) => normalise(m[1] ?? ""));

  it("includes exactly one diff block per Stage B fixture", () => {
    expect(blocks).toHaveLength(STAGE_B.length);
  });

  it("byte-matches every committed pr.diff", () => {
    const committed = STAGE_B.map((fixture) =>
      normalise(readFileSync(join("eval", "fixtures", "stage-b", fixture.id, "pr.diff"), "utf8")),
    );

    for (const fixture of STAGE_B) {
      const expected = committed.find((c) => c.includes(`a/${fixture.files[0]!.path}`));
      expect(expected, `${fixture.id} has no committed pr.diff`).toBeDefined();
      expect(
        blocks.some((b) => b === expected),
        `${fixture.id}: the packet's diff does not byte-match eval/fixtures/stage-b/${fixture.id}/pr.diff`,
      ).toBe(true);
    }
  });

  it("names every fixture in the document", () => {
    for (const fixture of STAGE_B) {
      expect(text, `${fixture.id} is never mentioned in the packet`).toContain(fixture.id);
    }
  });
});

describe("the packet states its own preconditions", () => {
  it("tells the reviewer to run the mechanical validation first", () => {
    // Otherwise effort is spent re-checking arithmetic that a test already proves.
    expect(text).toContain("npm run validate:fixtures");
    expect(text).toMatch(/machine-verified/i);
    expect(text).toMatch(/do not check arithmetic/i);
  });

  it("asks for disagreement rather than agreement", () => {
    // A review concluding everything is correct is indistinguishable from a lazy
    // one. Stage A's yielded 8 of 14 flawed, which is the expected rate.
    expect(text).toMatch(/not to confirm that I am right/i);
    expect(text).toMatch(/useless outcome/i);
  });

  it("states the consequence of a held-out disagreement", () => {
    // The rule that produced the Stage A demotions. Without it stated up front,
    // a disagreement on held-out data invites arguing rather than demoting.
    expect(text).toMatch(/contaminated/i);
  });

  it("permits deleting a fixture rather than only fixing it", () => {
    expect(text).toMatch(/DELETED rather than fixed/i);
  });

  it("records the expected yield from the Stage A review", () => {
    // Calibrates the reviewer. Without it, "all six look fine" reads as success
    // rather than as the less likely outcome it is.
    expect(text).toMatch(/8 of 14/);
  });
});

describe("the packet flags the calls most likely to be wrong", () => {
  // Each of these is a genuine doubt, not a rhetorical one. A review that only
  // attacks what the author is already confident about is not a review.
  it("asks whether prototype-pollution-merge is actually caused by the diff", () => {
    expect(text).toContain("prototype-pollution-merge");
    // Markdown emphasis sits mid-phrase, so the assertion tolerates it rather
    // than pinning prose that is allowed to be reworded.
    expect(text.replace(/\*/g, "")).toMatch(/preserves an existing bug rather than\s+creating one/i);
  });

  it("asks whether the swallowed error is too aggressive a warning", () => {
    expect(text).toMatch(/the fixture most likely to be\s*\n?\s*UNFAIR/i);
  });

  it("asks whether a defect in a test file is a legitimate finding", () => {
    expect(text).toMatch(/entitled to skip test files entirely/i);
  });

  it("asks whether falsy-zero is a defect or a design choice", () => {
    expect(text).toMatch(/real defect or a design choice/i);
  });

  it("asks whether the insecure-randomness fixture is too easy to earn a place", () => {
    expect(text).toMatch(/too easy/i);
  });

  it("asks whether the injection fixture's premise is fair", () => {
    expect(text).toMatch(/only Stage B injection fixture/i);
    expect(text).toMatch(/falsifiable/i);
  });
});