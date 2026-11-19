/** Shared parser for the `<subagent>` wrapper used by tool results and background notifications. */
export interface SubagentReport {
  sessionId: string;
  state?: string;
  description?: string;
  report: string;
}

/**
 * Both the (foreground) tool result and the (background) completion notification wrap the child's
 * final answer in `<subagent sessionID="…" state="…">…</subagent>`. Parsing it lets the card show
 * the report even when the child session's live events were missed or arrived after the parent turn.
 */
export function parseSubagentReport(text: string | undefined): SubagentReport | undefined {
  if (!text) return undefined;
  const match = /<subagent\s+sessionID="([^"]+)"([^>]*)>([\s\S]*?)<\/subagent>/i.exec(text);
  if (!match) return undefined;
  const attr = (name: string) => new RegExp(`${name}="([^"]*)"`, "i").exec(match[2])?.[1];
  return {
    sessionId: match[1],
    state: attr("state"),
    description: attr("description"),
    report: match[3].trim(),
  };
}
