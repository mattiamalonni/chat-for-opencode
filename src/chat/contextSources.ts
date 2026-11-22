import type * as vscode from "vscode";
import type { ContextItem, ContextSource, ContextSourceId } from "../shared/protocol";
import { workingDiff, type WorkingDiff } from "./gitDiff";

/**
 * Content-based context chips.
 *
 * The existing `ContextItem` carries a URI, and `resolveAttachment` passes any non-`file:` URI
 * straight to OpenCode. We therefore serialize diagnostics, the working-tree diff, terminal output
 * and symbol locations as small inline `data:text/markdown` URIs: no new prompt format, no server
 * round-trip, and the same token estimate the webview already uses for pasted files.
 */

/** Base64 stays well below the 32k URI cap enforced by `isContextItem`. */
export const MAX_CONTEXT_CONTENT = 12_000;

/** Terminal output is bounded: a long build log must not flood the prompt. */
export const MAX_TERMINAL_OUTPUT = 8_000;
// Built from a string so the ESC byte is not a control character in a regex literal.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

export function appendOutput(previous: string, chunk: string, max = MAX_TERMINAL_OUTPUT): string {
  const next = previous + stripAnsi(chunk);
  return next.length <= max ? next : next.slice(-max);
}

export interface DiagnosticLike {
  uri: string;
  startLine: number;
  message: string;
  severity: number;
}

export interface SymbolLike {
  name: string;
  uri: string;
  line: number;
}

export interface EditorLike {
  path: string;
  line?: number;
}

export interface TerminalLike {
  command?: string;
  text: string;
}

export function truncateContent(content: string, max = MAX_CONTEXT_CONTENT): string {
  const text = content.trim();
  return text.length <= max ? text : `${text.slice(0, max)}\n… truncated (${text.length - max} more characters)`;
}

/** Builds a chip whose URI carries its own content, so the host can send it as an inline attachment. */
export function inlineContext(kind: ContextSourceId, label: string, content: string, detail?: string): ContextItem {
  const text = truncateContent(content) || "(no content)";
  const uri = `data:text/markdown;base64,${Buffer.from(text, "utf8").toString("base64")}`;
  return { id: `context:${kind}`, kind, uri, label, detail };
}

const SEVERITY = ["Error", "Warning", "Information", "Hint"];

/** Reads back the Markdown carried by an inline context chip, for `$diff` / `$problems`. */
export function decodeContextContent(uri: string): string {
  const comma = uri.indexOf(",");
  if (comma < 0) return "";
  try {
    return Buffer.from(uri.slice(comma + 1), "base64").toString("utf8");
  } catch {
    return "";
  }
}

export function formatDiagnostics(items: DiagnosticLike[]): string {
  if (items.length === 0) return "No diagnostics reported for the active file.";
  return items
    .slice(0, 40)
    .map((d) => {
      const level = SEVERITY[d.severity] ?? "Diagnostic";
      return `- ${level} at ${d.uri}:${d.startLine + 1}: ${d.message.replace(/\s+/g, " ").trim()}`;
    })
    .join("\n");
}

export function formatSymbols(items: SymbolLike[]): string {
  if (items.length === 0) return "No symbol definition found at the cursor.";
  return items
    .slice(0, 20)
    .map((s) => `- ${s.name} — ${s.uri}:${s.line + 1}`)
    .join("\n");
}

export function formatOpenEditors(items: EditorLike[]): string {
  if (items.length === 0) return "No editors are open.";
  return items
    .slice(0, 20)
    .map((e) => (e.line === undefined ? `- ${e.path}` : `- ${e.path}:${e.line + 1}`))
    .join("\n");
}

export function formatTerminal(snapshot: TerminalLike): string {
  const command = snapshot.command ? `$ ${snapshot.command}\n` : "";
  return `${command}${snapshot.text.trim()}` || "The terminal has no output yet.";
}

