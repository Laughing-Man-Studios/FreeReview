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
import { STAGE_A, STAGE_B } from "./lib/fixtures.js";
import { renderFixture, renderFixtureJson, renderHead } from "./lib/render.js";

const BASE = join(import.meta.dirname, "fixtures");

// Each stage gets its own directory. Stage B is deliberately not merged into
// Stage A: every Stage A held-out fixture has been shown to model output, so a
// combined directory would put scored fixtures next to unscored ones and make it
// easy to accidentally train on the latter.
const STAGES: readonly { name: string; fixtures: readonly typeof STAGE_A[number][] }[] = [
  { name: "stage-a", fixtures: STAGE_A },
  { name: "stage-b", fixtures: STAGE_B },
];

let written = 0;

for (const stage of STAGES) {
  const root = join(BASE, stage.name);

  for (const fixture of stage.fixtures) {
    const dir = join(root, fixture.id);
    mkdirSync(dir, { recursive: true });

    // One file per fixture, concatenated, so the whole PR is a single artefact —
    // which is also what a multi-file chunk must be able to pack.
    writeFileSync(join(dir, "pr.diff"), renderFixture(fixture).map((f) => f.patch).join(""), "utf8");
    writeFileSync(join(dir, "head.json"), `${JSON.stringify(renderHead(fixture), null, 2)}\n`, "utf8");
    writeFileSync(join(dir, "fixture.json"), `${JSON.stringify(renderFixtureJson(fixture), null, 2)}\n`, "utf8");

    written += 1;
    const expectations = fixture.expectedFindings.length;
    console.log(
      `  ${stage.name}  ${fixture.id.padEnd(38)} ${fixture.split.padEnd(12)} ` +
        `files=${fixture.files.length} expected=${expectations} forbidden=${fixture.forbiddenFindings.length}`,
    );
  }
}

console.log(`\neval:generate — wrote ${written} fixtures under ${BASE}`);
