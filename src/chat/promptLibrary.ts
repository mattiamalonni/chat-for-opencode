import type { PromptDefinition } from "../shared/protocol";

/**
 * A small, reusable prompt library: curated prompts ship with the extension and users can add their
 * own in `opencode.promptLibrary`. Selecting one prefills the composer with `$variables` resolved
 * from the current editor, working-tree diff and diagnostics — it never sends on its own.
 */

export const PROMPT_VARIABLES = ["selection", "file", "diff", "problems"] as const;
export type PromptVariable = (typeof PROMPT_VARIABLES)[number];

const VARIABLE_RE = /\$(selection|file|diff|problems)\b/g;

/** Pure and deterministic: an unknown or empty variable resolves to an empty string. */
export function resolvePromptVariables(text: string, values: Partial<Record<PromptVariable, string>>): string {
  return text.replace(VARIABLE_RE, (_match, name: PromptVariable) => values[name] ?? "");
}

/** English source strings; the host runs each through `vscode.l10n.t`. */
const CURATED: ReadonlyArray<{ id: string; title: string; description: string; text: string }> = [
  {
    id: "explain",
    title: "Explain this file",
    description: "Summarise what the active file does and call out non-obvious logic",
    text: "Explain `$file` in detail. Describe its responsibilities, the main data flow and anything non-obvious a new contributor should know.",
  },
  {
    id: "tests",
    title: "Write tests",
    description: "Create unit tests for the active file, including edge cases",
    text: "Write thorough unit tests for `$file`. Cover the happy path, edge cases and error handling, following the testing conventions already used in this project.",
  },
  {
    id: "bugs",
    title: "Find bugs in the selection",
    description: "Review the selected code for concrete defects",
    text: "Review this code for bugs and report concrete issues with a line reference and a suggested fix for each:\n\n$selection",
  },
  {
    id: "optimize",
    title: "Optimize the selection",
    description: "Improve readability and performance of the selected code",
    text: "Optimize the following code for readability and performance without changing its behaviour. Explain every change:\n\n$selection",
  },
  {
    id: "document",
    title: "Document this file",
    description: "Add concise comments and docstrings where they help",
    text: "Add concise documentation to `$file`, focusing on public APIs and non-obvious decisions. Do not restate what the code already says clearly.",
  },
  {
    id: "review",
    title: "Review uncommitted changes",
    description: "Review the working-tree diff for bugs and risks",
    text: "Review these uncommitted changes for bugs, regressions and security issues. Report findings with file and line references:\n\n$diff",
  },
  {
    id: "problems",
    title: "Fix diagnostics",
    description: "Fix the errors and warnings reported by the editor",
    text: "Fix these diagnostics in the workspace and explain each fix:\n\n$problems",
  },
  {
    id: "commit",
    title: "Write a commit message",
    description: "Draft a Conventional Commit message from the working-tree diff",
    text: "Write a single Conventional Commit message for these changes (type, optional scope, short imperative subject). Return only the message line:\n\n$diff",
  },
];

/** Drops malformed settings entries before they can reach the webview protocol. */
function normalizeUserPrompts(
  items: ReadonlyArray<{ id?: unknown; title?: unknown; description?: unknown; text?: unknown }>,
): Array<{ id: string; title: string; description?: string; text: string }> {
  return items
    .filter(
      (p): p is { id: string; title: string; description?: string; text: string } =>
        typeof p.id === "string" && !!p.id && typeof p.title === "string" && typeof p.text === "string",
    )
    .map((p) => ({
      id: p.id,
      title: p.title,
      description: typeof p.description === "string" ? p.description : undefined,
      text: p.text,
    }));
}

export interface PromptLibraryHooks {
  t(text: string): string;
  userPrompts(): ReadonlyArray<{ id?: unknown; title?: unknown; description?: unknown; text?: unknown }>;
  selection(): string;
  filePath(): string | undefined;
  diff(): Promise<string>;
  problems(): Promise<string>;
}

export class PromptLibraryService {
  constructor(private readonly hooks: PromptLibraryHooks) {}

  catalog(): PromptDefinition[] {
    const t = this.hooks.t;
    return [
      ...CURATED.map((prompt) => ({
        id: prompt.id,
        title: t(prompt.title),
        description: t(prompt.description),
        text: t(prompt.text),
      })),
      ...normalizeUserPrompts(this.hooks.userPrompts()).map((prompt) => ({
        id: prompt.id,
        title: prompt.title,
        description: prompt.description ?? t("Custom prompt"),
        text: prompt.text,
      })),
    ];
  }

  async resolve(id: string): Promise<string | undefined> {
    const prompt = this.catalog().find((item) => item.id === id);
    if (!prompt) return undefined;
    const h = this.hooks;
    const [diff, problems] = await Promise.all([h.diff(), h.problems()]);
    return resolvePromptVariables(prompt.text, {
      selection: h.selection(),
      file: h.filePath() ?? "",
      diff,
      problems,
    });
  }
}
