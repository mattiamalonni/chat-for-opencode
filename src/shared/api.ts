// Subset of the OpenCode v2 HTTP API used by the extension.
// Shapes verified against `opencode serve` 2.2.7 — see docs/API_NOTES.md.

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface StructuredError {
  type: string;
  message: string;
  status?: number;
}

export interface SessionInfo {
  id: string;
  parentID?: string;
  projectID: string;
  agent?: string;
  model?: ModelRef;
  cost: number;
  tokens: TokenUsage;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; busy?: number; idle?: number; archived?: number };
  title?: string;
  location: { directory: string };
}

export interface FileAttachment {
  uri: string;
  name?: string;
  description?: string;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string | null };

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: ToolContent[]; metadata?: Record<string, unknown> }
  | {
      status: "error";
      input: Record<string, unknown>;
      error: StructuredError;
      content?: ToolContent[];
      metadata?: Record<string, unknown>;
    };

export type AssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; time?: { created: number; completed?: number } }
  | { type: "tool"; id: string; name: string; state: ToolState; time?: { created: number; completed?: number } };

interface MessageBase {
  id: string;
  time: { created: number; completed?: number };
  metadata?: Record<string, unknown>;
}

export interface UserMessage extends MessageBase {
  type: "user";
  text: string;
  files?: { uri?: string; name?: string; source?: { type: string; uri?: string } }[];
}

export interface AssistantMessage extends MessageBase {
  type: "assistant";
  agent: string;
  model: ModelRef;
  content: AssistantContent[];
  finish?: string;
  error?: StructuredError;
  cost?: number;
  tokens?: TokenUsage;
}

export interface IdleMessage extends MessageBase {
  type: "idle";
  outcome: "succeeded" | "failed" | "interrupted";
  error?: StructuredError;
}

export interface OtherMessage extends MessageBase {
  type:
    | "synthetic"
    | "system"
    | "skill"
    | "shell"
    | "agent-switched"
    | "model-switched"
    | "location-switched"
    | "compaction";
  text?: string;
  description?: string;
  agent?: string;
  model?: ModelRef;
  command?: string;
  name?: string;
}

export type SessionMessage = UserMessage | AssistantMessage | IdleMessage | OtherMessage;

/** A configuration document reported by `GET /api/config`, with its on-disk path. */
export interface ConfigEntry {
  type: "document" | "directory";
  path?: string;
  info?: Record<string, unknown>;
}

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

/** How an inbox item will be delivered when the agent loop picks it up (OpenCode 2.2.7). */
export type InboxDelivery = "steer" | "queue";

/** A pending item of `GET /api/session/{id}/inbox` — a prompt not delivered yet. */
export interface InboxItem {
  id: string;
  sessionID: string;
  time: { created: number };
  type: "user" | "synthetic" | "compaction" | "move";
  delivery: InboxDelivery;
  payload: { text?: string; description?: string; [key: string]: unknown };
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: { files?: FileDiff[]; [key: string]: unknown };
  source?: { type: "tool"; messageID: string; id: string };
  message?: string;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  options?: FormOption[];
  custom?: boolean;
  placeholder?: string;
  default?: unknown;
  url?: string;
  minimum?: number;
  maximum?: number;
}

export interface FormRequest {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: FormField[];
}

export type FormValue = string | number | boolean | string[];

export interface ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  family?: string;
  type?: string;
  enabled: boolean;
  status?: string;
  variants: { id: string }[];
  capabilities?: { tools: boolean; input: string[]; output: string[] };
  limit?: { context: number; input?: number; output: number };
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  color?: string;
  model?: ModelRef;
}

export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  autoinvoke?: boolean;
  path: string;
  content: string;
}

export type SkillSuggestion = Pick<SkillInfo, "id" | "name" | "description">;

/** Slash command exposed by GET /api/command (no `id`, only a name). */
export interface CommandInfo {
  name: string;
  description?: string;
}

export type CommandSuggestion = Pick<CommandInfo, "name" | "description">;

export interface ServerInfo {
  version: string;
  pid: number;
  urls: string[];
}

export interface ServerEvent {
  id?: string;
  type: string;
  created?: number;
  location?: { directory: string };
  data: unknown;
}
