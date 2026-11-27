/**
 * Prompt-library variables (`$selection`, `$file`, `$diff`, `$problems`). A library prompt keeps them
 * as written in the composer and the host fills them when the message is sent, so they reflect the
 * editor and working tree at that moment. Shared by the host (resolution) and the webview
 * (highlighting the tokens that will be filled).
 */
export const PROMPT_VARIABLES = ["selection", "file", "diff", "problems"] as const;
export type PromptVariable = (typeof PROMPT_VARIABLES)[number];

/** Global regex: reset `lastIndex` (or use `matchAll`/`replace`) when reusing it. */
export const PROMPT_VARIABLE_RE = /\$(selection|file|diff|problems)\b/g;

export function hasPromptVariables(text: string): boolean {
  return new RegExp(PROMPT_VARIABLE_RE.source).test(text);
}

/** Start/end offsets of every variable token, for the composer highlight. */
export function promptVariableRanges(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(PROMPT_VARIABLE_RE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}
