import type * as vscode from "vscode";

export const FIX_DIAGNOSTIC_COMMAND = "opencode.fixDiagnostic";
export const EXPLAIN_DIAGNOSTIC_COMMAND = "opencode.explainDiagnostic";

/**
 * Plain, serializable arguments for the two diagnostic commands. The host turns the URI back into
 * a document and selects the offending lines before prefilling the composer.
 */
export interface DiagnosticCommandArgs {
  uri: string;
  /** 1-based line numbers, inclusive. */
  startLine: number;
  endLine: number;
  message: string;
  /** Numeric `vscode.DiagnosticSeverity`, mapped to a word by the command. */
  severity: number;
}

export interface CodeActionHooks<T> {
  t: (message: string) => string;
  /** Builds the host's native action object; injected so the logic stays testable in plain Node. */
  create: (title: string, command: string, args: DiagnosticCommandArgs, preferred: boolean) => T;
}

/** A lightbulb full of duplicate fixes helps nobody. */
const MAX_DIAGNOSTICS = 3;
const MAX_MESSAGE_CHARS = 300;
const MAX_TITLE_CHARS = 70;

function overlaps(range: vscode.Range, diagnostic: vscode.Diagnostic): boolean {
  return diagnostic.range.end.line >= range.start.line && diagnostic.range.start.line <= range.end.line;
}

function shortMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
  return firstLine.length > MAX_TITLE_CHARS ? `${firstLine.slice(0, MAX_TITLE_CHARS - 1)}…` : firstLine;
}

/**
 * Pulls the diagnostics that intersect an editor range into Quick Fixes that hand the offending
 * code and the diagnostic message to the chat. Kept free of `vscode` values (only types) so it can
 * be unit tested without an extension host; the host supplies the constructor through `hooks.create`.
 */
export function diagnosticCodeActions<T>(
  document: vscode.TextDocument,
  range: vscode.Range,
  diagnostics: readonly vscode.Diagnostic[],
  hooks: CodeActionHooks<T>,
): T[] {
  if (document.uri.scheme !== "file") return [];

  const byPosition = new Map<string, vscode.Diagnostic>();
  for (const diagnostic of diagnostics) {
    if (!overlaps(range, diagnostic)) continue;
    // Two language servers often report the same problem on the same line with slightly different
    // columns; collapsing by line + message avoids a lightbulb full of identical fixes.
    const key = `${diagnostic.range.start.line}:${diagnostic.message}`;
    if (!byPosition.has(key)) byPosition.set(key, diagnostic);
  }

  const actions: T[] = [];
  for (const diagnostic of [...byPosition.values()].slice(0, MAX_DIAGNOSTICS)) {
    const args: DiagnosticCommandArgs = {
      uri: document.uri.toString(),
      startLine: diagnostic.range.start.line + 1,
      endLine: diagnostic.range.end.line + 1,
      message: diagnostic.message.slice(0, MAX_MESSAGE_CHARS),
      severity: diagnostic.severity,
    };
    const label = shortMessage(args.message);
    actions.push(hooks.create(`${hooks.t("Fix with OpenCode")}: ${label}`, FIX_DIAGNOSTIC_COMMAND, args, true));
    actions.push(hooks.create(`${hooks.t("Explain with OpenCode")}: ${label}`, EXPLAIN_DIAGNOSTIC_COMMAND, args, false));
  }
  return actions;
}
