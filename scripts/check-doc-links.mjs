// Checks the project's Markdown for stale local links and for references to
// identifiers that no longer exist: npm scripts, opencode.* settings and commands.
// External URLs are not fetched; this gate catches the drift that happens locally.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "README.md",
  "CONTRIBUTING.md",
  "SPEC.md",
  "CHANGELOG.md",
  ...readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
  ...readdirSync(path.join(root, "media"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `media/${name}`),
];

// CHANGELOG.md is a record of the past: it may legitimately mention a command or
// script that has since been removed, so identifier checks skip it.
const referenceFiles = files.filter((file) => file !== "CHANGELOG.md");

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const scripts = new Set(Object.keys(manifest.scripts));
const identifiers = new Set([
  ...Object.keys(manifest.contributes.configuration.properties),
  ...manifest.contributes.commands.map((command) => command.command),
]);
// Config files and domains use the same prefix but are not settings or commands.
const NOT_IDENTIFIERS = new Set(["json", "jsonc"]);

const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const headingPattern = /^#{1,6}\s+(.+?)\s*#*$/gm;
const scriptPattern = /\bnpm run ([a-z0-9][a-z0-9:_-]*)\b/g;
const identifierPattern = /\bopencode\.([A-Za-z][A-Za-z0-9]*)\b/g;
const broken = [];

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function proseOf(source) {
  // Blank fenced code instead of removing it, so reported line numbers stay exact.
  return source.replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, " "));
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`|\*|_|\{|\}/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function anchors(file) {
  const source = readFileSync(path.join(root, file), "utf8");
  return new Set([...source.matchAll(headingPattern)].map((match) => slug(match[1])));
}

for (const file of files) {
  const prose = proseOf(readFileSync(path.join(root, file), "utf8"));
  for (const match of prose.matchAll(linkPattern)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|data:|#)/i.test(target)) continue;

    const [rawPath, rawAnchor] = target.split("#");
    const decoded = decodeURIComponent(rawPath);
    if (!decoded) continue;

    const resolved = path.resolve(root, path.dirname(file), decoded);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      broken.push(`${file}:${lineAt(prose, match.index)}: link escapes the repository: ${target}`);
      continue;
    }
    if (!existsSync(resolved)) {
      broken.push(`${file}:${lineAt(prose, match.index)}: missing target ${target}`);
      continue;
    }
    if (rawAnchor && decoded.endsWith(".md") && !anchors(relative).has(decodeURIComponent(rawAnchor))) {
      broken.push(`${file}:${lineAt(prose, match.index)}: missing heading "${rawAnchor}" in ${target}`);
    }
  }
}

for (const file of referenceFiles) {
  // Strip URLs so domains such as opencode.ai are not mistaken for identifiers.
  const prose = proseOf(readFileSync(path.join(root, file), "utf8")).replace(/https?:\/\/\S+/g, "");
  for (const match of prose.matchAll(scriptPattern)) {
    if (!scripts.has(match[1])) {
      broken.push(`${file}:${lineAt(prose, match.index)}: unknown npm script "${match[1]}"`);
    }
  }
  for (const match of prose.matchAll(identifierPattern)) {
    if (!NOT_IDENTIFIERS.has(match[1]) && !identifiers.has(match[0])) {
      broken.push(`${file}:${lineAt(prose, match.index)}: unknown setting/command "${match[0]}"`);
    }
  }
}

if (broken.length > 0) {
  console.error(`Found ${broken.length} broken documentation reference(s):`);
  for (const issue of broken) console.error(`  ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`All local links and identifier references in ${files.length} Markdown files resolve.`);
}
