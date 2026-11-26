import type {
  FormRequest,
  InboxItem,
  ModelRef,
  PermissionRequest,
  ServerEvent,
  SessionMessage,
  StructuredError,
  TokenUsage,
  ToolContent,
} from "../api";
import type { SessionDelta } from "../protocol";

export type ToolStatus = "streaming" | "running" | "completed" | "error";

export interface TextPart {
  kind: "text" | "reasoning";
  key: string;
  text: string;
  done: boolean;
}

export interface ToolPart {
  kind: "tool";
  key: string;
  id: string;
  name: string;
  status: ToolStatus;
  inputText: string;
  input?: Record<string, unknown>;
  output: ToolContent[];
  metadata?: Record<string, unknown>;
  error?: StructuredError;
}

export type UiPart = TextPart | ToolPart;

export interface UiUserMessage {
  kind: "user";
  id: string;
  created: number;
  text: string;
  files: { uri: string; name?: string }[];
}

export interface UiAssistantMessage {
  kind: "assistant";
  id: string;
  created: number;
  agent: string;
  model?: ModelRef;
  parts: UiPart[];
  done: boolean;
  finish?: string;
  error?: StructuredError;
  retry?: { attempt: number; message: string };
}

export interface UiNotice {
  kind: "notice";
  id: string;
  created: number;
  level: "info" | "warning" | "error";
  code: "interrupted" | "failed" | "agent" | "model" | "compaction" | "synthetic" | "shell" | "backgroundResult" | "other";
  text: string;
  /** Shell job id from a `<background-result>`, used to settle its "waiting" card. */
  shellId?: string;
  command?: string;
  backgroundState?: string;
}

export type UiMessage = UiUserMessage | UiAssistantMessage | UiNotice;

export interface Todo {
  content: string;
  status: string;
}

/** Wall-clock time and summed usage for one user turn: input → end of every step. */
export interface TurnStats {
  /** User message that opened the turn (its inbox id in the live stream). */
  id: string;
  started: number;
  ended?: number;
  /** Sum of the per-step token counts, so tool-using turns include every LLM call. */
  tokens?: TokenUsage;
  cost?: number;
  /** Number of LLM steps in the turn (one assistant message per step). */
  steps?: number;
  /** Model that opened the turn (first step wins), kept for the end-of-turn summary. */
  model?: ModelRef;
  /** Insertions/deletions reported by completed file edits in this turn (per-file, latest patch wins). */
  additions?: number;
  deletions?: number;
  /** The files behind those counts, kept so the stats can open their diffs even after a resync. */
  files?: ChangedFile[];
}

export interface ChatState {
  sessionId: string | null;
  title?: string;
  messages: UiMessage[];
  turns: TurnStats[];
  permissions: PermissionRequest[];
  forms: FormRequest[];
  busy: boolean;
  retry?: { attempt: number; message: string; next?: number };
  lastError?: StructuredError;
  usage?: { cost: number; tokens: TokenUsage };
  /** Estimated tokens in the model context after the last step (undefined until known / after compaction). */
  contextTokens?: number;
  /** Paths reported by completed/failed steps, used to list changes without `/diff` patches. */
  touchedFiles?: string[];
  /** Final reports of background subagents, announced as synthetic messages keyed by child id. */
  subagentReports?: Record<string, string>;
  /** toolId → child session id, for links that arrived before the tool card was rendered. */
  pendingSubagentLinks?: Record<string, string>;
  /** Inbox ids of queued prompts, in delivery order; each opens its own turn at `execution.started`. */
  queuedTurnIds?: string[];
  /** Prompts accepted into the inbox but not delivered yet. Kept out of `messages` until delivery. */
  queuedMessages?: Record<string, UiUserMessage>;
  agent?: string;
  model?: ModelRef;
}

export type ChatAction =
  | {
      type: "load";
      sessionId: string | null;
      title?: string;
      agent?: string;
      model?: ModelRef;
      busy?: boolean;
      messages: SessionMessage[];
      permissions: PermissionRequest[];
      forms: FormRequest[];
      usage?: ChatState["usage"];
    }
  | { type: "append"; delta: SessionDelta }
  | { type: "event"; event: ServerEvent }
  | { type: "events"; events: ServerEvent[] }
  /** Authoritative inbox list from the host; reconciles optimistic queued prompts after a resync. */
  | { type: "inbox"; items: InboxItem[] }
  /** Attach a discovered child id to the still-unlinked `subagent` tool card in the main chat. */
  | { type: "linkSubagent"; sessionId: string; title?: string; toolId?: string }
  | { type: "clearError" };

export const initialChatState: ChatState = {
  sessionId: null,
  messages: [],
  turns: [],
  permissions: [],
  forms: [],
  busy: false,
};
export interface ChangedFile {
  file: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
}
