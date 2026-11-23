import type { ToolContent } from "./api";

/** Plain-text rendering of one tool output item, used by the chat, export and search. */
export function toolOutputLabel(content: ToolContent): string {
  return content.type === "text" ? content.text : `[${content.mime}] ${content.name ?? content.uri}`;
}
