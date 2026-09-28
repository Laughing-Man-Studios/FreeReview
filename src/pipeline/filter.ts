/**
 * File filtering.
 *
 * Decides which changed files are worth spending model context on. Every rule
 * is table-driven and each skip is attributed to a specific rule, because a
 * review that silently reviews 2 of 40 files is indistinguishable from a bug
 * otherwise.
 *
 * Two distinctions carry the weight here:
 *
 * - **Lockfiles are not noise.** A dependency change is one of the most
 *   security-relevant things a PR can do. The body is excluded because a
 *   multi-thousand-line hash diff is worthless to review and expensive to send,
 *   but the change is still *reported*, so a human sees that dependencies moved.
 * - **Binary and truncated files are not the same as filtered files.** A binary
 *   file has no reviewable content. A truncated file has content we simply
 *   could not retrieve in full, which is a coverage gap and is tracked
 *   separately.
 */

import type { DiffFile } from "../types.js";

export type SkipReason =
  | "binary"
  | "truncated-diff"
  | "no-hunks"
  | "minified"
  | "generated-path"
  | "lockfile-body"
  | "oversized-file"
  | "media";

export interface FilterDecision {
  readonly include: boolean;
  readonly reason?: SkipReason;
  /** Human-readable explanation for the step summary. */
  readonly detail: string;
}

export interface FilterOptions {
  /** Average line length above which a file is treated as minified. */
  minifiedAverageLineLength: number;
  /** Per-file token ceiling, independent of the per-request budget. */
  maxFileTokens: number;
  /** Directory prefixes whose contents are build output. */
  generatedDirectories: readonly string[];
  /** Additional path prefixes or globs to exclude. */
  excludedPrefixes: readonly string[];
}

export const DEFAULT_FILTER_OPTIONS: FilterOptions = {
  // A minified bundle has enormous lines and near-zero review value. 300 is
  // well above real source (typically 30-80) and well below minified output.
  minifiedAverageLineLength: 300,
  // A single file larger than this is excluded wholesale rather than split
  // across chunks, because a 40-chunk review of one generated file helps nobody
  // and would exhaust the request budget on its own.
  maxFileTokens: 12_000,
  generatedDirectories: [
    "dist/",
    "build/",
    "out/",
    "target/",
    "vendor/",
    "node_modules/",
    ".next/",
    ".nuxt/",
    ".svelte-kit/",
    "coverage/",
    "__pycache__/",
    ".venv/",
    "venv/",
    ".gradle/",
    ".terraform/",
  ],
  excludedPrefixes: [".min.", "-lock.", "pnpm-lock.", "yarn.lock", "package-lock."],
};

const MEDIA_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm", ".ogg", ".flac",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".wasm", ".class", ".jar",
  ".pyc", ".pyo", ".o", ".a", ".obj",
];

const LOCKFILE_NAMES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
  "pdm.lock",
  "uv.lock",
  "mix.lock",
];

/**
 * Lockfiles are reported but their bodies are excluded.
 *
 * Returned as `include: true` from `isLockfile` so the caller can distinguish
 * "we looked at this and chose not to send the body" from "we ignored this".
 */
export function isLockfile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return LOCKFILE_NAMES.includes(name);
}

