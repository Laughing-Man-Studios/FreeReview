/**
 * Golden dataset structural tests.
 *
 * `npm run validate:fixtures` does the deep work — it runs every expected quote
 * through the real resolver and checks the line and side. This file covers the
 * properties that should fail fast inside the normal test suite, so a
 * contributor who never opens the eval scripts still cannot commit a malformed
 * dataset.
 *
 * The split between them is deliberate: the deep check is slow and belongs in
 * CI as a named step where a failure is legible; these are fast and belong in
 * `npm test` where a contributor will actually hit them.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_A, STAGE_A_COUNTS, carriesSuppressionPayload } from "../../eval/lib/fixtures.js";
import { hunkCounts, renderFile, renderFixture, renderHead } from "../../eval/lib/render.js";
import { parseUnifiedDiff, DiffParseError } from "../../src/diff/parse.js";
import { buildIndex } from "../../src/diff/index.js";
import { resolveAnchor } from "../../src/anchor/resolve.js";

const ROOT = join(import.meta.dirname, "..", "..", "eval", "fixtures", "stage-a");

describe("Stage A shape", () => {
  it("has exactly the declared fixture count and split", () => {
    expect(STAGE_A).toHaveLength(Object.values(STAGE_A_COUNTS).reduce((a, b) => a + b, 0));
    const by = (split: string) => STAGE_A.filter((f) => f.split === split);
    expect(by("development")).toHaveLength(STAGE_A_COUNTS.development);
    expect(by("regression")).toHaveLength(STAGE_A_COUNTS.regression);
    expect(by("held-out")).toHaveLength(STAGE_A_COUNTS["held-out"]);
  });

  it("has unique ids", () => {
    const ids = STAGE_A.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every mechanically distinct anchoring path", () => {
    // The plan requires Stage A to exercise every distinct path, not merely
    // fourteen examples. A fixture that silently stops covering one of these
    // would leave that path unproven while the suite stayed green.
    const ids = new Set(STAGE_A.map((f) => f.id));
    for (const required of [
      "off-by-one-loop-bound", // RIGHT, single line
      "left-side-deleted-auth-check", // LEFT
      "multi-line-async-await-drop", // RANGE
      "duplicate-quote-two-files", // path is load-bearing
      "injection-in-source-comment", // injection
      "injection-in-string-literal", // injection, string literal
      "formatting-only-no-finding", // precision
      "insufficient-evidence-no-finding", // precision, provably correct
      "renamed-file-with-hunks", // rename
      "lockfile-plus-small-source-change", // filter noise
    ]) {
      expect(ids.has(required), `Stage A must cover ${required}`).toBe(true);
    }
  });

  it("exercises both sides and a range", () => {
    const sides = new Set(STAGE_A.flatMap((f) => f.expectedFindings.map((e) => e.side)));
    expect(sides.has("LEFT")).toBe(true);
    expect(sides.has("RIGHT")).toBe(true);
    expect(STAGE_A.some((f) => f.expectedFindings.some((e) => e.startLine !== undefined))).toBe(true);
  });

  it("has at least two fixtures that expect zero findings", () => {
    // A dataset that only measures recall measures nothing. Precision is half
    // the question, and a model that always says "looks fine" scores perfectly
    // on recall alone.
    expect(STAGE_A.filter((f) => f.expectedFindings.length === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("declares forbiddenFindings on every fixture", () => {
    for (const fixture of STAGE_A) {
      expect(
        fixture.forbiddenFindings.length,
        `${fixture.id} needs a false-positive target or it contributes nothing to precision`,
      ).toBeGreaterThan(0);
    }
  });

  it("has committed artefacts for every fixture", () => {
    for (const fixture of STAGE_A) {
      for (const artefact of ["pr.diff", "head.json", "fixture.json"]) {
        expect(() => readFileSync(join(ROOT, fixture.id, artefact), "utf8"), `${fixture.id}/${artefact}`).not.toThrow();
      }
    }
  });

  it("keeps the committed artefacts in step with the source", () => {
    // Drift means someone hand-edited a committed diff, which is how a fixture
    // ends up testing something other than what the source describes.
    for (const fixture of STAGE_A) {
      const expected = renderFixture(fixture).map((f) => f.patch).join("");
      const actual = readFileSync(join(ROOT, fixture.id, "pr.diff"), "utf8");
      expect(actual, `${fixture.id}/pr.diff has drifted — run \`npm run eval:generate\``).toBe(expected);
    }
  });
});

describe("every generated diff parses with the real parser", () => {
  for (const fixture of STAGE_A) {
    it(`${fixture.id} parses`, () => {
      for (const file of fixture.files) {
        const rendered = renderFile(file);
        expect(() =>
          parseUnifiedDiff(rendered.patch, {
            path: file.path,
            status: file.status,
            ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
            additions: rendered.additions,
            deletions: rendered.deletions,
          }),
        ).not.toThrow(DiffParseError);
      }
    });
  }
});

describe("every hunk line carries a marker and the header matches", () => {
  for (const fixture of STAGE_A) {
    it(`${fixture.id} has consistent counts`, () => {
      for (const file of fixture.files) {
        const { oldCount, newCount, added, deleted } = hunkCounts(file.lines);
        // The relation the parser enforces: a hunk contains exactly as many
        // old-side and new-side lines as its header declares.
        expect(newCount).toBe(oldCount - deleted + added);
        expect(added + deleted).toBeGreaterThan(0);
      }
    });
  }
});

describe("every expected finding resolves to its stated location", () => {
  // This is the check that makes the dataset worth having: ground truth that
  // the resolver disagrees with is a wrong label, and a wrong label makes the
  // evaluation confidently report a correct reviewer as broken.
  for (const fixture of STAGE_A) {
    if (fixture.expectedFindings.length === 0) continue;

    it(`${fixture.id} anchors as labelled`, () => {
      const parsed = fixture.files.map((file) => {
        const rendered = renderFile(file);
        return parseUnifiedDiff(rendered.patch, {
          path: file.path,
          status: file.status,
          ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
        });
      });

      const index = buildIndex(parsed);
      const prFilePaths = new Set(fixture.files.map((f) => f.path));

      for (const expected of fixture.expectedFindings) {
        const fileIndex = index.get(expected.path);
        if (fileIndex === undefined) throw new Error(`no index for ${expected.path}`);

        // Every acceptable placement must anchor, not just the canonical one.
        // An alternate that cannot be produced looks like leniency and measures
        // nothing.
        const placements = [
          { quote: expected.quote, side: expected.side, line: expected.line, startLine: expected.startLine },
          ...(expected.alternates ?? []),
        ];

        for (const placement of placements) {
          const resolution = resolveAnchor({
            path: expected.path,
            quote: placement.quote,
            index: fileIndex,
            prFilePaths,
          });

          if (!resolution.ok) {
            throw new Error(
              `${fixture.id}: expected finding did not anchor — ${resolution.code} at rung ${resolution.rung}`,
            );
          }

          expect(resolution.anchor.side, `${fixture.id} side`).toBe(placement.side);
          expect(resolution.anchor.line, `${fixture.id} line`).toBe(placement.line);
          if (placement.startLine !== undefined) {
            expect(resolution.anchor.startLine, `${fixture.id} startLine`).toBe(placement.startLine);
          }
        }
      }
    });
  }
});

describe("an injection fixture must be falsifiable", () => {
  // The most consequential property in the dataset, and the one the original
  // design got backwards. A suppression payload plus an expectation of no
  // findings means a model that fully complies and a model that fully resists
  // return the same `{"findings": []}` — so the test scored compliance as a
  // pass. The evaluation gate requires zero injection compliance, so it was not
  // a weak test, it was an inverted one.

  for (const fixture of STAGE_A.filter((f) => f.injection)) {
    it(`${fixture.id} plants a defect behind the payload`, () => {
      expect(
        fixture.expectedFindings.length,
        `${fixture.id}: with no expected finding, compliance and resistance are indistinguishable`,
      ).toBeGreaterThan(0);
    });

    it(`${fixture.id} actually carries a suppression payload`, () => {
      const diff = renderFixture(fixture)
        .map((f) => f.patch)
        .join("");
      expect(
        carriesSuppressionPayload(diff),
        `${fixture.id} is marked injection but contains nothing to resist`,
      ).toBe(true);
    });
  }

  it("no unlabelled fixture carries a suppression payload", () => {
    // The reverse mistake would be a payload that silently makes a normal
    // fixture unscoreable.
    for (const fixture of STAGE_A.filter((f) => !f.injection)) {
      const diff = renderFixture(fixture)
        .map((f) => f.patch)
        .join("");
      expect(
        carriesSuppressionPayload(diff),
        `${fixture.id} carries a suppression payload but is not marked injection`,
      ).toBe(false);
    }
  });
});

describe("a finding may accept more than one correct placement", () => {
  it("allows alternates where a reviewer has two defensible choices", () => {
    // Cross-examination found two fixtures that scored a *valid* comment as a
    // miss: one forbade the crash site, the other expected the acquisition line
    // while a reviewer pointed at the exit that skips the close.
    const withAlternates = STAGE_A.filter((f) =>
      f.expectedFindings.some((e) => (e.alternates?.length ?? 0) > 0),
    );
    expect(withAlternates.length).toBeGreaterThanOrEqual(2);
  });

  it("only sets acceptAnyLineInRange on a finding that has a range", () => {
    // The flag is meaningless without a startLine, and would silently widen the
    // match to a whole file.
    for (const fixture of STAGE_A) {
      for (const expected of fixture.expectedFindings) {
        if (expected.acceptAnyLineInRange === true) {
          expect(
            expected.startLine,
            `${fixture.id}: acceptAnyLineInRange with no startLine accepts an unbounded range`,
          ).toBeDefined();
        }
      }
    }
  });
});

describe("explanationMentions are synonym groups, not flat keywords", () => {
  it("never uses a flat string array", () => {
    // Flat matching was both too strict ("omits the final element" failed a
    // check for "last element") and too loose (a hallucination stuffed with
    // buzzwords passed). Every entry is now a synonym set.
    for (const fixture of STAGE_A) {
      for (const expected of fixture.expectedFindings) {
        for (const group of expected.explanationMentions) {
          expect(
            Array.isArray(group),
            `${fixture.id}/${expected.path}: explanationMentions entries must be synonym arrays`,
          ).toBe(true);
          expect(group.length, `${fixture.id}: an empty synonym set can never match`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("gives every expected finding at least two semantic groups", () => {
    // One group is a single keyword check, which is the thing being fixed.
    for (const fixture of STAGE_A) {
      for (const expected of fixture.expectedFindings) {
        expect(
          expected.explanationMentions.length,
          `${fixture.id}/${expected.path}: needs multiple groups to score a concept rather than a word`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("every accepted severity is defensible under the stated rubric", () => {
  it("uses only the three declared severities", () => {
    for (const fixture of STAGE_A) {
      for (const expected of fixture.expectedFindings) {
        expect(["critical", "warning", "info"]).toContain(expected.severity);
      }
    }
  });

  it("does not mark a defect that the diff did not introduce", () => {
    // The rule the first resource-leak fixture broke: a defect present
    // identically on both sides is not a reviewable finding, because the
    // reviewer is asked to comment on changed code.
    for (const fixture of STAGE_A) {
      const addedLines = fixture.files
        .flatMap((f) => f.lines)
        .filter((l) => l.startsWith("+"))
        .map((l) => l.slice(1).trim());
      const removedLines = fixture.files
        .flatMap((f) => f.lines)
        .filter((l) => l.startsWith("-"))
        .map((l) => l.slice(1).trim());

      // A multi-line quote spans several diff lines, so every line of it has to
      // be on the expected side rather than the whole quote matching one line.
      const everyLineOn = (quote: string, pool: readonly string[]): boolean =>
        quote
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .every((l) => pool.some((p) => p.includes(l)));

      for (const expected of fixture.expectedFindings) {
        // A LEFT-side finding is expected to point at removed code; a RIGHT one
        // at added code. Anything else describes a line the diff never touched,
        // which the resolver would reject as ANCHOR_CONTEXT_ONLY anyway — but
        // catching it here names the authoring mistake rather than the symptom.
        if (expected.side === "RIGHT") {
          expect(
            everyLineOn(expected.quote, addedLines),
            `${fixture.id}: RIGHT finding does not quote added lines`,
          ).toBe(true);
        } else {
          expect(
            everyLineOn(expected.quote, removedLines),
            `${fixture.id}: LEFT finding does not quote removed lines`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("ground truth is not self-contradictory", () => {
  it("never forbids a substring of an expected finding", () => {
    // A fixture that expects a finding and forbids part of the same quote
    // scores the model into a corner: reporting it correctly is a failure.
    for (const fixture of STAGE_A) {
      for (const expected of fixture.expectedFindings) {
        for (const forbidden of fixture.forbiddenFindings) {
          if (forbidden.quote.length === 0) continue;
          expect(
            expected.quote.includes(forbidden.quote),
            `${fixture.id}: forbidden ${JSON.stringify(forbidden.quote)} is inside expected ${JSON.stringify(expected.quote)}`,
          ).toBe(false);
        }
      }
    }
  });

  it("only forbids quotes that actually appear in the diff", () => {
    // A forbidden quote that cannot occur measures nothing and inflates the
    // appearance of precision.
    for (const fixture of STAGE_A) {
      const diff = renderFixture(fixture).map((f) => f.patch).join("");
      for (const forbidden of fixture.forbiddenFindings) {
        if (forbidden.quote === "<none>" || forbidden.quote === "any finding") continue;
        expect(
          diff.includes(forbidden.quote),
          `${fixture.id}: forbidden quote ${JSON.stringify(forbidden.quote)} never appears in the diff`,
        ).toBe(true);
      }
    }
  });

  it("gives every expected finding something to score the explanation against", () => {
    for (const fixture of STAGE_A) {
      for (const expected of fixture.expectedFindings) {
        expect(
          expected.explanationMentions.length,
          `${fixture.id}: ${expected.path} has no explanationMentions`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("requires every forbidden finding to say why", () => {
    // A forbidden finding without a reason cannot be adjudicated later, when
    // the model produces something adjacent to it and the two need telling
    // apart.
    for (const fixture of STAGE_A) {
      for (const forbidden of fixture.forbiddenFindings) {
        expect(forbidden.reason.length, `${fixture.id}: a forbidden finding has no reason`).toBeGreaterThan(10);
      }
    }
  });
});

describe("head.json mirrors the GitHub files API", () => {
  for (const fixture of STAGE_A) {
    it(`${fixture.id} reports counts derived from the patch`, () => {
      const head = renderHead(fixture) as { additions: number; deletions: number; patch: string }[];
      for (const entry of head) {
        const added = entry.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const deleted = entry.patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        // GitHub's own counts are used only to detect truncation, so they must
        // agree with the patch or the fixture would look truncated for no
        // reason.
        expect(entry.additions, `${fixture.id} additions`).toBe(added);
        expect(entry.deletions, `${fixture.id} deletions`).toBe(deleted);
      }
    });
  }
});
