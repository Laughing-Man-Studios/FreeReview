import { defineConfig } from "tsup";

// The action ships as a single committed CommonJS bundle at dist/index.js.
// CJS (not ESM) because that is the long-established shape GitHub Actions
// executes, and it avoids any dependency on package.json "type" resolution at
// runtime. Zero runtime dependencies: everything is inlined here.
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "dist",
  format: ["cjs"],
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: true,
  // node: builtins stay external. Nothing else does.
  external: [],
  treeshake: true,
  outExtension: () => ({ js: ".js" }),
});
