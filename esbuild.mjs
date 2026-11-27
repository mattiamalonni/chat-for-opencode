import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { EXTERNAL_MODULES } from "./scripts/external-modules.mjs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

if (production) rmSync("dist", { recursive: true, force: true });

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: "dist/extension.mjs",
    // Extension host code only: the OpenCode SDK is the separate `dist/sdk.mjs` below. Native/optional
    // modules stay external so their platform binaries ship unchanged; their dependency closure is
    // generated at package time.
    mainFields: ["module", "main"],
    external: ["vscode", ...EXTERNAL_MODULES],
    banner: {
      js: 'import { createRequire as __ocCreateRequire } from "node:module"; const require = __ocCreateRequire(import.meta.url);',
    },
    sourcemap: false,
    charset: "utf8",
    minify: production,
    logLevel: "warning",
  },
  {
    // The OpenCode SDK and its dependencies, imported lazily by src/sdk/loader.ts on first connect.
    entryPoints: { sdk: "src/sdk/bridge.ts" },
    // OpenCode reads its libc from a build-time constant and falls back to glibc, which loads the
    // wrong file-watcher binary on Alpine. Resolve it at runtime instead (see the banner below), so
    // one Linux build serves both the glibc and the musl (alpine-*) packages.
    define: { OPENCODE_LIBC: "__ocLibc" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    mainFields: ["module", "main"],
    external: ["vscode", ...EXTERNAL_MODULES],
    banner: {
      js: [
        'import { createRequire as __ocCreateRequire } from "node:module";',
        "const require = __ocCreateRequire(import.meta.url);",
        // glibc reports its version in the process report header; musl does not.
        'const __ocLibc = process.platform !== "linux" ? undefined : (() => { try { return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl"; } catch { return undefined; } })();',
      ].join(" "),
    },
    sourcemap: false,
    charset: "utf8",
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
    charset: "utf8",
    minify: production,
    loader: { ".css": "css" },
    logLevel: "warning",
  },
  {
    entryPoints: ["src/webview/connect/main.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: "dist/connect.js",
    jsx: "automatic",
    jsxImportSource: "preact",
    sourcemap: !production,
    charset: "utf8",
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
