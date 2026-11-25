// Generates the reference tables in docs/REFERENCE.md from package.json + package.nls.json.
// Run `npm run gen:docs` after changing a command, keybinding or setting; CI runs
// `npm run verify:docs` so a stale table cannot be committed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const nls = JSON.parse(readFileSync(path.join(root, "package.nls.json"), "utf8"));
const docPath = path.join(root, "docs", "REFERENCE.md");

const MARKERS = {
  commands: ["<!-- BEGIN GENERATED: commands -->", "<!-- END GENERATED: commands -->"],
  settings: ["<!-- BEGIN GENERATED: settings -->", "<!-- END GENERATED: settings -->"],
};

// Hints that cannot be derived from the manifest (where a command lives, what it does).
// Keep them next to the generator so REFERENCE.md stays the single generated artefact.
const COMMAND_NOTES = {
  "opencode.account": "view saved logins or sign in",
  "opencode.install": "show the bundled-SDK setup help, open settings or logs, retry the connection",
  "opencode.searchSessions": "searches titles and message bodies across every session",
  "opencode.stopTurn": "also click the status bar while a turn runs",
  "opencode.openSettings": "toolbar gear icon",
  "opencode.restart": "toolbar, with confirmation",
  "opencode.moveView": "left/right side bar or panel",
  "opencode.showLogs": "toolbar overflow menu",
  "opencode.setServerPassword": "external server only",
};

function resolveLocalised(value, key) {
  const match = /^%(.+)%$/.exec(value ?? "");
  if (!match) return value ?? "";
  const resolved = nls[match[1]];
  if (resolved === undefined) throw new Error(`Missing package.nls.json key ${match[1]} (${key})`);
  return resolved;
}

function cell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function keyLabel(binding) {
  const names = {
    ctrl: "Ctrl",
    cmd: "Cmd",
    alt: "Alt",
    shift: "Shift",
    meta: "Meta",
  };
  const label = (part) => names[part] ?? (part.length === 1 ? part.toUpperCase() : part.replace(/^./, (c) => c.toUpperCase()));
  const win = binding.key.split("+");
  if (!binding.mac) return win.map(label).join("+");
  const mac = binding.mac.split("+");
  if (win.length !== mac.length) return `${win.map(label).join("+")} / ${mac.map(label).join("+")}`;
  return win.map((part, i) => (part === mac[i] ? label(part) : `${label(mac[i])}/${label(part)}`)).join("+");
}

function defaultValue(name, property) {
  const value = property.default;
  if (name === "opencode.sessionPermissions" && Array.isArray(value) && value.length > 0) {
    return "ask before edits, shell and external files";
  }
  if (Array.isArray(value) && value.length === 0) return "`[]`";
  if (typeof value === "string" && value === "") return '`""`';
  return `\`${JSON.stringify(value)}\``;
}

function commandTable() {
  const keys = new Map((manifest.contributes.keybindings ?? []).map((binding) => [binding.command, keyLabel(binding)]));
  const rows = manifest.contributes.commands.map((command) => {
    const id = command.command;
    const title = resolveLocalised(command.title, id);
    const name = command.category && !title.startsWith(`${command.category}:`) ? `${command.category}: ${title}` : title;
    return `| ${cell(name)} | ${cell(keys.get(id) ?? "–")} | ${cell(COMMAND_NOTES[id] ?? "")} |`;
  });
  return ["| Command | Default key | Notes |", "| --- | --- | --- |", ...rows].join("\n");
}

function settingsTable() {
  const rows = Object.entries(manifest.contributes.configuration.properties).map(([name, property]) => {
    const description = resolveLocalised(property.markdownDescription, name).replace(/\s+/g, " ").trim();
    return `| \`${name}\` | ${cell(defaultValue(name, property))} | ${cell(description)} |`;
  });
  return ["| Setting | Default | Description |", "| --- | --- | --- |", ...rows].join("\n");
}

function replaceBlock(doc, name, content) {
  const [start, end] = MARKERS[name];
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(doc)) throw new Error(`docs/REFERENCE.md is missing the ${name} generated block markers`);
  return doc.replace(pattern, `${start}\n\n${content}\n\n${end}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function build() {
  let doc = readFileSync(docPath, "utf8");
  doc = replaceBlock(doc, "commands", commandTable());
  doc = replaceBlock(doc, "settings", settingsTable());
  // `format()` does not discover config files, so keep these options in sync with oxfmt.config.ts.
  const { code, errors } = await format(docPath, doc, { printWidth: 140, endOfLine: "lf", tabWidth: 2 });
  if (errors.length > 0) {
    throw new Error(`docs/REFERENCE.md formatting failed: ${errors.map((error) => error.message).join("; ")}`);
  }
  return code;
}

const check = process.argv.includes("--check");
const output = await build();
const current = readFileSync(docPath, "utf8");

if (check) {
  if (output === current) {
    console.log("docs/REFERENCE.md is up to date.");
  } else {
    console.error("docs/REFERENCE.md is stale: run `npm run gen:docs` and commit the result.");
    const currentLines = current.split("\n");
    const expectedLines = output.split("\n");
    const first = expectedLines.findIndex((line, i) => line !== currentLines[i]);
    console.error(`First difference at line ${first + 1}:`);
    console.error(`  expected: ${JSON.stringify(expectedLines[first])}`);
    console.error(`  actual:   ${JSON.stringify(currentLines[first])}`);
    process.exitCode = 1;
  }
} else {
  if (output !== current) writeFileSync(docPath, output);
  console.log("docs/REFERENCE.md generated from package.json + package.nls.json.");
}
