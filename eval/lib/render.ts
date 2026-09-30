/**
 * Fixture materialisation.
 *
 * Turns a `Fixture` into the three committed artefacts the plan specifies:
 * `pr.diff`, `head.json`, and `fixture.json`.
 *
 * The `@@` header is always derived from the hunk body, never authored. The
 * parser is strict about these counts by design, and a miscount silently places
 * every anchor on the wrong line — so the one thing a fixture author must never
 * do by hand is the arithmetic.
 */

import type { Fixture, FixtureFile } from "./fixtures.js";

export interface GeneratedFile {
  readonly path: string;
  readonly status: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

/**
 * Count a hunk body's old-side and new-side lines.
 *
 * Returns all four numbers because the `@@` header needs the two side counts
 * while the fixture metadata needs the change counts, and deriving one from the
 * other is exactly the arithmetic that goes wrong.
 */
export function hunkCounts(lines: readonly string[]): {
  oldCount: number;
  newCount: number;
  added: number;
  deleted: number;
} {
  let oldCount = 0;
  let newCount = 0;
  let added = 0;
  let deleted = 0;

  for (const line of lines) {
    const marker = line[0];
    if (marker === "-") {
      deleted += 1;
      oldCount += 1;
    } else if (marker === "+") {
      added += 1;
      newCount += 1;
    } else if (marker === " ") {
      oldCount += 1;
      newCount += 1;
    } else {
      throw new Error(
        `hunk line must begin with ' ', '-' or '+' — got ${JSON.stringify(line.slice(0, 12))}`,
      );
    }
  }

  return { oldCount, newCount, added, deleted };
}

/**
 * Render one file's patch.
 *
 * `oldStart`/`newStart` default to 1. Every Stage A fixture is authored as a
 * single hunk at the top of the file, which is deliberate: a real GitHub patch
 * places the hunk where the change is, and an author writing a fixture from
 * scratch would otherwise be inventing line offsets by hand and getting them
 * wrong. Stage B's multi-hunk fixture moves the change away from line 1.
 */
export function renderFile(file: FixtureFile, oldStart = 1, newStart = 1): GeneratedFile {
  const { oldCount, newCount, added, deleted } = hunkCounts(file.lines);

  // Counts are always written explicitly. GitHub omits the count when it is 1,
  // but writing it is accepted and removes a class of ambiguity.
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

  const headers: string[] = [`diff --git a/${file.previousPath ?? file.path} b/${file.path}`];

  if (file.status === "added") {
    headers.push("new file mode 100644");
  } else if (file.status === "deleted") {
    headers.push("deleted file mode 100644");
  } else if (file.status === "renamed") {
    headers.push(`rename from ${file.previousPath}`);
    headers.push(`rename to ${file.path}`);
  } else {
    headers.push("index 1111111..2222222 100644");
  }

  headers.push(`--- ${file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`}`);
  headers.push(`+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}`);
  headers.push(header);

  const patch = `${[...headers, ...file.lines].join("\n")}\n`;

  return {
    path: file.path,
    status: file.status,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    additions: added,
    deletions: deleted,
    patch,
  };
}

/** Render every file in a fixture, concatenated as a whole-PR diff. */
export function renderFixture(fixture: Fixture): GeneratedFile[] {
  return fixture.files.map((file) => renderFile(file));
}

/**
 * The `head.json` shape, mirroring GitHub's `pulls/{n}/files` entries.
 *
 * The action reads `filename`, `status`, `additions`, `deletions`, and `patch`.
 * `additions`/`deletions` are only used to detect truncation, so they are
 * derived rather than authored — an author-supplied count that disagrees with
 * the patch is a fixture bug, not a useful signal.
 */
export function renderHead(fixture: Fixture): unknown[] {
  return renderFixture(fixture).map((file) => ({
    sha: `${Math.abs(hash(file.path)).toString(16).padStart(8, "0")}`.slice(0, 40),
    filename: file.path,
    ...(file.previousPath !== undefined ? { previous_filename: file.previousPath } : {}),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    patch: file.patch,
  }));
}

/** Stable, path-derived blob sha. Not a real git object; only needs to be stable. */
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * The committed `fixture.json`, which is the source of truth plus its rationale.
 *
 * The rationale and `proves` fields are carried verbatim and are never sent to
 * a model. They exist so a human reading a dataset failure can tell whether the
 * fixture or the reviewer was wrong.
 */
export function renderFixtureJson(fixture: Fixture): unknown {
  return {
    id: fixture.id,
    category: fixture.category,
    split: fixture.split,
    proves: fixture.proves,
    files: fixture.files.map((file) => file.path),
    expectedFindings: fixture.expectedFindings.map((finding) => ({
      path: finding.path,
      quote: finding.quote,
      side: finding.side,
      line: finding.line,
      ...(finding.startLine !== undefined ? { startLine: finding.startLine } : {}),
      severity: finding.severity,
      explanationMentions: [...finding.explanationMentions],
      rationale: finding.rationale,
    })),
    expectedNoFindings: [...fixture.expectedNoFindings],
    forbiddenFindings: fixture.forbiddenFindings.map((forbidden) => ({
      ...(forbidden.path !== undefined ? { path: forbidden.path } : {}),
      quote: forbidden.quote,
      reason: forbidden.reason,
    })),
    injection: fixture.injection,
  };
}
