/**
 * Unified diff parser.
 *
 * Deterministic and dependency-free. The output is the structured
 * intermediate representation that anchoring depends on — the plan is explicit
 * that a diff must never be reduced to strings, because a finding has to be
 * resolved back to an exact line number and side.
 *
 * Input is GitHub's per-file `patch` field from `GET /pulls/{n}/files`, which
 * normally starts directly at the first `@@`. The `---`/`+++`/`diff --git`
 * headers are accepted too, so the same parser handles a whole-PR diff.
 *
 * Every structural rule below is a test, not a hope. A malformed diff is
 * `DIFF_PARSE_FAILED`, which is an action failure: publishing a review against
 * a mis-parsed diff would put comments on the wrong lines.
 */

import type { DiffFile, DiffHunk, DiffLine, FileStatus, LineKind } from "../types.js";

export class DiffParseError extends Error {
  constructor(
    message: string,
    readonly line: number | null,
  ) {
    super(message);
    this.name = "DiffParseError";
  }
}

export interface ParseOptions {
  /** New path of the file. Required — the patch may carry no path headers. */
  path: string;
  status: FileStatus;
  previousPath?: string | undefined;
  /** GitHub's own counts, used only to detect truncation, not to derive lines. */
  additions?: number | undefined;
  deletions?: number | undefined;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = /^\\ No newline at end of file/;

/** Number of context lines GitHub includes on each side of a change by default. */
const DEFAULT_CONTEXT = 3;

interface HunkCursor {
  oldRemaining: number;
  newRemaining: number;
  oldStart: number;
  newStart: number;
  oldLine: number;
  newLine: number;
  position: number;
  /** Mutable during construction; frozen into the hunk when it closes. */
  lines: DiffLine[];
}

/**
 * Parse a single file's unified diff.
 *
 * `position` is the legacy GitHub diff offset (1-based from the line below the
 * first `@@` header). It is recorded for diagnostics only; the publisher uses
 * `line`/`side`, which is the modern representation.
 */
export function parseUnifiedDiff(patch: string, options: ParseOptions): DiffFile {
  const rawLines = patch.split("\n");
  const hunks: DiffHunk[] = [];

  let index = 0;
  let position = 0;
  let current: { header: string; oldLines: number; newLines: number; cursor: HunkCursor } | null = null;

  const finishHunk = (): void => {
    if (current === null) return;
    const { header, oldLines, newLines, cursor } = current;

    // Invariant: a hunk must contain exactly as many old-side and new-side
    // lines as its header declares. A mismatch means the patch is truncated or
    // corrupt, and any anchor derived from it would be wrong.
    if (cursor.oldRemaining !== 0 || cursor.newRemaining !== 0) {
      throw new DiffParseError(
        `Hunk ${header} declared ${oldLines} old / ${newLines} new lines but ` +
          `contained ${oldLines - cursor.oldRemaining} / ${newLines - cursor.newRemaining}. ` +
          "The patch is truncated or malformed.",
        null,
      );
    }

    // An empty hunk carries no anchorable content.
    if (cursor.lines.length > 0) {
      hunks.push({ header, oldStart: cursor.oldStart, oldLines, newStart: cursor.newStart, newLines, lines: cursor.lines });
    }

    // Carry the position counter forward. GitHub's `position` is an offset from
    // the first `@@` header and keeps counting across hunk boundaries, so the
    // next hunk's first body line must continue from where this one stopped.
    position = cursor.position;
    current = null;
  };

  while (index < rawLines.length) {
    const raw = rawLines[index] ?? "";
    const headerMatch = HUNK_HEADER.exec(raw);

    if (headerMatch) {
      finishHunk();


      const oldStart = Number.parseInt(headerMatch[1] as string, 10);
      const oldLines = headerMatch[2] === undefined ? 1 : Number.parseInt(headerMatch[2], 10);
      const newStart = Number.parseInt(headerMatch[3] as string, 10);
      const newLines = headerMatch[4] === undefined ? 1 : Number.parseInt(headerMatch[4], 10);

      // `@@ -0,0 +1,3 @@` is a new file; `@@ -1,0 +0,0 @@` is a deleted file.
      if (oldLines < 0 || newLines < 0) {
        throw new DiffParseError(`Hunk header has a negative line count: ${raw}`, index + 1);
      }

      current = {
        header: raw,
        oldLines,
        newLines,
        cursor: {
          oldRemaining: oldLines,
          newRemaining: newLines,
          oldStart,
          newStart,
          oldLine: oldStart,
          newLine: newStart,
          // Position 1 is the line immediately below the `@@` header.
          position: ++position,
          lines: [],
        },
      };

      index += 1;
      continue;
    }

    if (current === null) {
      // Anything before the first `@@` is file-level header material
      // (`diff --git`, `index`, `---`, `+++`, mode lines). Ignore it.
      index += 1;
      continue;
    }

    // Inside a hunk.
    if (raw === "") {
      // git emits a single space for an empty context line. Some tools emit a
      // truly empty line instead, and treating it as file noise would truncate
      // the hunk. Treat it as an empty context line, which is the pragmatic
      // reading: an empty line inside a hunk is overwhelmingly likely to be an
      // empty source line.
      if (current.cursor.oldRemaining > 0 && current.cursor.newRemaining > 0) {
        pushLine(current, "context", "");
        index += 1;
        continue;
      }
      // Both sides exhausted: a trailing blank from the split, not content.
      finishHunk();
      index += 1;
      continue;
    }

    if (NO_NEWLINE_MARKER.test(raw)) {
      // Metadata, not content. Git's way of saying the preceding line had no
      // terminating newline.
      index += 1;
      continue;
    }

    const marker = raw[0];
    const text = raw.slice(1);

    if (marker === "+") {
      if (current.cursor.newRemaining <= 0) {
        throw new DiffParseError(
          `Hunk ${current.header} received more added lines than it declared.`,
          index + 1,
        );
      }
      pushLine(current, "added", text);
    } else if (marker === "-") {
      if (current.cursor.oldRemaining <= 0) {
        throw new DiffParseError(
          `Hunk ${current.header} received more removed lines than it declared.`,
          index + 1,
        );
      }
      pushLine(current, "removed", text);
    } else if (marker === " ") {
      if (current.cursor.oldRemaining <= 0 || current.cursor.newRemaining <= 0) {
        throw new DiffParseError(
          `Hunk ${current.header} received more context lines than it declared.`,
          index + 1,
        );
      }
      pushLine(current, "context", text);
    } else {
      // Not a hunk header, not a valid body line. Either the patch is corrupt
      // or the hunk ended early; treat it as the end of this hunk and let the
      // invariant check decide.
      finishHunk();
      index += 1;
      continue;
    }

    index += 1;
  }

  finishHunk();

  return {
    path: options.path,
    ...(options.previousPath === undefined ? {} : { previousPath: options.previousPath }),
    status: options.status,
    additions: countKind(hunks, "added"),
    deletions: countKind(hunks, "removed"),
    binary: hunks.length === 0,
    truncated: false,
    hunks,
  };
}

function pushLine(
  current: { header: string; cursor: HunkCursor },
  kind: LineKind,
  text: string,
): void {
  const { cursor } = current;

  const line: DiffLine = {
    kind,
    oldLine: kind === "added" ? null : cursor.oldLine,
    newLine: kind === "removed" ? null : cursor.newLine,
    position: cursor.position,
    text,
    isCommentable: true,
  };

  cursor.lines.push(line);

  if (kind !== "added") cursor.oldRemaining -= 1;
  if (kind !== "removed") cursor.newRemaining -= 1;
  if (kind !== "added") cursor.oldLine += 1;
  if (kind !== "removed") cursor.newLine += 1;
  cursor.position += 1;
}

function countKind(hunks: readonly DiffHunk[], kind: LineKind): number {
  let total = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) if (line.kind === kind) total += 1;
  }
  return total;
}

