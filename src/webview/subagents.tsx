import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ChatState } from "../shared/chatReducer";
import type { SubagentMeta } from "../shared/subagents";

export interface SubagentEntry {
  state: ChatState;
  meta: SubagentMeta;
}

/** The subagent cards read their child session from context, so no prop threading is needed. */
export const SubagentsContext = createContext<Record<string, SubagentEntry>>({});

export function useSubagent(sessionId?: string): SubagentEntry | undefined {
  const entries = useContext(SubagentsContext);
  return sessionId ? entries[sessionId] : undefined;
}

/**
 * Cards (including the ones rendered inside the subagent modal) ask the host app to open a child
 * conversation. A context keeps this out of the deep `Conversation → MessageView → ToolCard` chain.
 */
export type OpenSubagent = (sessionId: string, label?: string) => void;

export const SubagentNavContext = createContext<OpenSubagent>(() => {});

export function useOpenSubagent(): OpenSubagent {
  return useContext(SubagentNavContext);
}
