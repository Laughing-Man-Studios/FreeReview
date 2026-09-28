/**
 * Searchable anchor index, built per file.
 *
 * The single most important property of this module, and the reason it exists
 * as its own concept rather than being inlined into the resolver:
 *
 * > **The index is built over the WHOLE file diff, not the chunk being
 * > reviewed.**
 *
 * Because resolution runs against the complete file, chunk packing — including
 * splitting a large hunk mid-way — can never cause an anchoring failure. The
 * two concerns are fully decoupled. If resolution were chunk-scoped, every
 * chunking decision would be a bet that it hadn't split a finding's context.
 *
 * ## Segments, not one big string
 *
 * A side's lines are grouped into *segments*, one per hunk. Matching must
 * happen inside a single segment. Concatenating all hunks would make text that
 * is not actually contiguous in the file — because the diff omits unchanged
 * regions between hunks — appear to match across a gap. A quote that spans two
 * hunks is invalid: its lines are not adjacent in the source.
 *
 * Each side gets its own segments, because LEFT and RIGHT have different line
 * counts. For a replacement like:
 *
 *     context A
 *    -removed B
 *    +added C
 *     context D
 *
 * RIGHT is [A, C, D] and LEFT is [A, B, D]. So "A\nC" correctly anchors to a
 * RIGHT range of 1-2, and "B" correctly anchors to a LEFT line. Both are
 * legitimate GitHub ranges.
 */

import type { DiffFile, LineKind, Side } from "../types.js";

export interface IndexLine {
  /** Line number on the side this segment represents. */
  readonly lineNumber: number;
  readonly kind: LineKind;
  readonly text: string;
  /**
   * Whether a review comment can be anchored to this line. Carried through from
   * the parser so the resolver's output can be asserted against it directly,
   * rather than re-deriving GitHub's rule in every consumer.
   */
  readonly isCommentable: boolean;
}

export interface Segment {
  readonly filePath: string;
  readonly side: Side;
  readonly hunkIndex: number;
  readonly lines: readonly IndexLine[];
}

export interface FileIndex {
  readonly path: string;
  readonly segments: readonly Segment[];
}

/**
 * Build the index for one file.
 *
 * Emits both sides for every hunk. Segments with no lines on a side are
 * omitted: a pure deletion hunk has no RIGHT content, so a RIGHT segment
 * would be empty and could only ever produce a spurious match.
 */
export function buildFileIndex(file: DiffFile): FileIndex {
  const segments: Segment[] = [];

  file.hunks.forEach((hunk, hunkIndex) => {
    const left: IndexLine[] = [];
    const right: IndexLine[] = [];

    for (const line of hunk.lines) {
      // Context appears on both sides; added only on RIGHT; removed only on LEFT.
      // `isCommentable` is carried through so consumers can assert the anchor
      // lands on a line GitHub will accept, without re-deriving the rule.
      if (line.oldLine !== null) {
        left.push({
          lineNumber: line.oldLine,
          kind: line.kind,
          text: line.text,
          isCommentable: line.isCommentable,
        });
      }
      if (line.newLine !== null) {
        right.push({
          lineNumber: line.newLine,
          kind: line.kind,
          text: line.text,
          isCommentable: line.isCommentable,
        });
      }
    }

    if (left.length > 0) {
      segments.push({ filePath: file.path, side: "LEFT", hunkIndex, lines: left });
    }
    if (right.length > 0) {
      segments.push({ filePath: file.path, side: "RIGHT", hunkIndex, lines: right });
    }
  });

  return { path: file.path, segments };
}

/** Build an index for many files, keyed by path. */
export function buildIndex(files: readonly DiffFile[]): Map<string, FileIndex> {
  const index = new Map<string, FileIndex>();
  for (const file of files) {
    // First occurrence wins. A path cannot legitimately appear twice in a PR
    // diff, but if it somehow does, a duplicate would turn every quote from
    // that file into a false ambiguity.
    if (!index.has(file.path)) index.set(file.path, buildFileIndex(file));
  }
  return index;
}

/**
 * Renamed and copied files are indexed under their NEW path only, deliberately.
 *
 * A review comment must attach to the file's current location, and the path the
 * model is asked to return is the one in the diff. Indexing the previous path as
 * well would create a second entry whose segments are labelled with the new path
 * while the map key is the old one — a mismatch that would resolve to the wrong
 * file. Refusing to anchor to a previous path is the correct outcome; the prompt
 * instructs the model to return the path as it appears in the diff.
 */
