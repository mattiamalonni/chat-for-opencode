/**
 * Turn Chromium's precise coverage of `dist/webview.js` into a per-source-file line report.
 *
 * The UI suite runs the real bundle, so V8 ranges refer to generated code. The esbuild source map
 * maps them back to `src/webview/*.tsx`; we count a source line as hit when any generated range that
 * covers it executed. Output: `coverage/ui/lcov.info` plus a console summary. Set
 * `OC_UI_COVERAGE_MIN` to make the summary a gate.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const BUNDLE = "dist/webview.js";
const DIR = join("coverage", "ui");
const map = JSON.parse(readFileSync(`${BUNDLE}.map`, "utf8"));
const code = readFileSync(BUNDLE, "utf8");
const tracer = new TraceMap(map);

const lineStarts = [0];
for (const line of code.split("\n")) lineStarts.push(lineStarts.at(-1) + line.length + 1);
function lineAt(offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based, as V8/source-map expect
}

/** Merge overlapping ranges from all tests; a line is covered if any test hit it. */
const ranges = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const scripts = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  for (const script of scripts) {
    if (!script.url.includes("webview.js")) continue;
    for (const fn of script.functions) {
      for (const range of fn.ranges) {
        if (range.count > 0 && range.endOffset > range.startOffset) ranges.push([range.startOffset, range.endOffset]);
      }
    }
  }
}
ranges.sort((a, b) => a[0] - b[0]);
const merged = [];
for (const [start, end] of ranges) {
  const last = merged.at(-1);
  if (last && start <= last[1]) last[1] = Math.max(last[1], end);
  else merged.push([start, end]);
}

const covered = new Map(); // source path -> Set of 1-based lines
for (const [start, end] of merged) {
  for (let line = lineAt(start); line <= lineAt(end - 1); line++) {
    const pos = originalPositionFor(tracer, { line, column: 0 });
    if (!pos.source || !pos.line || !pos.source.includes("/src/webview/")) continue;
    const source = resolve(dirname(BUNDLE), pos.source);
    if (!covered.has(source)) covered.set(source, new Set());
    covered.get(source).add(pos.line);
  }
}

const files = [];
for (let i = 0; i < map.sources.length; i++) {
  const source = map.sources[i];
  if (!source.includes("/src/webview/")) continue;
  const absolute = resolve(dirname(BUNDLE), source);
  const content = map.sourcesContent?.[i] ?? "";
  const lines = content.split("\n");
  const codeLines = lines.map((text, index) => ({ text, line: index + 1 })).filter(({ text }) => text.trim().length > 0);
  const hit = covered.get(absolute) ?? new Set();
  files.push({
    path: absolute,
    labelled: codeLines.filter(({ line }) => hit.has(line)).length,
    total: codeLines.length,
    lines: codeLines.map(({ line }) => `DA:${line},${hit.has(line) ? 1 : 0}`),
  });
}
files.sort((a, b) => a.path.localeCompare(b.path));

const lcov = files.flatMap((f) => ["TN:", `SF:${f.path}`, ...f.lines, `LF:${f.total}`, `LH:${f.labelled}`, "end_of_record"]).join("\n");
writeFileSync(join(DIR, "lcov.info"), `${lcov}\n`);

const hit = files.reduce((n, f) => n + f.labelled, 0);
const total = files.reduce((n, f) => n + f.total, 0);
const percent = total ? (100 * hit) / total : 0;
for (const f of files) {
  const pct = f.total ? ((100 * f.labelled) / f.total).toFixed(1) : "0.0";
  console.log(`  ${f.path.replace(process.cwd() + "/", "")}: ${f.labelled}/${f.total} lines (${pct}%)`);
}
console.log(`Webview UI coverage: ${hit}/${total} lines (${percent.toFixed(1)}%) — see ${join(DIR, "lcov.info")}`);

const floor = Number(process.env.OC_UI_COVERAGE_MIN ?? 55);
if (percent < floor) {
  console.error(`Webview coverage ${percent.toFixed(1)}% is below the ${floor}% floor.`);
  process.exitCode = 1;
}