export function classifyPath(path: string): "media" | "generated" | "source" {
  const lower = path.toLowerCase();
  if (MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "media";
  for (const dir of DEFAULT_FILTER_OPTIONS.generatedDirectories) {
    if (lower.startsWith(dir) || lower.includes(`/${dir}`)) return "generated";
  }
  return "source";
}

function averageLineLength(file: DiffFile): number {
  const lines = file.hunks.flatMap((hunk) => hunk.lines);
  if (lines.length === 0) return 0;
  let total = 0;
  for (const line of lines) total += line.text.length;
  return total / lines.length;
}

/**
 * Decide whether a parsed file should be sent to the model.
 *
 * `estimateTokens` is injected rather than imported so the filter stays pure
 * and the chunker's estimator is the single source of truth for sizing.
 */
export function filterFile(
  file: DiffFile,
  estimateTokens: (text: string) => number,
  options: FilterOptions = DEFAULT_FILTER_OPTIONS,
): FilterDecision {
  // A file GitHub reported no patch for. We cannot know whether it is binary or
  // merely unsupported, and either way there is nothing to review.
  if (file.binary || file.hunks.length === 0) {
    return {
      include: false,
      reason: file.binary ? "binary" : "no-hunks",
      detail: "No reviewable text content in the diff.",
    };
  }

  // GitHub shortened the patch. Reviewing a partial diff and presenting it as
  // complete would misrepresent coverage, so the file is skipped and the gap is
  // reported rather than papered over.
  if (file.truncated) {
    return {
      include: false,
      reason: "truncated-diff",
      detail: "GitHub truncated the diff for this file, so it could not be reviewed in full.",
    };
  }

  const kind = classifyPath(file.path);
  if (kind === "media") {
    return {
      include: false,
      reason: "media",
      detail: "Media or binary asset; nothing to review as source.",
    };
  }
  if (kind === "generated") {
    return {
      include: false,
      reason: "generated-path",
      detail: "Build output or vendored content; not authored source.",
    };
  }

  if (isLockfile(file.path)) {
    // Deliberately not a silent drop. Dependency changes are security-relevant
    // and the reader needs to know the file moved even though the body was not
    // worth sending.
    return {
      include: false,
      reason: "lockfile-body",
      detail:
        "Lockfile: the dependency set changed, but the resolved-hash body is not " +
        "worth model context. Reported so the change is not invisible.",
    };
  }

  const avg = averageLineLength(file);
  if (avg > options.minifiedAverageLineLength) {
    return {
      include: false,
      reason: "minified",
      detail: `Average line length ${Math.round(avg)} exceeds the minified threshold of ` +
        `${options.minifiedAverageLineLength}.`,
    };
  }

  const fileTokens = estimateTokens(file.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n"));
  if (fileTokens > options.maxFileTokens) {
    return {
      include: false,
      reason: "oversized-file",
      detail: `Estimated ${fileTokens} tokens exceeds the per-file limit of ${options.maxFileTokens}.`,
    };
  }

  return { include: true, detail: "" };
}

export interface FilterResult {
  readonly included: readonly DiffFile[];
  /** Every excluded file, with the rule that excluded it. */
  readonly excluded: readonly { path: string; decision: FilterDecision }[];
  /** Lockfile and dependency changes worth surfacing to a human. */
  readonly dependencyChanges: readonly string[];
  /** Files that were skipped but SHOULD have been reviewable. */
  readonly coverageGaps: readonly { path: string; reason: SkipReason; detail: string }[];
}

export function filterFiles(
  files: readonly DiffFile[],
  estimateTokens: (text: string) => number,
  options: FilterOptions = DEFAULT_FILTER_OPTIONS,
): FilterResult {
  const included: DiffFile[] = [];
  const excluded: { path: string; decision: FilterDecision }[] = [];
  const dependencyChanges: string[] = [];
  const coverageGaps: { path: string; reason: SkipReason; detail: string }[] = [];

  for (const file of files) {
    // Lockfiles are handled before the general rules so a lockfile inside a
    // generated directory is still reported as a dependency change.
    if (isLockfile(file.path)) {
      const decision = filterFile(file, estimateTokens, options);
      excluded.push({ path: file.path, decision });
      dependencyChanges.push(
        `${file.path}: ${file.additions} added, ${file.deletions} deleted` +
          (decision.reason === "lockfile-body" ? " (lockfile body not reviewed)" : ""),
      );
      continue;
    }

    const decision = filterFile(file, estimateTokens, options);
    if (decision.include) {
      included.push(file);
      continue;
    }

    excluded.push({ path: file.path, decision });

    // A truncated diff is a coverage gap: there was reviewable content we
    // could not obtain. Binary, media, and minified files are not gaps, they
    // simply have no reviewable value.
    if (decision.reason === "truncated-diff" || decision.reason === "oversized-file") {
      coverageGaps.push({
        path: file.path,
        reason: decision.reason ?? "no-hunks",
        detail: decision.detail,
      });
    }
  }

  return { included, excluded, dependencyChanges, coverageGaps };
}
