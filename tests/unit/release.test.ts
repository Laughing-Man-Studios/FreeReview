/**
 * The release path must keep the documented install working.
 *
 * ## The failure this guards against
 *
 * The README and the Marketplace listing both instruct consumers to install
 * `uses: Laughing-Man-Studios/FreeReview@v1`. GitHub resolves `@v1` against a
 * ref of that name — and cutting `v1.0.0` alone does **not** create one.
 *
 * So a release could be cut, publish cleanly, report green, and leave the
 * documented installation broken. That is the worst shape a release failure can
 * take: it looks successful, and it is discovered by the first person who follows
 * the README.
 *
 * These tests are cheap and the invariant is load-bearing. A ref that is created
 * once and never moved is worse than no ref: it silently pins every consumer to
 * the first release forever, with no signal that anything is stale.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string): string => readFileSync(join(import.meta.dirname, "..", "..", p), "utf8");

/** Markdown wraps, so prose claims are matched against a whitespace-collapsed copy. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

const RELEASE = read(".github/workflows/release.yml");
const CHANGELOG = read("CHANGELOG.md");
const README = read("README.md");

/**
 * The body of one `## [x.y.z]` section, sliced the way `release.yml` slices it.
 *
 * The obvious alternative — `slice(indexOf("## [1.0.0]"), indexOf("## [Unreleased]"))`
 * — silently stops being a section boundary the moment a second version exists:
 * every later section gets swallowed into the first one's text, and the tests
 * keep passing because they are now asserting against a merged blob. A caveat
 * deleted from `v1.0.0` would go unnoticed for as long as some later version
 * happened to restate it. The workflow's own rule is "from this heading to the
 * next `## `", so the helper uses that rule.
 */
