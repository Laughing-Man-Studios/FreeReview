// check:changelog — verify CHANGELOG.md's compare links point at tags that exist.
//
// ## Why this is a script and not a unit test
//
// The unit test that guards these links compares strings: it checks that
// `[Unreleased]` names the newest version heading, prefixed `v`. That test
// passed for `1.0.2` while both links 404'd, because the release was tagged
// `1.0.2` without the `v`. Nothing in the file says which tags exist, so no
// assertion over the file's own contents can catch it — the question is not
// self-contained. This asks the remote instead, and reports plainly when it
// cannot.
//
// ## Degradation
//
// If the tag list cannot be obtained (no network, no remote, shallow CI
// checkout), this exits 0 and says so. A check that fails because it could not
// run is a check that gets muted, and a muted check protects nothing. The
// failure it exists to catch is a wrong link, not an absent network.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

function fail(message) {
  console.error(`check:changelog — ${message}`);
  process.exit(1);
}

let tags;
try {
  const out = execFileSync("git", ["ls-remote", "--tags", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  tags = new Set(
    out
      .split("\n")
      .map((line) => line.split("refs/tags/")[1]?.trim())
      .filter(Boolean)
      // Drop the `^{}` peeled refs for annotated tags; the bare name is the tag.
      .map((t) => t.replace(/\^\{\}$/, "")),
  );
} catch {
  console.log(
    "check:changelog — could not list remote tags (no network, or no remote " +
      "'origin'). Skipped; compare links are unverified.",
  );
  process.exit(0);
}

if (tags.size === 0) {
  console.log("check:changelog — remote reported no tags. Skipped; compare links are unverified.");
  process.exit(0);
}

// Every `...A...B` in a compare link names a tag that must exist. `HEAD` is a
// ref, not a tag, and is exempt.
const COMPARE = /\/compare\/([^.\s/]+(?:\.[^.\s/]+)*?)\.\.\.(HEAD|[^.\s/]+(?:\.[^.\s/]+)*)/g;
const problems = [];

for (const m of changelog.matchAll(COMPARE)) {
  for (const ref of [m[1], m[2]]) {
    if (ref === "HEAD") continue;
    if (!tags.has(ref)) {
      const line = changelog.slice(0, m.index).split("\n").length;
      problems.push(`line ${line}: compare link references '${ref}', which is not a tag on the remote`);
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`);
  fail(
    `${problems.length} compare link(s) point at tags that do not exist. If a release was ` +
      "tagged without the `v` prefix, write the link against the real tag rather than the " +
      "conventional one — and note the exception in the preamble so the next person is not misled.",
  );
}

console.log(`check:changelog — all compare links resolve against ${tags.size} remote tags. OK`);
