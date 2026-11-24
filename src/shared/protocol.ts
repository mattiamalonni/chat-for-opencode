import type {
  AgentInfo,
  CommandSuggestion,
  CredentialSummary,
  FileDiff,
  FormRequest,
  FormValue,
  InboxDelivery,
  InboxItem,
  IntegrationInfo,
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

/** Runtime whitelists live next to the types so protocol guards cannot silently drift from them. */
export const UI_ERROR_KINDS = [
  "notInstalled",
  "startFailed",
  "unauthorized",
  "noProvider",
  "connectionLost",
  "promptFailed",
  "noWorkspace",
  "untrustedWorkspace",
  "requestFailed",
] as const;

export const ACTION_IDS = [
  "reconnect",
  "showLogs",
  "openSettings",
  "install",
  "login",
  "setPassword",
  "openFolder",
  "trustWorkspace",
  "newSession",
  "retry",
] as const;

export type UiErrorKind = (typeof UI_ERROR_KINDS)[number];
export type ActionId = (typeof ACTION_IDS)[number];

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

/**
 * A pending request from a session that is neither the open chat nor a tracked subagent — typically
 * a turn started in the TUI on the same server. The webview shows it in the attention panel; the
 * reply uses the `sessionID` already carried by the request, so no new protocol message is needed.
 */
export interface ExternalAttentionItem {
  sessionId: string;
  /** Session title when the picker knows it, so the card says which chat is waiting. */
  label?: string;
  permission?: PermissionRequest;
  question?: FormRequest;
}

export interface SessionSummary {
  id: string;
  title: string;
  updated: number;
  busy: boolean;
  /** A permission request or a question is waiting for the user to answer. */
  needsInput: boolean;
  /** Name of the workspace folder this session belongs to (shown in multi-root workspaces). */
  folder?: string;
}

/** A reusable prompt that can be inserted into the composer with `$variable` placeholders. */
export interface PromptDefinition {
  id: string;
  title: string;
  description: string;
  text: string;
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
  { kind: "svg"; src: string } | { kind: "font"; fontFamily: string; glyph: string; color?: string; size?: string };

/** A glyph font used by one or more resolved icons, ready to be registered in the webview. */
export interface FileIconFont {
  family: string;
  /** `data:font/woff;base64,...` */
  src: string;
  format: string;
  weight?: string;
  style?: string;
}

interface SessionPayload {
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
      /** Characters of tool output shown inline before the "show all" affordance. */
      toolOutputLimit?: number;
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
  /** Pending permissions/questions from other clients on the same server, keyed by request id. */
  | { type: "externalAttention"; items: ExternalAttentionItem[] }
  /**
   * The host saw `metadata.sessionID` on a tool call: link that exact card to the child session.
   * Sent as soon as the tool reports the id, so a card created after the snapshot still gets it.
   */
  | { type: "linkSubagent"; toolId: string; sessionId: string }
  | { type: "context"; items: ContextItem[] }
  /** Built-in and user-defined prompts, shown by `/` in the composer. */
  | { type: "promptCatalog"; items: PromptDefinition[] }
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
  /** Scroll a message into view after a cross-session search jumped to it. */
  | { type: "revealMessage"; messageId: string; sessionId?: string }
  /** Editor context actions: fill the composer with an intent and attach the current selection. */
  | { type: "prefillDraft"; sessionId?: string; text: string; attachments: Attachment[] }
  /** A turn was rolled back; its prompt goes back into the composer so it can be edited and resent. */
  | { type: "reverted"; sessionId: string; text: string }
  /** Sent after a manual sync completes, so the header button can leave its busy state. */
  | { type: "synced" }
  | { type: "notice"; error: UiError };

export type WebviewMessage =
  | { type: "ready" }
  /**
   * `sessionId` addresses a different session than the open one: a subagent typed into from its
   * conversation modal. Omitted means the current chat, so existing callers are unchanged.
   */
  | { type: "send"; text: string; attachments: Attachment[]; context: ContextItem[]; delivery?: "steer" | "queue"; sessionId?: string }
  | { type: "abort"; sessionId?: string }
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
  | { type: "usePrompt"; id: string }
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
  /** Apply a code block from a reply; `path` is the nearest file reference, if any. */
  | { type: "applyCode"; text: string; path?: string }
  /** Append a reply to a project instruction file (AGENTS.md by default). */
  | { type: "saveInstruction"; text: string }
  | { type: "action"; id: ActionId }
  | { type: "selectFolder"; uri: string }
  | { type: "refreshChanges" }
  /** Manual sync from the header: re-read the conversation from the server. */
  | { type: "sync" }
  /** Re-fetch a subagent's child history when its card is expanded without live data. */
  | { type: "refreshSubagent"; sessionId: string }
  | { type: "dismissCompatibility"; version: string }
  | { type: "dismissContract"; signature: string };

/**
 * Messages of the dedicated Connect panel. They are separate from the chat protocol: a different
 * bundle owns that webview, and credentials/OAuth codes must never be mixed with conversation data.
 */
export interface ConnectAttemptView {
  kind: "oauth" | "command";
  integrationID: string;
  integrationName: string;
  /** Kept so the host can look up the server-advertised command instead of trusting the webview. */
  methodID: string;
  methodLabel: string;
  attemptID: string;
  url?: string;
  instructions?: string;
  mode?: "auto" | "code";
  paste?: boolean;
  command?: string[];
}

export type ConnectHostMessage =
  | { type: "init"; strings: Strings; platform: "mac" | "windows" | "linux" }
  | { type: "integrations"; items: IntegrationInfo[]; credentials: CredentialSummary[] }
  | { type: "attempt"; attempt: ConnectAttemptView }
  | { type: "attemptStatus"; status: "pending" | "complete" | "failed" | "needs_auth"; message?: string; url?: string }
  /** The attempt ended (completed, failed or cancelled): leave the code-entry screen. */
  | { type: "attemptClosed" }
  | { type: "notice"; kind: "success" | "error"; message: string }
  | { type: "busy"; busy: boolean };

export type ConnectWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "connectKey"; integrationID: string; key: string; answer: Record<string, FormValue>; label?: string }
  | { type: "connectExternal"; integrationID: string; methodID: string; answer: Record<string, FormValue>; label?: string }
  | { type: "startOAuth"; integrationID: string; methodID: string; answer: Record<string, FormValue>; label?: string }
  | { type: "startCommand"; integrationID: string; methodID: string; label?: string }
  | { type: "completeOAuth"; code: string }
  /** Ask the host to poll now (device-code flows where the user acts in the browser). */
  | { type: "checkAttempt" }
  | { type: "cancelAttempt" }
  /** Runs the command advertised by the selected integration method, never a webview-supplied string. */
  | { type: "runCommand" }
  | { type: "activateCredential"; id: string }
  | { type: "renameCredential"; id: string; label: string }
  | { type: "deleteCredential"; id: string }
  | { type: "openLink"; href: string }
  | { type: "copy"; text: string };
