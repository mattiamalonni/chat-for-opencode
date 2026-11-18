import type {
  AgentInfo,
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
} from "./api";
import type { Compatibility } from "./compatibility";
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

export interface UiError {
  kind: UiErrorKind;
  message: string;
  detail?: string;
  actions: ActionId[];
}

export interface SessionSummary {
  id: string;
  title: string;
  updated: number;
  busy: boolean;
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
    }
  | {
      type: "catalog";
      models: ModelInfo[];
      agents: AgentInfo[];
      skills: SkillSuggestion[];
      selectedModel?: ModelRef;
      selectedAgent?: string;
    }
  | { type: "sessions"; items: SessionSummary[]; currentId?: string; hasMore?: boolean }
  | { type: "session"; session: SessionPayload | null }
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
  | { type: "openDiff"; file: string; patch: string; applied: boolean }
  | { type: "openFile"; path: string }
  | { type: "openLink"; href: string }
  | { type: "copy"; text: string }
  | { type: "action"; id: ActionId }
  | { type: "selectFolder"; uri: string }
  | { type: "refreshChanges" }
  | { type: "dismissCompatibility"; version: string };
