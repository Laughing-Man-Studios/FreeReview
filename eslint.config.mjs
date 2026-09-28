// ESLint flat config.
// Intentionally minimal for Phase 0: the correctness guarantees in this project
// come from the type system and the test suite, not from lint rules. The
// type-aware rules that matter (no floating promises, no unchecked indexed
// access) are already enforced by tsconfig's strict family.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // eslint.config.js is the flat config itself and scripts/*.mjs are plain-JS
  // build tooling; neither participates in the TypeScript project.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "eval/runs/**",
      "coverage/**",
      "eslint.config.mjs",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Every fallible call must be handled. A silently swallowed rejection in
      // an advisory reviewer means a silently skipped review.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Untrusted data (model output, PR-controlled text) flows through these
      // types constantly. Marking it is documentation, not enforcement.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/require-await": "error",
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    // Tests and the eval harness legitimately print, and legitimately use
    // non-null assertions after asserting invariants.
    files: ["tests/**/*.ts", "eval/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
