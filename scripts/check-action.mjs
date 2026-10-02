#!/usr/bin/env node
// Validates action.yml without ever invoking it in a workflow.
//
// ## Why this exists
//
// A JS action referenced with `uses:` is unusable if `action.yml` does not
// parse, and the failure appears at run time in a consumer's repository, not in
// this one. Every consumer's run fails with "Failed to load
// owner/repo/action.yml" before a single line of the action executes.
//
// That is not hypothetical. Live verification shipped an `action.yml` containing
// a `${{ github.token }}` expression inside an input *description*. GitHub
// evaluates action.yml as an expression template, the `github` context is not
// available there, and every `uses:` invocation failed:
//
//   Unrecognized named-value: 'github'. Located at position 1 within expression:
//   github.token
//
// The unit test suite passed, `check:dist` passed, and CI on this repository
// passed — because nothing here ever *loads* the action. This script does.
//
// ## What it checks
//
// - the file is present and parses as YAML;
// - `name`, `description`, and `runs` are present and well-formed;
// - `runs.using` is a runner this repository supports;
// - `runs.main` points at a file that exists;
// - every declared input has a description;
// - no expression uses a context that is unavailable in action metadata.
//
// Strictly read-only. It never writes anything.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const actionPath = join(root, "action.yml");

function fail(message, hint) {
  console.error(`check:action — FAILED: ${message}`);
  if (hint) console.error(`check:action — ${hint}`);
  process.exit(1);
}

if (!existsSync(actionPath)) {
  fail("action.yml is missing.", "A distributable JS action requires action.yml at the repository root.");
}

const text = readFileSync(actionPath, "utf8");

/** Parse using the same YAML implementation the runner uses. */
let doc;
try {
  // `yaml` ships as a transitive dependency of several tools; fall back to a
  // structural scan if it is somehow absent, because failing to *check* is
  // worse than a coarse check.
  const { parse } = await import("yaml");
  doc = parse(text);
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND") {
    console.error("check:action — the `yaml` package is unavailable; cannot validate action.yml.");
    process.exit(1);
  }
  fail(`action.yml is not valid YAML: ${error.message}`);
}

if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
  fail("action.yml did not parse to a mapping.");
}

// --- Required top-level keys ---------------------------------------------

for (const key of ["name", "description", "runs"]) {
  if (doc[key] === undefined) fail(`action.yml is missing the required '${key}' key.`);
}

if (doc.runs === null || typeof doc.runs !== "object") {
  fail("action.yml 'runs' must be a mapping.");
}

// --- Marketplace submission constraints -----------------------------------
//
// GitHub rejects the Marketplace submission over these, and only at submission
// time — long after the tag, the release, and CI are all green. Found the hard
// way during the v1 submission, so they are checked here instead.

// Rejection reads "Description must be less than 125 characters", so 125
// itself is already too long. The boundary is exclusive.
if (typeof doc.description !== "string") {
  fail("action.yml 'description' must be a string.");
} else if (doc.description.length >= 125) {
  fail(
    `action.yml 'description' is ${doc.description.length} characters.`,
    "GitHub rejects the Marketplace submission unless it is under 125. The action still runs, so nothing local catches this.",
  );
}

// 'name' must be unique across every action, user, and organization on
// GitHub, which is a global namespace this repository cannot inspect. Only the
// length bound is checkable locally; uniqueness has to be confirmed by
// submitting. Renaming is otherwise free: `uses:` resolves on owner/repo and
// never on this field, so a display-name change cannot break `@v1` for anyone.
if (typeof doc.name !== "string" || doc.name.trim().length === 0) {
  fail("action.yml 'name' must be a non-empty string.");
} else if (doc.name.length > 64) {
  fail(`action.yml 'name' is ${doc.name.length} characters; GitHub caps it at 64.`);
}

// --- runs.using -----------------------------------------------------------

const using = doc.runs.using;
const SUPPORTED = new Set(["node20", "node24", "docker", "composite"]);
if (!SUPPORTED.has(using)) {
  fail(
    `runs.using is '${using}', which is not a supported runner.`,
    "This action targets node24. A wrong value here fails at run time in every consumer's repository.",
  );
}

// --- runs.main ------------------------------------------------------------

const main = doc.runs.main;
if (typeof main !== "string" || main.length === 0) {
  fail("runs.main must name the bundled entrypoint.");
} else if (!existsSync(join(root, main))) {
  fail(`runs.main points at '${main}', which does not exist in this repository.`);
}

// --- inputs ---------------------------------------------------------------

const inputs = doc.inputs ?? {};
for (const [name, spec] of Object.entries(inputs)) {
  if (spec === null || typeof spec !== "object") {
    fail(`input '${name}' must be a mapping.`);
  }
  if (typeof spec.description !== "string" || spec.description.trim().length === 0) {
    // An undocumented input is an input nobody knows how to supply, which is
    // how a required value ends up silently empty.
    fail(`input '${name}' has no description.`);
  }
}

// --- expression contexts --------------------------------------------------

// The check that would have caught the shipping bug. GitHub parses action.yml
// as an expression template; only a subset of contexts is legal there. The
// `github` context in particular is NOT, so naming it in prose breaks the file.
const LEGAL_CONTEXTS = new Set(["inputs", "env", "runner", "job", "matrix"]);
const EXPR = /\$\{\{([^}]*)\}\}/g;

for (const match of text.matchAll(EXPR)) {
  const body = match[1].trim();
  if (body.length === 0) {
    fail("action.yml contains an empty expression `${{ }}`.");
  }
  // Skip literals: ${{ 1 }}, ${{ 'text' }}
  if (/^['"]/.test(body)) continue;

  for (const part of body.split(".")) {
    const root_ = part.trim();
    if (root_.length === 0) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(root_)) continue; // function call or literal
    if (!LEGAL_CONTEXTS.has(root_)) {
      fail(
        `action.yml uses the '${root_}' context inside \`\${{ ${body} }}\`.`,
        "action.yml is evaluated as an expression template where only " +
          `${[...LEGAL_CONTEXTS].join(", ")} are available. The 'github' context is not, ` +
          "and naming it in prose makes the file unparseable for every consumer. " +
          "Refer to it in words instead.",
      );
    }
  }
}

console.log(`check:action — action.yml is valid (${Object.keys(inputs).length} inputs, runs.using=${using}). OK`);
