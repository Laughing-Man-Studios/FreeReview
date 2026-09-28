#!/usr/bin/env node
// Verifies that the committed dist/ artifact matches a fresh build of src/.
//
// The classic release bug for a committed-bundle action is "source fixed,
// dist stale" — the bundle GitHub actually executes does not contain the fix.
// This turns that into a build failure instead of a production surprise.
//
// This script is strictly READ-ONLY with respect to dist/. It builds into a
// scratch directory and compares. It never writes to dist/.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");

function fail(message, hint) {
  console.error(`check:dist — FAILED: ${message}`);
  if (hint) console.error(`check:dist — ${hint}`);
  process.exit(1);
}

function exists(path) {
  return Boolean(statSync(path, { throwIfNoEntry: false }));
}

if (!exists(dist)) {
  fail("dist/ is missing.", "Run `npm run build` and commit dist/.");
}

// Build into a scratch directory so the comparison is against a known-good
// artifact and dist/ is never the thing being written to.
const scratch = mkdtempSync(join(tmpdir(), "freereview-dist-"));
try {
  try {
    execFileSync("npx", ["tsup", "--out-dir", scratch], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, NODE_ENV: "production" },
    });
  } catch (error) {
    console.error("check:dist — the build itself failed:");
    console.error(error?.stdout?.toString() || error?.stderr?.toString() || error?.message);
    process.exit(1);
  }

  const builtFiles = readdirSync(scratch).sort();
  const committedFiles = readdirSync(dist).sort();

  const missing = builtFiles.filter((f) => !committedFiles.includes(f));
  const extra = committedFiles.filter((f) => !builtFiles.includes(f));

  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) console.error(`check:dist — absent from dist/: ${missing.join(", ")}`);
    if (extra.length > 0) console.error(`check:dist — in dist/ but not built: ${extra.join(", ")}`);
    fail("dist/ file set does not match a fresh build.", "Run `npm run build` and commit dist/.");
  }

  const stale = [];
  for (const file of builtFiles) {
    try {
      execFileSync("diff", ["-q", join(scratch, file), join(dist, file)], { stdio: "pipe" });
    } catch {
      stale.push(file);
    }
  }

  if (stale.length > 0) {
    console.error(`check:dist — differs from a fresh build: ${stale.join(", ")}`);
    for (const file of stale) {
      try {
        const out = execFileSync("diff", ["-u", join(dist, file), join(scratch, file)], {
          stdio: "pipe",
        }).toString();
        // Show the first lines of each difference, not the whole bundle.
        console.error(out.split("\n").slice(0, 40).join("\n"));
      } catch (error) {
        console.error(error?.stdout?.toString() ?? "");
      }
    }
    fail("dist/ is STALE — it does not reflect src/.", "Run `npm run build` and commit dist/.");
  }

  console.log(`check:dist — dist/ matches a fresh build (${builtFiles.length} files). OK`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
