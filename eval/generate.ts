/**
 * Materialise the committed golden dataset from its source.
 *
 * Run with `npm run eval:generate`. The output is committed; `validate:fixtures`
 * re-derives it and fails on any disagreement, so a hand-edited artefact cannot
 * silently diverge from the module that produced it.
 *
 * This script writes files and therefore is NOT part of the test path. The
 * validator is.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_A } from "./lib/fixtures.js";
import { renderFixture, renderFixtureJson, renderHead } from "./lib/render.js";

const ROOT = join(import.meta.dirname, "fixtures", "stage-a");

let written = 0;

for (const fixture of STAGE_A) {
  const dir = join(ROOT, fixture.id);
  mkdirSync(dir, { recursive: true });

  // One file per fixture, concatenated, so the whole PR is a single artefact —
  // which is also what a multi-file chunk must be able to pack.
  writeFileSync(join(dir, "pr.diff"), renderFixture(fixture).map((f) => f.patch).join(""), "utf8");
  writeFileSync(join(dir, "head.json"), `${JSON.stringify(renderHead(fixture), null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "fixture.json"), `${JSON.stringify(renderFixtureJson(fixture), null, 2)}\n`, "utf8");

  written += 1;
  const expectations = fixture.expectedFindings.length;
  console.log(
    `  ${fixture.id.padEnd(38)} ${fixture.split.padEnd(12)} ` +
      `files=${fixture.files.length} expected=${expectations} forbidden=${fixture.forbiddenFindings.length}`,
  );
}

console.log(`\neval:generate — wrote ${written} fixtures to ${ROOT}`);
