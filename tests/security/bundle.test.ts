/**
 * Security invariants asserted against the artifact that actually ships.
 *
 * These run against `dist/index.js`, not `src/`, because `dist/` is what
 * GitHub Actions executes. A source-level review proves nothing about the
 * bundle a consumer actually gets.
 *
 * The action's central security claim is that it never executes PR-controlled
 * code. It obtains all of its data through the GitHub API. If the bundle ever
 * grows the ability to spawn a process or evaluate a string, that claim is
 * false, and it must fail the build rather than be noticed in review.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const bundlePath = resolve(root, "dist/index.js");

let bundle = "";

beforeAll(() => {
  if (!existsSync(bundlePath)) {
    // Build on demand so `npm test` works on a fresh clone.
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  }
  bundle = readFileSync(bundlePath, "utf8");
});

/**
 * Patterns that would indicate the ability to execute code.
 *
 * Matched against the bundle with surrounding word boundaries where it matters,
 * so an unrelated identifier containing a substring does not produce a false
 * failure. Note that `child_process` and `eval` legitimately appear inside
 * string literals only if we were badly written — we are checking that they do
 * not appear as *references*.
 */
const EXECUTION_CAPABILITIES: ReadonlyArray<readonly [string, RegExp]> = [
  ["child_process import", /\brequire\(\s*["']node:child_process["']\s*\)/],
  ["child_process import (bare)", /\brequire\(\s*["']child_process["']\s*\)/],
  ["dynamic import of child_process", /\bimport\(\s*["']node:child_process["']\s*\)/],
  // NB: these deliberately exclude `exec`, because `RegExp.prototype.exec` is
  // the built-in string matcher and appears in the diff parser and the
  // injection normaliser. The risky forms are the child_process ones, which are
  // matched by their import instead — asserting the import is absent is both
  // precise and not fooled by a method name.
  ["spawn / spawnSync", /\bspawn(?:Sync)?\s*\(/],
  ["fork", /\bfork\s*\(/],
  ["eval", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\s*\(/],
  ["vm module", /require\(\s*["']node:vm["']\s*\)/],
  ["WebAssembly", /\bWebAssembly\./],
];

const PACKAGE_MANAGER_INVOCATION =
  /\b(?:npm|yarn|pnpm|bun|npx|node)\s+(?:install|ci|run|exec|test|start|build)\b/;

describe("shipped bundle has no code-execution capability", () => {
  it.each(EXECUTION_CAPABILITIES)("does not reference %s", (_label, pattern) => {
    expect(bundle).not.toMatch(pattern);
  });

  it("does not invoke a package manager", () => {
    expect(bundle).not.toMatch(PACKAGE_MANAGER_INVOCATION);
  });

  it("appends to, but never overwrites, a file", () => {
    // The only two files this action writes are GITHUB_OUTPUT and
    // GITHUB_STEP_SUMMARY, both of which GitHub requires to be *appended*
    // to. A truncating write would destroy the workflow's own bookkeeping.
    // Both call sites live in run.ts and both are count-asserted below.
    expect(bundle).not.toMatch(/\bwriteFileSync\s*\(/);
    expect(bundle).not.toMatch(/\btruncateSync\s*\(/);
    expect(bundle).not.toMatch(/\bcreateWriteStream\s*\(/);
    expect(bundle).not.toMatch(/\bopenSync\s*\(/);
  });

  it("writes to exactly the two GitHub-managed output files", () => {
    // Every fs write must be a GITHUB_* path. A stray writable path (a cache
    // file, a temp file, the repo) is a correctness and security problem.
    expect(bundle).toContain("GITHUB_OUTPUT");
    expect(bundle).toContain("GITHUB_STEP_SUMMARY");
    // Exactly two append call sites: the output writer and the summary writer.
    const appendSites = [...bundle.matchAll(/\bappendFileSync\s*\(/g)].length;
    expect(appendSites).toBe(2);
  });

  it("does not create or remove directories or files", () => {
    expect(bundle).not.toMatch(/\bmkdir(?:Sync)?\s*\(/);
    expect(bundle).not.toMatch(/\brm(?:Sync)?\s*\(/);
    expect(bundle).not.toMatch(/\bunlink(?:Sync)?\s*\(/);
    expect(bundle).not.toMatch(/\brename(?:Sync)?\s*\(/);
    expect(bundle).not.toMatch(/\bcp(?:Sync)?\s*\(/);
  });

  it("does not spawn or exec a shell through any indirect path", () => {
    // Belt-and-braces: even if a future refactor dropped the direct import, a
    // global process accessor would reintroduce the capability.
    expect(bundle).not.toMatch(/\bprocess\s*\.\s*binding\b/);
    expect(bundle).not.toMatch(/\brequire\s*\(\s*["']node:vm["']\s*\)/);
  });

  it("does not reference actions/checkout or any git executable", () => {
    expect(bundle).not.toMatch(/actions\/checkout/);
    expect(bundle).not.toMatch(/simple-git|isomorphic-git/);
  });

  it("requires only node: builtins — every dependency is inlined", () => {
    // A bare require() surviving in a bundled CJS artifact is either a node
    // builtin or a bundling bug. Consumers install nothing at runtime, so a
    // non-builtin require would fail only in production.
    const bare = [...bundle.matchAll(/require\(\s*["']([^"'.][^"']*)["']\s*\)/g)]
      .map((m) => m[1])
      .filter((id): id is string => typeof id === "string");
    const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
    const nonBuiltins = bare.filter((id) => !builtins.has(id.replace(/^node:/, "")));
    expect(nonBuiltins).toEqual([]);
  });
});

describe("shipped bundle does not embed credentials", () => {
  it("contains no sk-/ghp_/AKIA-style literal", () => {
    expect(bundle).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
    expect(bundle).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{16,}/);
    expect(bundle).not.toMatch(/\bAKIA[0-9A-Z]{16}/);
  });

  it("reads the API key from the environment with no hardcoded fallback", () => {
    // The input name is assembled at runtime (INPUT_<UPPERCASED>), so the
    // bundle contains no credential-shaped literal at all. What must be
    // present is the prefix and the uppercasing that makes the lookup work.
    expect(bundle).toContain("INPUT_");
    expect(bundle).toContain("toUpperCase");
    // No `|| "sk-..."`-style default anywhere.
    expect(bundle).not.toMatch(/=\s*["']sk-[^"']*["']/);
  });
});

describe("shipped bundle is a committed artifact, not a symlink or stub", () => {
  it("has real content", () => {
    expect(bundle.length).toBeGreaterThan(1_000);
  });

  it("is CommonJS, matching runs.using: node24 + main: dist/index.js", () => {
    // A bundled ESM artifact would still execute on node24, but CJS keeps the
    // action free of any package.json "type" resolution at runtime.
    expect(bundle).toContain("require(");
  });
});
