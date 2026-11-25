/**
 * Derives the VSIX's node_modules allow-list from the packages esbuild leaves external. Adding a
 * dependency to the SDK therefore needs no manual .vscodeignore edit: new JavaScript is bundled,
 * and any new native/platform package is discovered here from the installed dependency graph.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { EXTERNAL_MODULES, expandPattern } from "./external-modules.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const begin = "# BEGIN GENERATED node_modules";
const end = "# END GENERATED node_modules";

function installedPackages() {
  const names = [];
  for (const entry of readdirSafe(join(root, "node_modules"))) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const scoped of readdirSafe(join(root, "node_modules", entry))) names.push(`${entry}/${scoped}`);
    } else {
      names.push(entry);
    }
  }
  return names;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const installed = installedPackages();
const roots = EXTERNAL_MODULES.flatMap((p) => expandPattern(p, installed));
const seen = new Set();
const dirs = new Set();

function visit(name) {
  if (seen.has(name)) return;
  let manifest;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    return;
  }
  seen.add(name);
  const rel = relative(join(root, "node_modules"), dirname(manifest));
  if (!rel.startsWith("..")) {
    const parts = rel.split(sep);
    dirs.add(parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
}

roots.forEach(visit);

const lines = [begin, ...[...dirs].sort().map((d) => `!node_modules/${d}/**`), end].join("\n");
const file = join(root, ".vscodeignore");
const current = readFileSync(file, "utf8");
const before = current.slice(0, current.indexOf(begin));
const after = current.slice(current.indexOf(end) + end.length);
const next = `${before}${lines}${after}`;
if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(".vscodeignore node_modules allow-list is stale; run npm run gen:vscodeignore");
    process.exit(1);
  }
  console.log(".vscodeignore node_modules allow-list is up to date.");
} else {
  writeFileSync(file, next);
  console.log(`Generated node_modules allow-list: ${dirs.size} packages`);
}
