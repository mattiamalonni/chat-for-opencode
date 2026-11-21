import type {
  AgentInfo,
  CommandSuggestion,
  FileDiff,
  FormRequest,
  FormValue,
  InboxDelivery,
  InboxItem,
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
  | "untrustedWorkspace"
  | "requestFailed";

export type ActionId =
  | "reconnect"
  | "showLogs"
  | "openSettings"
  | "install"
  | "login"
  | "setPassword"
  | "openFolder"
  | "trustWorkspace"
  | "newSession"
  | "retry";

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

/** A file icon resolved from the user's active VS Code file icon theme. */
export type FileIconData =
  | { kind: "svg"; src: string }
  | { kind: "font"; fontFamily: string; glyph: string; color?: string; size?: string };

/** A glyph font used by one or more resolved icons, ready to be registered in the webview. */
export interface FileIconFont {
  family: string;
  /** `data:font/woff;base64,...` */
  src: string;
  format: string;
  weight?: string;
  style?: string;
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

/**
 * A child session spawned by the `subagent` tool of the session currently shown in the chat.
 * The host fetches its history once on discovery; live updates arrive as `subagentEvent` messages.
 */
export interface SubagentSnapshot {
  sessionId: string;
  parentId?: string;
  title?: string;
  agent?: string;
  messages: SessionMessage[];
  permissions: PermissionRequest[];
  forms: FormRequest[];
  busy: boolean;
}

export type HostMessage =
  | {
      type: "init";
      strings: Strings;
      platform: "mac" | "windows" | "linux";
      folders: FolderInfo[];
      activeFolder?: string;
      issuesUrl?: string;
      /** Whether drag & drop of files into the chat is enabled (defaults to true). */
      dropzone?: boolean;
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
  /** Initial history of a subagent's child session, so its view survives a reconnect. */
  | { type: "subagent"; snapshot: SubagentSnapshot }
  /** Live event belonging to a subagent's child session (not the one shown in the chat). */
  | { type: "subagentEvent"; sessionId: string; event: ServerEvent }
  | { type: "context"; items: ContextItem[] }
  /** Icons requested by the webview, keyed by the exact path it asked for. */
  | { type: "fileIcons"; icons: Record<string, FileIconData | null>; fonts: Record<string, FileIconFont>; reset?: boolean }
  | { type: "fileResults"; query: string; items: Attachment[] }
  | { type: "addAttachment"; item: Attachment }
  | { type: "changedFiles"; files: FileDiff[] }
  /** Prompts waiting in the server's inbox for the current session. */
  | { type: "inbox"; items: InboxItem[] }
  /** A session was forked from a turn and is now the open conversation. */
  | { type: "forked"; sessionId: string; title?: string }
  | { type: "autoApprove"; enabled: boolean }
  /** Dropzone setting changed at runtime; lets the webview rebind drag & drop listeners live. */
  | { type: "dropzone"; enabled: boolean }
  /** Drafts restored from workspaceState on webview startup (vscode.setState alone dies on reload). */
  | { type: "drafts"; drafts: Record<string, string>; globalDraft?: string }
  /**
   * A prompt that failed to reach the server goes back into the composer. The composer only accepts
   * it while empty (`force` is used after a successful retry), so newer typing is never overwritten.
   */
  | { type: "draftRestored"; sessionId?: string; text: string; force?: boolean }
  | { type: "focusInput" }
  /** Editor context actions: fill the composer with an intent and attach the current selection. */
  | { type: "prefillDraft"; sessionId?: string; text: string; attachments: Attachment[] }
  /** A turn was rolled back; its prompt goes back into the composer so it can be edited and resent. */
  | { type: "reverted"; sessionId: string; text: string }
  /** Sent after a manual sync completes, so the header button can leave its busy state. */
  | { type: "synced" }
  | { type: "notice"; error: UiError };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; attachments: Attachment[]; context: ContextItem[]; delivery?: "steer" | "queue" }
  | { type: "abort" }
  | { type: "compact" }
  /** Roll the conversation back to the turn opened by `messageID` and restore its prompt. */
  | { type: "revertTo"; sessionId: string; messageID: string; text: string }
  /** Create a new session with history up to `messageID`, keeping this one untouched. */
  | { type: "forkTo"; sessionId: string; messageID: string }
  /** Drop the reply after this prompt (keeping files) and immediately resend the same prompt. */
  | {
      type: "regenerate";
      sessionId: string;
      messageID: string;
      text: string;
      attachments: Attachment[];
    }
  | { type: "newSession" }
  | { type: "selectSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "deleteAllSessions" }
  | { type: "renameSession"; id: string; title: string }
  | { type: "refreshSessions" }
  | { type: "loadMoreSessions" }
  | { type: "setModel"; model: ModelRef }
  | { type: "setAgent"; agent: string }
  | { type: "setAutoApprove"; enabled: boolean }
  | { type: "saveDraft"; sessionId?: string; text: string }
  | { type: "permissionReply"; sessionId: string; requestId: string; decision: PermissionDecision }
  /** Switch a queued prompt between interrupt-and-send (`steer`) and wait-behind (`queue`). */
  | { type: "setInboxDelivery"; sessionId: string; inboxId: string; delivery: InboxDelivery }
  /** Drop a queued prompt from the server's inbox. */
  | { type: "cancelInbox"; sessionId: string; inboxId: string }
  | { type: "formReply"; sessionId: string; formId: string; answer: Record<string, FormValue> }
  | { type: "formCancel"; sessionId: string; formId: string }
  | { type: "searchFiles"; query: string }
  /** Lazily request theme icons for file paths the webview is about to render. */
  | { type: "fileIcons"; paths: string[] }
  | { type: "dropFiles"; files: DroppedFile[] }
  | { type: "pickFiles" }
  | { type: "openDiff"; file: string; patch: string; applied: boolean }
  /** Show all the patches of a turn in one read-only VS Code diff view (virtual documents only). */
  | { type: "openDiffs"; files: Array<{ file: string; patch: string }> }
  | { type: "openFile"; path: string }
  /** Opens an inline attachment's on-disk copy; the host only accepts files it created itself. */
  | { type: "openAttachment"; uri: string }
  | { type: "openLink"; href: string }
  | { type: "copy"; text: string }
  | { type: "action"; id: ActionId }
  | { type: "selectFolder"; uri: string }
  | { type: "refreshChanges" }
  /** Manual sync from the header: re-read the conversation from the server. */
  | { type: "sync" }
  /** Re-fetch a subagent's child history when its card is expanded without live data. */
  | { type: "refreshSubagent"; sessionId: string }
  | { type: "dismissCompatibility"; version: string }
  | { type: "dismissContract"; signature: string };
