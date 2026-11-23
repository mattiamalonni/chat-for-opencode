import type { WorkingDiff } from "./gitDiff";

/**
 * Snapshot formatters for the `$diff` and `$problems` prompt variables. They are resolved into the
 * prompt text itself — there is no chip, no protocol message and no data URI involved.
 */
const MAX_PROMPT_CONTEXT = 12_000;
const SEVERITY = ["Error", "Warning", "Information", "Hint"];

export interface PromptDiagnostic {
  uri: string;
  startLine: number;
  message: string;
  severity: number;
}

function cap(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PROMPT_CONTEXT) return trimmed;
  return `${trimmed.slice(0, MAX_PROMPT_CONTEXT)}\n… truncated (${trimmed.length - MAX_PROMPT_CONTEXT} more characters)`;
}

export function formatPromptDiff(diff: WorkingDiff): string {
  const note = diff.truncated ? "\n(diff truncated)" : "";
  const untracked = diff.untracked.length > 0 ? `\nUntracked files: ${diff.untracked.join(", ")}` : "";
  return cap(`${diff.diff || "(no tracked changes)"}${note}${untracked}`);
}

export function formatPromptDiagnostics(items: readonly PromptDiagnostic[]): string {
  const text =
    items.length === 0
      ? "No diagnostics reported for the active file."
      : items
          .slice(0, 40)
          .map((d) => `- ${SEVERITY[d.severity] ?? "Diagnostic"} at ${d.uri}:${d.startLine + 1}: ${d.message.replace(/\s+/g, " ").trim()}`)
          .join("\n");
  return cap(text);
}
