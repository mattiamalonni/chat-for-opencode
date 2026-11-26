/**
 * Parser for the `<background-result>` wrapper OpenCode emits when a background job (a shell
 * command, a subagent, a codemode script…) finishes. The chat used to show the raw XML as a notice;
 * this turns it into a compact card instead.
 *
 * The shell renderer does not XML-escape quotes inside the `command` attribute, so the naive
 * `(\w+)="([^"]*)"` parser truncates the command at its first inner quote. Attribute values are
 * therefore read up to the next `name="` pair (or the end of the opening tag), and the opening tag
 * itself is located with a quote-aware scan so a `>` inside a command cannot end it early.
 */

export interface BackgroundResult {
  kind: string;
  /** Shell job id or script id, used to match the result with the tool that started it. */
  id?: string;
  sessionId?: string;
  state: string;
  command?: string;
  description?: string;
  /** Last meaningful output line, suitable for a one-line card. */
  summary: string;
  /** Full output, kept for an expandable details view. */
  output: string;
}

const OPEN = "<background-result";
const CLOSE = "</background-result>";
const ATTR = /([A-Za-z][\w-]*)="([\s\S]*?)"(?=\s+[A-Za-z][\w-]*="|>|$)/g;
const MAX_SUMMARY = 200;

function openingTagEnd(text: string, start: number): number {
  let inQuote = false;
  for (let i = start + OPEN.length; i < text.length; i++) {
    const char = text[i];
    if (char === '"') inQuote = !inQuote;
    else if (char === ">" && !inQuote) return i;
  }
  return -1;
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

function summaryOf(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  return last.length > MAX_SUMMARY ? `${last.slice(0, MAX_SUMMARY - 1)}…` : last;
}

/** Parse the first `<background-result>` in a synthetic message, if present. */
export function parseBackgroundResult(text: string | undefined, description?: string): BackgroundResult | undefined {
  if (!text) return undefined;
  const start = text.indexOf(OPEN);
  if (start === -1) return undefined;
  const openEnd = openingTagEnd(text, start);
  const close = openEnd === -1 ? -1 : text.indexOf(CLOSE, openEnd + 1);
  if (openEnd === -1 || close === -1) return undefined;

  const attrs: Record<string, string> = {};
  for (const match of text.slice(start + OPEN.length, openEnd).matchAll(ATTR)) attrs[match[1]] = decode(match[2]);
  const output = decode(text.slice(openEnd + 1, close)).trim();
  return {
    kind: attrs.kind ?? "unknown",
    id: attrs.id,
    sessionId: attrs.sessionID,
    state: attrs.state ?? "completed",
    // The history adapter keeps the full command in `description`; the live inbox item only has
    // the XML. Prefer the attribute so an already-decoded command wins over a truncated copy.
    command: attrs.command || description,
    description,
    summary: summaryOf(output),
    output,
  };
}

/** States that should be presented as a failure rather than a quiet completion. */
export function backgroundFailed(result: BackgroundResult): boolean {
  return /fail|error|cancel|timeout|abort/i.test(result.state);
}
