import type { CommandSuggestion, SkillSuggestion } from "../../shared/api";
import type { Attachment, PromptDefinition } from "../../shared/protocol";

export const FILE_MENTION_RE = /(^|\s)@([^\s@]*)$/;
export const SKILL_COMMAND_RE = /(^|\s)\/([^\s/]*)$/;
const COMMAND_TOKEN_RE = /(^|\s)\/([^\s/]+)/g;

type TokenRange = { start: number; end: number };

/** Ranges of `/name` tokens that match an actual command or skill in the catalog. */
export function commandTokenRanges(text: string, names: Set<string>): TokenRange[] {
  const ranges: TokenRange[] = [];
  for (const match of text.matchAll(COMMAND_TOKEN_RE)) {
    if (!names.has(match[2])) continue;
    const slash = (match.index ?? 0) + match[1].length;
    ranges.push({ start: slash, end: slash + match[2].length + 1 });
  }
  return ranges;
}

export type MentionItem =
  | { kind: "file"; item: Attachment }
  | { kind: "skill"; item: SkillSuggestion }
  | { kind: "command"; item: CommandSuggestion }
  | { kind: "prompt"; item: PromptDefinition };
export type Mention = { query: string; start: number; kind: "file" | "skill" };
