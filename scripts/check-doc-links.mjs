// Checks local links (including image sources) in the project's Markdown files.
// External URLs are intentionally not fetched: this gate catches moved/renamed
// docs and screenshots, which is the drift that actually happens in this repo.
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

const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const headingPattern = /^#{1,6}\s+(.+?)\s*#*$/gm;
const broken = [];

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
  const source = readFileSync(path.join(root, file), "utf8");
  // Ignore fenced code: sample Markdown in code blocks is not a real link.
  const prose = source.replace(/^```[\s\S]*?^```/gm, "");
  for (const match of prose.matchAll(linkPattern)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|data:|#)/i.test(target)) continue;

    const [rawPath, rawAnchor] = target.split("#");
    const decoded = decodeURIComponent(rawPath);
    if (!decoded) continue;

    const resolved = path.resolve(root, path.dirname(file), decoded);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      broken.push(`${file}: link escapes the repository: ${target}`);
      continue;
    }
    if (!existsSync(resolved)) {
      broken.push(`${file}: missing target ${target}`);
      continue;
    }
    if (rawAnchor && decoded.endsWith(".md") && !anchors(relative).has(decodeURIComponent(rawAnchor))) {
      broken.push(`${file}: missing heading "${rawAnchor}" in ${target}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`Found ${broken.length} broken local documentation link(s):`);
  for (const issue of broken) console.error(`  ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`All local links in ${files.length} Markdown files resolve.`);
}