const sectionOf = (version: string): string => {
  const lines = CHANGELOG.split("\n");
  // `[.-]` not `[.\-]`: this helper is copied from the same algorithm embedded in
  // release.yml's shell block, where the doubled backslash is consumed by the
  // shell. In a plain module there is no shell layer, so the escape is just
  // noise that `no-useless-escape` rejects.
  const escaped = version.replace(/[.-]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^## \\[?${escaped}\\]?`).test(l));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // `lines[i]` is `string | undefined` under noUncheckedIndexedAccess, even
    // though the bound provably keeps it in range. The regex tolerates undefined
    // by stringifying it, so this is a type assertion, not a runtime guard.
    if (/^## /.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
};

describe("the release maintains the major-version ref", () => {
  it("moves it after tagging, not before", () => {
    // Before the tag exists there is nothing to point at, and a partial order
    // would leave a ref pointing at a commit no release covers.
    const tagIndex = RELEASE.indexOf('gh release create');
    const refIndex = RELEASE.indexOf("Move the major-version ref");
    expect(tagIndex).toBeGreaterThan(-1);
    expect(refIndex).toBeGreaterThan(tagIndex);
  });

  it("points the ref at the released commit, not at main", () => {
    // Pointing at main would advance every consumer's install to unreleased work.
    // That is precisely what a pinned install is supposed to prevent.
    expect(RELEASE).toMatch(/git push --force origin "\$\{COMMIT\}:refs\/heads\/\$\{MAJOR_REF\}"/);
    expect(RELEASE).toContain('git rev-parse "${TAG}^{commit}"');
  });

  it("derives the ref name from the validated version, never the raw input", () => {
    // `v1.0.0`, `1.0.0` and `01.0.0` must all move the same ref. Parsing the raw
    // input is how a release ends up publishing v1.0.0 and moving `v01`.
    expect(RELEASE).toContain('major=${NORMALISED%%.*}');
  });

  it("verifies the ref resolves and carries a usable action", () => {
    // A ref can resolve and still be unusable. Checking it here means a bad
    // release fails the release rather than the first consumer.
    expect(flat(RELEASE)).toMatch(/does not resolve/);
    expect(flat(RELEASE)).toMatch(/has no action\.yml at its tip/);
    expect(flat(RELEASE)).toMatch(/no dist\/index\.js/);
  });

  it("checks the ref's contents, not the working tree", () => {
    // The working tree is the commit just verified, so reading it would prove
    // nothing about the ref that consumers actually fetch.
    expect(RELEASE).toContain("FETCH_HEAD:action.yml");
  });

  it("skips both ref steps on a dry run", () => {
    expect((RELEASE.match(/if: \$\{\{ !inputs\.dry_run \}\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("reports the ref state in the dry-run summary", () => {
    // A dry run that does not mention the ref cannot catch this mistake, which is
    // the only reason anyone runs a dry run.
    expect(flat(RELEASE)).toMatch(/Moving ref/);
    expect(flat(RELEASE)).toMatch(/would be force-updated|would be created/);
  });
});

describe("subversion bumps work by re-pointing the ref", () => {
  it("documents that cutting 1.x moves v1", () => {
    expect(flat(CHANGELOG)).toMatch(/Subversion bumps work by re-pointing the branch/);
  });

  it("documents that a tag alone does not satisfy @v1", () => {
    expect(flat(CHANGELOG)).toMatch(/A tag alone does not satisfy `@v1`/);
  });

  it("says the workflow verifies the ref after moving it", () => {
    expect(flat(CHANGELOG)).toMatch(/moves the `vX` branch/);
  });
});

describe("the documented install matches what the release produces", () => {
  it("the README installs a major ref the release actually maintains", () => {
    // If the README pinned `v1.0.0` this would also pass, so the assertion is
    // specifically that it is the bare major.
    expect(README).toMatch(/uses: Laughing-Man-Studios\/FreeReview@v1\b/);
  });

  it("the CHANGELOG release notes install the same ref", () => {
    const section = sectionOf("1.0.0");
    expect(section).toMatch(/uses: Laughing-Man-Studios\/FreeReview@v1\b/);
  });
});

describe("release notes resolve from the changelog", () => {
  it("has a section for the version being released", () => {
    // The workflow slices `## [x.y.z]` out of CHANGELOG.md. A missing section
    // does not fail the release — it falls back to a placeholder, so the failure
    // is invisible and the published notes say "_No CHANGELOG.md section found_".
    expect(CHANGELOG).toMatch(/^## \[1\.0\.0\]/m);
  });

  it("states the fallback chain weakness in the release notes", () => {
    // This is the most important thing a prospective user should read, and it is
    // the thing a security-adjacent project is most tempted to omit.
    const section = sectionOf("1.0.0");
    // Rewritten 2026-10-02. The old assertions demanded the notes say the
    // default model "resists prompt injection", which is false — one payload
    // class silences it, confirmed by ablation. A test that fails when the
    // documentation becomes accurate is a test that was protecting the error.
    expect(flat(section)).toMatch(/no model resists prompt injection/i);
    expect(flat(section)).toMatch(/silenced by one of the eight, in three passes out of three/i);
    expect(flat(section)).toMatch(/steered by the code under review/i);
    expect(flat(section)).toMatch(/largest open weakness/i);
    expect(flat(section)).not.toMatch(/only the default model resists/i);
  });

  it("states that redaction is not a substitute for rotating a key", () => {
    const section = sectionOf("1.0.0");
    expect(flat(section)).toMatch(/rotating a leaked key/i);
  });

  it("states that reviews are advisory and cover changed lines only", () => {
    const section = sectionOf("1.0.0");
    expect(section).toMatch(/never blocks a merge|does not block/i);
    expect(flat(section)).toMatch(/changed lines only/i);
  });
});

describe("version sections are real boundaries", () => {
  // The regression this exists for: the 1.0.0 assertions used to slice from
  // `## [1.0.0]` to `## [Unreleased]`, which is only a section boundary while
  // 1.0.0 is the newest version. Adding 1.0.1 made that range swallow the whole
  // of 1.0.1, and the 1.0.0 tests still passed — they were asserting against a
  // merged blob. A caveat deleted from one version would have gone unnoticed for
  // as long as a later version restated it.
  it("does not let one version's section contain another's heading", () => {
    for (const version of ["1.0.0", "1.0.1"]) {
      for (const other of ["1.0.0", "1.0.1"]) {
        if (version === other) continue;
        expect(sectionOf(version)).not.toMatch(new RegExp(`^## \\[?${other}\\]?`, "m"));
      }
    }
  });

  it("returns an empty string for a version with no section, rather than the whole file", () => {
    // The failure mode this rules out is a typo'd version silently matching the
    // entire changelog, which would make every assertion on it vacuously true.
    expect(sectionOf("9.9.9")).toBe("");
  });
});

describe("the 1.0.1 notes describe what 1.0.1 is", () => {
  it("says the shipped behaviour is unchanged", () => {
    // A metadata-only release that read like a behaviour change would send people
    // looking for a regression that does not exist — or, worse, hide one.
    const section = sectionOf("1.0.1");
    expect(section.length).toBeGreaterThan(0);
    expect(flat(section)).toMatch(/no change to review behaviour/i);
  });

  it("restates the injection weakness rather than assuming the reader has v1.0.0", () => {
    // Someone installing from 1.0.1 has not read 1.0.0. The single most
    // important limitation cannot be inherited by reference.
    const section = flat(sectionOf("1.0.1"));
    expect(section).toMatch(/resists prompt injection/i);
    expect(section).toMatch(/largest open weakness/i);
    expect(section).toMatch(/steered by the code under review/i);
  });

  it("records the Marketplace metadata change and that it cannot break installs", () => {
    const section = flat(sectionOf("1.0.1"));
    expect(section).toMatch(/Free Review Action/);
    expect(section).toMatch(/display metadata only/i);
    expect(section).toMatch(/@v1` is unaffected/i);
  });
});

describe("the changelog's compare links stay consistent", () => {
  // Relocating the 1.0.0 engineering record stranded the link-definition block
  // in the middle of the file and left `[1.0.1]` undefined, with no test failing.
  // These are structural properties of the file, so they are checked structurally.

  // Narrowed at the source rather than asserted at each use: `m[1]` on a
  // RegExpMatchArray is `string | undefined` under noUncheckedIndexedAccess, and
  // a filtered `string[]` means every later loop is honest about its input.
  const capture = (re: RegExp): string[] =>
    [...CHANGELOG.matchAll(re)].map((m) => m[1]).filter((v): v is string => v !== undefined);

  const headings = capture(/^## \[([^\]]+)\]/gm);
  const defined = capture(/^\[([^\]]+)\]:/gm);

  it("defines a compare link for every version heading", () => {
    for (const version of headings) {
      expect(CHANGELOG).toMatch(new RegExp(`^\\[${version.replace(/[.-]/g, "\\$&")}\\]:\\s*\\S+`, "m"));
    }
  });

  it("defines no compare link for a version that has no heading", () => {
    // The inverse error: an orphan definition is usually a rename that left the
    // old name behind, which renders as a dead link at the foot of the page.
    for (const name of defined) {
      expect(headings).toContain(name);
    }
  });

  it("keeps the link definitions in one trailing block", () => {
    // Stranded mid-file, the block reads as part of whichever section precedes
    // it. GitHub renders the definitions fine but the document lies about its
    // own structure, and nothing else notices.
    const firstDef = CHANGELOG.search(/^\[[^\]]+\]:/m);
    expect(firstDef).toBeGreaterThan(-1);
    const afterFirstDef = CHANGELOG.slice(firstDef);
    expect(afterFirstDef).not.toMatch(/^#{2,4} /m);
  });

  it("opens with the changelog preamble, not a version section", () => {
    // Added after prepending 1.0.2 with `new + old`, which put the new section
    // above `# Changelog` and buried the preamble — including the release
    // procedure and the Marketplace ordering constraint — between two version
    // headings. Nothing failed: the heading/link tests only care that a heading
    // exists somewhere, and the prose tests matched the text wherever it sat.
    //
    // The preamble is the part a maintainer reads before cutting a release, so
    // it has to be the first thing in the file.
    const firstHeading = CHANGELOG.match(/^#{1,2} .*$/m)?.[0] ?? "";
    expect(firstHeading).toMatch(/^# Changelog/);
  });

  it("keeps version sections in descending order below the preamble", () => {
    // Same failure mode, one level down: a version inserted in the wrong place
    // would leave the document readable but wrong.
    const order = [...CHANGELOG.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
    for (let i = 1; i < order.length; i += 1) {
      const prev = order[i - 1]!.split(".").map(Number);
      const cur = order[i]!.split(".").map(Number);
      const descending = prev[0]! > cur[0]!
        || (prev[0] === cur[0] && prev[1]! > cur[1]!)
        || (prev[0] === cur[0] && prev[1] === cur[1] && prev[2]! > cur[2]!);
      expect(descending, `CHANGELOG lists ${order[i - 1]} before ${order[i]}`).toBe(true);
    }
  });

  it("points [Unreleased] at the newest version above it", () => {
    // This went stale silently: [Unreleased] compared against v1.0.0 while v1.0.1
    // was published, so the compare page omitted a whole release.
    //
    // An earlier attempt allowed the base to lag a *drafted* section, reasoning
    // that a version is written before its tag exists. That exemption was wrong:
    // a drafted section already carries a compare link, so "has a link" cannot
    // distinguish drafted from released, and the guard then demanded an exact
    // match on a base that pointed at an untagged version. The honest form is an
    // exact match against the newest heading, and bumping the base is simply the
    // last step of cutting a release — same as tagging it.
    const cmp = (a: string, b: string): number => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    // Semver max, not first-or-last in file order: the changelog is written
    // newest-first, so `[0]` and `.pop()` disagree, and only one of them is
    // currently right depending on which way someone last edited.
    const versions = headings.filter((h) => h !== "Unreleased");
    const newest = versions.reduce((a, b) => (cmp(b, a) > 0 ? b : a));
    expect(newest, "no version section found above [Unreleased]").toBeDefined();
    const link = CHANGELOG.match(/^\[Unreleased\]:\s*(\S+)$/m)?.[1] ?? "";
    // Prefix-agnostic on purpose. This test used to demand `v${newest}`, which
    // was right until `1.0.2` was released without the `v` — at which point the
    // test rejected the *correct* link and would have pushed someone to
    // "restore" a `v1.0.2` that does not exist. The tag prefix is not derivable
    // from the changelog, so asserting on it here is asserting on a guess.
    //
    // `npm run check:changelog` is the guard that can actually answer this: it
    // asks the remote which tags exist. Between them, the version numbers are
    // pinned here and the tag names are verified there.
    const base = link.match(/\/compare\/v?([\d.]+)\.\.\.HEAD/)?.[1];
    expect(base, `[Unreleased] link is not a compare link: ${link}`).toBeDefined();
    expect(base).toBe(newest);
  });
});