/**
 * Parse a whole-PR diff into files, using the `diff --git` boundaries.
 *
 * Not the primary path (per-file `patch` is, because it survives pagination and
 * carries status metadata), but useful for fixtures and for the case where a
 * per-file patch is unavailable.
 */
export function parseWholeDiff(
  patch: string,
  resolve: (rawPath: string) => { path: string; status: FileStatus; previousPath?: string },
): DiffFile[] {
  const chunks = splitOnGitHeaders(patch);
  const files: DiffFile[] = [];

  for (const chunk of chunks) {
    const { rawPath, body } = chunk;
    const resolved = resolve(rawPath);
    try {
      files.push(parseUnifiedDiff(body, resolved));
    } catch {
      // A file we cannot parse is skipped rather than failing the whole PR.
      // The caller decides whether that is tolerable based on how many files
      // parsed successfully.
    }
  }

  return files;
}

function splitOnGitHeaders(
  patch: string,
): { rawPath: string; body: string }[] {
  const lines = patch.split("\n");
  const out: { rawPath: string; body: string }[] = [];

  let currentPath: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentPath !== null) {
      out.push({ rawPath: currentPath, body: buffer.join("\n") });
    }
    currentPath = null;
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      // The destination path (b/) is the one that matters: for a rename it is
      // the new location, which is what a review comment must attach to.
      currentPath = match?.[2] ?? line.slice("diff --git ".length);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return out;
}

/** Expected context window, exported for the chunker's awareness. */
export const CONTEXT_LINES = DEFAULT_CONTEXT;