export function formatDiff(diff: WorkingDiff): string {
  const note = diff.truncated ? "\n(diff truncated)" : "";
  const untracked = diff.untracked.length > 0 ? `\nUntracked files: ${diff.untracked.join(", ")}` : "";
  return `${diff.diff || "(no tracked changes)"}${note}${untracked}`;
}

/** English source labels; the host passes each through `vscode.l10n.t`. */
export const CONTEXT_SOURCE_TEXT = {
  problems: ["Problems", "Diagnostics for the active file (errors and warnings)"],
  git: ["Git diff", "Uncommitted changes in this workspace"],
  terminal: ["Terminal", "Output of the last terminal command"],
  openEditors: ["Open editors", "Paths of the editors currently open"],
  symbol: ["Symbol at cursor", "Definitions of the symbol under the cursor"],
} as const satisfies Record<ContextSourceId, readonly [string, string]>;

export function contextSourceCatalog(t: (text: string) => string): ContextSource[] {
  return (Object.keys(CONTEXT_SOURCE_TEXT) as ContextSourceId[]).map((id) => {
    const [label, description] = CONTEXT_SOURCE_TEXT[id];
    return { id, label: t(label), description: t(description) };
  });
}

/** Everything the service needs from VS Code, injected so pure logic stays unit-testable. */
export interface ContextSourceHooks {
  t: (text: string) => string;
  folder: () => vscode.Uri | undefined;
  activeEditor: () => vscode.TextEditor | undefined;
  visibleEditors: () => readonly vscode.TextEditor[];
  diagnostics: () => readonly { uri: vscode.Uri; diagnostic: vscode.Diagnostic }[];
  symbolsAt: (editor: vscode.TextEditor) => Promise<SymbolLike[]>;
  gitDiff: (cwd: string) => Promise<WorkingDiff | undefined>;
  terminal: () => TerminalLike | undefined;
}

export class ContextSourceService {
  constructor(private readonly hooks: ContextSourceHooks) {}

  catalog(): ContextSource[] {
    return contextSourceCatalog(this.hooks.t);
  }

  async build(source: ContextSourceId): Promise<ContextItem | undefined> {
    const [label] = CONTEXT_SOURCE_TEXT[source];
    const t = this.hooks.t;
    switch (source) {
      case "problems": {
        const editor = this.hooks.activeEditor();
        const file = editor?.document.uri.toString();
        const all = this.hooks.diagnostics();
        const items = all
          .filter((d) => (file ? d.uri.toString() === file : true))
          .slice(0, 40)
          .map((d) => ({
            uri: d.uri.path,
            startLine: d.diagnostic.range.start.line,
            message: d.diagnostic.message,
            severity: d.diagnostic.severity,
          }));
        return inlineContext(source, t(label), formatDiagnostics(items), t("Diagnostics for the active file"));
      }
      case "git": {
        const cwd = this.hooks.folder()?.fsPath;
        if (!cwd) return undefined;
        const diff = await this.hooks.gitDiff(cwd);
        if (!diff) return undefined;
        return inlineContext(source, t(label), formatDiff(diff), t("Uncommitted changes"));
      }
      case "terminal": {
        const snapshot = this.hooks.terminal();
        if (!snapshot || !snapshot.text.trim()) return undefined;
        return inlineContext(source, t(label), formatTerminal(snapshot), t("Last command output"));
      }
      case "openEditors": {
        const items = this.hooks
          .visibleEditors()
          .filter((e) => e.document.uri.scheme === "file")
          .map((e) => ({ path: e.document.uri.fsPath, line: e.selection.start.line }));
        return inlineContext(source, t(label), formatOpenEditors(items), t(`${items.length} open editors`));
      }
      case "symbol": {
        const editor = this.hooks.activeEditor();
        if (!editor || editor.document.uri.scheme !== "file") return undefined;
        const symbols = await this.hooks.symbolsAt(editor);
        if (symbols.length === 0) return undefined;
        return inlineContext(source, t(label), formatSymbols(symbols), t("Symbol definitions"));
      }
    }
  }
}

/** Pure re-export for callers that already have a working-tree diff. */
export { workingDiff };
