import type {
  AgentInfo,
  CommandSuggestion,
  FileDiff,
  FormRequest,
  FormValue,
  ModelInfo,
  ModelRef,
  PermissionDecision,
  PermissionRequest,
  SkillSuggestion,
  ServerEvent,
  SessionMessage,
  TokenUsage,
} from "./api";
import type { Compatibility } from "./compatibility";
import type { ContractReport } from "./contract";
import type { Strings } from "./strings";

export type ConnectionStatus = "idle" | "starting" | "connected" | "reconnecting" | "error";

export type UiErrorKind =
  | "notInstalled"
  | "startFailed"
  | "unauthorized"
  | "noProvider"
  | "connectionLost"
  | "promptFailed"
  | "noWorkspace"
  | "requestFailed";

export type ActionId =
  | "reconnect"
  | "showLogs"
  | "openSettings"
  | "install"
  | "login"
  | "setPassword"
  | "openFolder"
  | "newSession";

/** Identifies the inline card a failed reply belongs to, so it can re-enable its buttons. */
export interface ReplyTarget {
  kind: "permission" | "form";
  id: string;
}

export interface UiError {
  kind: UiErrorKind;
  message: string;
  detail?: string;
  actions: ActionId[];
  /** Set when the error came from replying to an inline card (see webview/replyFeedback). */
  target?: ReplyTarget;
}

export interface SessionSummary {
  id: string;
  title: string;
  updated: number;
  busy: boolean;
  /** A permission request or a question is waiting for the user to answer. */
  needsInput: boolean;
}

export interface ContextItem {
  id: string;
  kind: "file" | "selection";
  uri: string;
  label: string;
  detail?: string;
}

export interface Attachment {
  uri: string;
  name: string;
  kind: "file" | "selection";
  detail?: string;
}

/** A file dragged into the chat from the OS or from another VS Code view. */
export interface DroppedFile {
  name: string;
  /** `file://` URI supplied by the drag source, when available. */
  uri?: string;
  /** Absolute local path supplied by Electron's `File.path`, when available. */
  path?: string;
  /** Base64 content, used only when the drag source exposes no path. */
  base64?: string;
  /** MIME type of the content, from the dropped `File.type`. */
  mime?: string;
}

export interface FolderInfo {
  uri: string;
  name: string;
}

export interface SessionPayload {
  id: string;
  title?: string;
  agent?: string;
  model?: ModelRef;
  busy: boolean;
  messages: SessionMessage[];
  permissions: PermissionRequest[];
  forms: FormRequest[];
  usage?: { cost: number; tokens: TokenUsage };
}

/**
 * Tail of a session after an SSE reconnect. Unlike `session`, it is merged into the existing
 * conversation instead of rebuilding it, so scroll position, staged attachments and the draft
 * survive a resync that found no changes (or only new messages).
 */
export interface SessionDelta {
  sessionId: string;
  messages: SessionMessage[];
  permissions?: PermissionRequest[];
  forms?: FormRequest[];
  usage?: SessionPayload["usage"];
  busy?: boolean;
  title?: string;
  agent?: string;
  model?: ModelRef;
}

export type HostMessage =
  | {
      type: "init";
      strings: Strings;
      platform: "mac" | "windows" | "linux";
      folders: FolderInfo[];
      activeFolder?: string;
      issuesUrl?: string;
    }
  | {
      type: "connection";
      status: ConnectionStatus;
      error?: UiError;
      version?: string;
      compatibility?: Compatibility;
      /** The user already dismissed the compatibility warning for this server version. */
      compatibilityDismissed?: boolean;
      /** Result of the runtime contract smoke test (which features the server really supports). */
      contract?: ContractReport;
      contractDismissed?: boolean;
    }
  | {
      type: "catalog";
      models: ModelInfo[];
      agents: AgentInfo[];
      skills: SkillSuggestion[];
      /** Slash commands; optional so older hosts/messages without them still render. */
      commands?: CommandSuggestion[];
      selectedModel?: ModelRef;
      selectedAgent?: string;
    }
  | { type: "sessions"; items: SessionSummary[]; currentId?: string; hasMore?: boolean }
  | { type: "session"; session: SessionPayload | null }
  | { type: "sessionDelta"; delta: SessionDelta }
  | { type: "event"; event: ServerEvent }
  | { type: "context"; items: ContextItem[] }
  | { type: "fileResults"; query: string; items: Attachment[] }
  | { type: "addAttachment"; item: Attachment }
  | { type: "changedFiles"; files: FileDiff[] }
  | { type: "autoApprove"; enabled: boolean }
  | { type: "focusInput" }
  | { type: "notice"; error: UiError };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; attachments: Attachment[]; context: ContextItem[] }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "newSession" }
  | { type: "selectSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "renameSession"; id: string; title: string }
  | { type: "refreshSessions" }
  | { type: "loadMoreSessions" }
  | { type: "setModel"; model: ModelRef }
  | { type: "setAgent"; agent: string }
  | { type: "setAutoApprove"; enabled: boolean }
  | { type: "permissionReply"; sessionId: string; requestId: string; decision: PermissionDecision }
  | { type: "formReply"; sessionId: string; formId: string; answer: Record<string, FormValue> }
  | { type: "formCancel"; sessionId: string; formId: string }
  | { type: "searchFiles"; query: string }
  | { type: "dropFiles"; files: DroppedFile[] }
  | { type: "pickFiles" }
  | { type: "openDiff"; file: string; patch: string; applied: boolean }
  | { type: "openFile"; path: string }
  | { type: "openLink"; href: string }
  | { type: "copy"; text: string }
  | { type: "action"; id: ActionId }
  | { type: "selectFolder"; uri: string }
  | { type: "refreshChanges" }
  | { type: "dismissCompatibility"; version: string }
  | { type: "dismissContract"; signature: string };
