/**
 * Re-score a stored evaluation run with the current scorer.
 *
 * Every finding a fixture produced lands in exactly one bucket of the stored
 * score — matched, falsePositives, duplicates, forbiddenViolations, unanchored —
 * so the raw set can be reconstructed and re-scored without spending a request.
 *
 * This exists to answer one question honestly: when the scorer changes, do the
 * recorded conclusions change with it? Recomputing an old run with a new scorer
 * is the only way to tell a scoring fix from a model change, and reading the old
 * number off the old artifact after changing the scorer would silently compare
 * two different metrics.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STAGE_A } from "./lib/fixtures.js";
import { aggregate, scoreFixture, type ModelFinding } from "./lib/score.js";

interface StoredRun {
  readonly modelId: string;
  readonly privacyMode: string;
  readonly scores: readonly {
    fixtureId: string;
    expectedCount: number;
    matched: readonly { expected: unknown; finding: ModelFinding; placement: string; explanationScore: number }[];
    missed: readonly unknown[];
    falsePositives: readonly ModelFinding[];
    forbiddenViolations: readonly { forbidden: unknown; finding: ModelFinding }[];
    duplicates: readonly ModelFinding[];
    unanchored: readonly ModelFinding[];
    explanationScore: number;
  }[];
}

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: rescore.ts <results-dir>");
  process.exit(1);
}

const file = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().at(-1);
if (file === undefined) {
  console.error(`no result json in ${dir}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as { runs: readonly StoredRun[] };
const injectionIds = new Set(STAGE_A.filter((f) => f.injection).map((f) => f.id));
const fixtures = new Map(STAGE_A.map((f) => [f.id, f]));

console.log(`re-scoring ${file} with the current scorer\n`);

for (const run of data.runs) {
  const scores = run.scores.map((stored) => {
    const fixture = fixtures.get(stored.fixtureId);
    if (fixture === undefined) throw new Error(`unknown fixture ${stored.fixtureId}`);

    // Reconstruct the exact set of findings the model produced.
    const findings: ModelFinding[] = [
      ...stored.matched.map((m) => m.finding),
      ...stored.falsePositives,
      ...stored.duplicates,
      ...stored.forbiddenViolations.map((v) => v.finding),
      ...stored.unanchored,
    ];

    return scoreFixture({
      fixtureId: stored.fixtureId,
      expected: fixture.expectedFindings,
      forbidden: fixture.forbiddenFindings,
      findings,
    });
  });

  const a = aggregate({ scores, injectionFixtureIds: injectionIds });

  console.log(
    `${run.modelId.padEnd(44)} recall=${a.recall.toFixed(2)} precision=${a.precision.toFixed(2)} ` +
      `fp=${a.falsePositives} dup=${a.duplicates} merged=${a.collapsedByDedupe} forbidden=${a.forbiddenViolations} ` +
      `injection=${a.injectionCompliance}/${a.injectionFixtures}`,
  );
}