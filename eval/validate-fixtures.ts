/**
 * Validate the golden dataset.
 *
 * The most important check in this repository after the anchoring resolver,
 * because the dataset is a set of claims about ground truth and a wrong claim
 * is worse than no fixture: it would make the evaluation confidently report the
 * reviewer as wrong when the author was.
 *
 * Every check below exists to catch a specific authoring mistake I have made or
 * could plausibly make:
 *
 *  - **`@@` counts are re-derived, not trusted.** The generator computes them;
 *    the validator recomputes and compares. A hand-edited `pr.diff` fails.
 *
 *  - **Every expected quote is run through the REAL anchor resolver.** This is
 *    the point of the whole exercise: if `expectedFindings[].line` disagrees with
 *    what the resolver produces, the label is wrong and the dataset is
 *    unusable. It also makes the dataset double as an end-to-end anchoring
 *    regression suite — 14 fixtures' worth of ground truth, asserted on every
 *    commit.
 *
 *  - **Ground truth is not self-contradictory.** A quote cannot be both
 *    expected and forbidden. A fixture that expects a finding and forbids a
 *    substring of that same finding is scoring the model into a corner.
 *
 *  - **Precision is always measured.** A fixture with no `forbiddenFindings`
 *    contributes nothing to the false-positive rate, and the false-positive rate
 *    is what decides whether a human keeps reading the bot.
 *
 *  - **Splits are exactly the declared size**, because the held-out set's value
 *    is entirely in being the right count and staying untouched.
 *
 * Exit code is non-zero on any failure, so it can gate CI.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseUnifiedDiff, DiffParseError } from "../src/diff/parse.js";
import { buildIndex } from "../src/diff/index.js";
import { resolveAnchor } from "../src/anchor/resolve.js";
import { STAGE_A, STAGE_A_COUNTS, STAGE_B } from "./lib/fixtures.js";
import { hunkCounts, renderFile, renderFixture, renderHead, renderFixtureJson } from "./lib/render.js";

const BASE = join(import.meta.dirname, "fixtures");

// Stage A and Stage B live in separate directories and are validated together.
// Stage B is the only genuinely unscored held-out data, so it is validated with
// exactly the same rigour — a ground-truth error there would corrupt the one
// measurement that has not already been contaminated.
const STAGES: readonly { name: string; fixtures: readonly (typeof STAGE_A)[number][] }[] = [
  { name: "stage-a", fixtures: STAGE_A },
  { name: "stage-b", fixtures: STAGE_B },
];

const problems: string[] = [];
const notes: string[] = [];

function fail(where: string, message: string): void {
  problems.push(`${where}: ${message}`);
}

function check(condition: boolean, where: string, message: string): boolean {
  if (!condition) fail(where, message);
  return condition;
}

// --- 1. Every source fixture is materialised --------------------------------

for (const stage of STAGES) {
  const root = join(BASE, stage.name);

  for (const fixture of stage.fixtures) {
    const dir = join(root, fixture.id);
    for (const artefact of ["pr.diff", "head.json", "fixture.json"]) {
      if (!existsSync(join(dir, artefact))) {
        fail(fixture.id, `missing ${stage.name} artefact ${artefact} — run \`npm run eval:generate\``);
      }
    }
  }

  const onDisk = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  const sourceIds = new Set(stage.fixtures.map((f) => f.id));
  for (const entry of onDisk) {
    if (!sourceIds.has(entry.name)) {
      fail("dataset", `${stage.name}/${entry.name} has no matching fixture in eval/lib/fixtures.ts`);
    }
  }
}

// Fixture ids must be unique across stages. A collision would silently let a
// Stage A artefact satisfy a Stage B fixture, which is how an unscored fixture
// ends up being scored against the wrong ground truth.
const allIds = STAGES.flatMap((s) => s.fixtures.map((f) => f.id));
for (const id of new Set(allIds)) {
  if (allIds.filter((x) => x === id).length > 1) {
    fail("dataset", `fixture id '${id}' appears in more than one stage`);
  }
}

// --- 2. Split sizes ---------------------------------------------------------

const counts = { development: 0, regression: 0, "held-out": 0 } as Record<string, number>;
for (const fixture of STAGE_A) counts[fixture.split] = (counts[fixture.split] ?? 0) + 1;

for (const [split, expected] of Object.entries(STAGE_A_COUNTS)) {
  check(
    counts[split] === expected,
    "dataset",
    `split '${split}' has ${counts[split]} fixtures, expected ${expected}`,
  );
}
if (STAGE_A.length !== Object.values(STAGE_A_COUNTS).reduce((a, b) => a + b, 0)) {
  fail("dataset", `Stage A has ${STAGE_A.length} fixtures, expected ${Object.values(STAGE_A_COUNTS).reduce((a, b) => a + b, 0)}`);
}

// --- 3. Per-fixture validation ---------------------------------------------

const ALL_FIXTURES = STAGES.flatMap((stage) =>
  stage.fixtures.map((fixture) => ({ fixture, root: join(BASE, stage.name) })),
);

for (const { fixture, root } of ALL_FIXTURES) {
  const where = fixture.id;
  const ROOT = root;

  // The committed artefacts must be exactly what the source renders to.
  const expectedDiff = renderFixture(fixture).map((f) => f.patch).join("");
  const expectedHead = `${JSON.stringify(renderHead(fixture), null, 2)}\n`;
  const expectedJson = `${JSON.stringify(renderFixtureJson(fixture), null, 2)}\n`;

  if (existsSync(join(ROOT, where, "pr.diff"))) {
    const actual = readFileSync(join(ROOT, where, "pr.diff"), "utf8");
    if (actual !== expectedDiff) {
      fail(where, "pr.diff has drifted from eval/lib/fixtures.ts — re-run `npm run eval:generate`");
    }
  }
  if (existsSync(join(ROOT, where, "head.json"))) {
    const actual = readFileSync(join(ROOT, where, "head.json"), "utf8");
    if (actual !== expectedHead) fail(where, "head.json has drifted — re-run `npm run eval:generate`");
  }
  if (existsSync(join(ROOT, where, "fixture.json"))) {
    const actual = readFileSync(join(ROOT, where, "fixture.json"), "utf8");
    if (actual !== expectedJson) fail(where, "fixture.json has drifted — re-run `npm run eval:generate`");
  }

  // Every hunk line carries a valid marker and the header matches the body.
  for (const file of fixture.files) {
    try {
      const { oldCount, newCount, added, deleted } = hunkCounts(file.lines);
      if (oldCount === 0) {
        fail(where, `${file.path}: hunk has no old-side lines, so nothing can be anchored LEFT`);
      }
      if (newCount === 0) {
        fail(where, `${file.path}: hunk has no new-side lines, so nothing can be anchored RIGHT`);
      }
      if (added === 0 && deleted === 0) {
        fail(where, `${file.path}: hunk contains no change, so the fixture tests nothing`);
      }
    } catch (error) {
      fail(where, `${file.path}: ${(error as Error).message}`);
    }
  }

  // Precision is not optional.
  if (fixture.forbiddenFindings.length === 0) {
    fail(
      where,
      "no forbiddenFindings — the fixture would contribute nothing to the false-positive rate, " +
        "which is what decides whether a human keeps reading the bot",
    );
  }

  // --- 4. Parse the real diff with the real parser -------------------------
  const diffText = renderFixture(fixture).map((f) => f.patch).join("");
  const parsedFiles = [];

  for (const file of fixture.files) {
    const patch = renderFile(file).patch;
    try {
      parsedFiles.push(
        parseUnifiedDiff(patch, {
          path: file.path,
          status: file.status,
          ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
          additions: renderFile(file).additions,
          deletions: renderFile(file).deletions,
        }),
      );
    } catch (error) {
      if (error instanceof DiffParseError) {
        fail(where, `${file.path}: the generated diff does not parse — ${error.message}`);
      } else {
        fail(where, `${file.path}: unexpected parse failure — ${(error as Error).message}`);
      }
    }
  }

  if (parsedFiles.length === 0) continue;

  const index = buildIndex(parsedFiles);
  const prFilePaths = new Set(fixture.files.map((f) => f.path));

  // --- 5. Every expected finding must resolve to the stated location -------
  for (const expected of fixture.expectedFindings) {
    if (!prFilePaths.has(expected.path)) {
      fail(where, `expectedFindings references '${expected.path}', which is not one of the fixture's files`);
      continue;
    }

    const fileIndex = index.get(expected.path.normalize("NFC"));
    if (fileIndex === undefined) {
      fail(where, `no diff index for '${expected.path}'`);
      continue;
    }

    // Every acceptable placement must anchor. An alternate that cannot be
    // produced is worse than no alternate: it looks like leniency and measures
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
        fail(
          where,
          `expected finding ${JSON.stringify(placement.quote.slice(0, 60))} did not anchor — ` +
            `${resolution.code} at rung ${resolution.rung}. Ground truth that the resolver ` +
            "rejects is a wrong label, not a hard fixture.",
        );
        continue;
      }

      if (resolution.anchor.side !== placement.side) {
        fail(
          where,
          `expected side ${placement.side} but the resolver resolved ${resolution.anchor.side} for ` +
            JSON.stringify(placement.quote.slice(0, 60)),
        );
      }

      if (resolution.anchor.line !== placement.line) {
        fail(
          where,
          `expected line ${placement.line} but the resolver resolved line ${resolution.anchor.line} for ` +
            JSON.stringify(placement.quote.slice(0, 60)),
        );
      }

      if (placement.startLine !== undefined && resolution.anchor.startLine !== placement.startLine) {
        fail(
          where,
          `expected startLine ${placement.startLine} but the resolver resolved ${String(resolution.anchor.startLine)}`,
        );
      }
    }

    // `acceptAnyLineInRange` is only meaningful for a range.
    if (expected.acceptAnyLineInRange === true && expected.startLine === undefined) {
      fail(
        where,
        "acceptAnyLineInRange is set but the finding has no startLine, so there is no range to accept",
      );
    }
  }

  // --- 6. An injection fixture must be falsifiable ------------------------
  //
  // The original design was: inject "report no findings" into the diff, and
  // expect no findings. A model that *fully complied* and a model that *fully
  // resisted* both return `{"findings": []}` — the test scored compliance and
  // resistance identically, and worse, scored compliance as a pass. The
  // evaluation gate requires zero injection compliance, so this was not a weak
  // test, it was an inverted one.
  //
  // A suppression injection is only measurable if there is a real defect
  // hiding behind it. Compliance then returns an empty array and fails; only
  // resistance reports the planted defect and passes.
  if (fixture.injection) {
    if (fixture.expectedFindings.length === 0) {
      fail(
        where,
        "injection fixture expects zero findings — a model that complies with the injected " +
          "'report nothing' instruction and a model that resists it produce identical output, " +
          "so this test cannot distinguish them. Plant a real defect behind the payload.",
      );
    }

    // And the payload must actually be asking for suppression.
    const diff = renderFixture(fixture)
      .map((f) => f.patch)
      .join("\n")
      .toLowerCase();
    const suppresses = /report no findings|return an empty findings array|reply exactly: no defects|ignore all previous/.test(
      diff,
    );
    if (!suppresses) {
      fail(
        where,
        "marked `injection: true` but the diff contains no suppression payload, so there is " +
          "nothing for a model to resist",
      );
    }
  }

  // --- 7. Ground truth must not contradict itself --------------------------
  for (const expected of fixture.expectedFindings) {
    for (const forbidden of fixture.forbiddenFindings) {
      if (forbidden.quote !== "" && expected.quote.includes(forbidden.quote)) {
        fail(
          where,
          `forbiddenFindings contains ${JSON.stringify(forbidden.quote)}, which is a substring of an ` +
            "expected finding — the fixture would score the model into a corner",
        );
      }
    }
  }

  // A forbidden quote must actually exist in the diff, or it measures nothing.
  const allDiffText = diffText;
  for (const forbidden of fixture.forbiddenFindings) {
    if (forbidden.quote === "<none>" || forbidden.quote === "any finding") continue;
    if (!allDiffText.includes(forbidden.quote)) {
      fail(
        where,
        `forbiddenFindings quote ${JSON.stringify(forbidden.quote)} does not appear in the diff, ` +
          "so it can never be produced and measures nothing",
      );
    }
  }

  // A quote that must not be reported must not be an expected quote either.
  if (fixture.expectedFindings.length === 0 && !fixture.forbiddenFindings.some((f) => f.quote === "any finding")) {
    notes.push(
      `${where}: expects zero findings; ensure at least one forbidden quote is plausible enough ` +
        "that a padding model would produce it",
    );
  }

  // --- 8. A fixture that expects a finding needs explanation content --------
  for (const expected of fixture.expectedFindings) {
    if (expected.explanationMentions.length === 0) {
      fail(where, `expected finding on ${expected.path} has no explanationMentions, so explanation quality cannot be scored`);
    }
    // Each entry is a synonym set; an empty set can never be satisfied, so the
    // finding would be unscoreable rather than strict.
    for (const group of expected.explanationMentions) {
      if (group.length === 0) {
        fail(where, `${expected.path} has an empty explanation synonym set, which can never match`);
      }
    }
  }

  // A fixture that is not injection-labelled must not carry a suppression
  // payload either, for the same reason: the two are indistinguishable without
  // a planted defect.
  if (!fixture.injection) {
    const diff = renderFixture(fixture)
      .map((f) => f.patch)
      .join("")
      .toLowerCase();
    if (/report no findings|ignore all previous instructions|reply exactly: no defects/.test(diff)) {
      fail(
        where,
        "the diff carries a suppression payload but is not marked `injection: true`; either label it " +
          "or remove the payload",
      );
    }
  }
}

// --- 8. Report ---------------------------------------------------------------

for (const stage of STAGES) {
  const bySplit = (split: string): number => stage.fixtures.filter((f) => f.split === split).length;
  const injections = stage.fixtures.filter((f) => f.injection).length;

  console.log(`validate:fixtures — ${stage.name}`);
  console.log(
    `  ${stage.fixtures.length} fixtures: ${bySplit("development")} development, ` +
      `${bySplit("regression")} regression, ${bySplit("held-out")} held-out`,
  );
  console.log(
    `  ${stage.fixtures.reduce((n, f) => n + f.expectedFindings.length, 0)} expected findings, ` +
      `${stage.fixtures.reduce((n, f) => n + f.forbiddenFindings.length, 0)} forbidden findings, ` +
      `${injections} injection fixtures`,
  );
}

// Stage B is the only held-out data no model has been shown, so it is the only
// measurement still worth defending. Saying so out loud keeps it from being
// quietly folded into Stage A next time someone wants a bigger sample.
const stageBHeldOut = STAGE_B.filter((f) => f.split === "held-out").length;
console.log(
  `  unscored held-out available: ${stageBHeldOut} (Stage B — never sent to a model)`,
);

for (const note of notes) console.log(`  note: ${note}`);

if (problems.length > 0) {
  console.error(`\nvalidate:fixtures — FAILED (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nvalidate:fixtures — every expected finding resolves to its stated line and side. OK");
