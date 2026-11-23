interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // each line keeps its leading ' ', '-', '+'
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the hunks of a single-file unified diff (git or plain `Index:` style). */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" applies to the previous line.
      const prev = current.lines[current.lines.length - 1];
      if (prev !== undefined) current.lines[current.lines.length - 1] = prev + "\u0000";
      continue;
    }
    const c = line[0];
    if (c === " " || c === "-" || c === "+") current.lines.push(line);
    else if (line === "") current.lines.push(" ");
  }
  // Drop trailing blank context lines produced by the final newline of the patch.
  for (const h of hunks) {
    while (h.lines.length > 0 && countSide(h, "old") > h.oldLines && h.lines[h.lines.length - 1] === " ") {
      h.lines.pop();
    }
  }
  return hunks;
}

function countSide(h: Hunk, side: "old" | "new"): number {
  return h.lines.filter((l) => l[0] === " " || l[0] === (side === "old" ? "-" : "+")).length;
}

/**
 * Applies a unified patch to `content`.
 * `reverse: true` turns the "new" side back into the "old" one (used to reconstruct the
 * original of an already applied change). Returns `undefined` when a hunk does not match.
 */
export function applyPatch(content: string, patch: string, opts: { reverse?: boolean } = {}): string | undefined {
  const hunks = parseHunks(patch);
  if (hunks.length === 0) return content;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.length === 0 ? [] : content.replace(/\r\n/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop();

  const from = opts.reverse ? "+" : "-";
  const to = opts.reverse ? "-" : "+";
  const out: string[] = [];
  let cursor = 0;
  let endsWithoutNewline = !hadTrailingNewline && content.length > 0;

  for (const h of hunks) {
    const expected: string[] = [];
    const replacement: string[] = [];
    let replacementNoNewline = false;
    for (const raw of h.lines) {
      const noNl = raw.endsWith("\u0000");
      const text = (noNl ? raw.slice(0, -1) : raw).slice(1);
      const kind = raw[0];
      if (kind === " " || kind === from) expected.push(text);
      if (kind === " " || kind === to) {
        replacement.push(text);
        replacementNoNewline = noNl;
      }
    }
    const start = (opts.reverse ? h.newStart : h.oldStart) - (expected.length === 0 ? 0 : 1);
    const at = findMatch(lines, expected, Math.max(start, cursor), cursor);
    if (at === undefined) return undefined;
    out.push(...lines.slice(cursor, at), ...replacement);
    cursor = at + expected.length;
    if (cursor >= lines.length) endsWithoutNewline = replacementNoNewline;
  }
  out.push(...lines.slice(cursor));
  if (out.length === 0) return "";
  return out.join(eol) + (endsWithoutNewline ? "" : eol);
}

function findMatch(lines: string[], expected: string[], preferred: number, min: number): number | undefined {
  const matches = (at: number) => {
    if (at < min || at + expected.length > lines.length) return false;
    for (let i = 0; i < expected.length; i++) if (lines[at + i] !== expected[i]) return false;
    return true;
  };
  if (matches(preferred)) return preferred;
  for (let delta = 1; delta < lines.length + 1; delta++) {
    if (matches(preferred - delta)) return preferred - delta;
    if (matches(preferred + delta)) return preferred + delta;
  }
  return undefined;
}

function appendHunkLines(hunks: ReturnType<typeof parseHunks>, before: string[], after: string[]): void {
  for (const h of hunks) {
    for (const raw of h.lines) {
      const text = (raw.endsWith("\u0000") ? raw.slice(0, -1) : raw).slice(1);
      if (raw[0] !== "+") before.push(text);
      if (raw[0] !== "-") after.push(text);
    }
  }
}

/**
 * Builds the two sides of a diff from the changed hunks only (plus their context), with a header
 * per file. Feeding these to a native diff editor shows just the modifications, never whole files.
 */
export function hunksSides(files: Array<{ file: string; patch: string }>): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const { file, patch } of files) {
    const hunks = parseHunks(patch);
    if (hunks.length === 0) continue;
    const header = `===== ${file} =====`;
    before.push(header);
    after.push(header);
    appendHunkLines(hunks, before, after);
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

/** Best-effort "old" and "new" text when no file content is available (e.g. deleted files). */
export function sidesFromPatch(patch: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  appendHunkLines(parseHunks(patch), before, after);
  return { before: before.join("\n"), after: after.join("\n") };
}
