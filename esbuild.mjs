import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "warning",
  },
  {
    entryPoints: ["src/webview/main.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: "dist/webview.js",
    jsx: "automatic",
    jsxImportSource: "preact",
    sourcemap: !production,
    minify: production,
    loader: { ".css": "css" },
    logLevel: "warning",
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("[esbuild] watching…");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`[esbuild] built (${production ? "production" : "development"})`);
}
