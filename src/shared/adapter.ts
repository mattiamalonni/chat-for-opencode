/**
 * Boundary between the raw OpenCode wire shapes and the canonical types used by the reducer and
 * the webview. The client returns whatever the server sends; `checkContract` reports shape drifts
 * against the 2.3.0 snapshot, while these normalisers keep the UI usable when a field is missing
 * or renamed. Adding support for a new server version should mean extending this file, not
 * rewriting the chat state machine.
 */

import type {
  AgentInfo,
  AssistantContent,
  CommandInfo,
  FormField,
  FormRequest,
  ModelInfo,
  ModelRef,
  OtherMessageType,
  PermissionRequest,
  ServerEvent,
  ServerInfo,
  SessionInfo,
  SessionMessage,
  SkillInfo,
  StructuredError,
  TokenUsage,
  ToolContent,
  ToolState,
  FileDiff,
} from "./api";
import { OTHER_MESSAGE_TYPES } from "./api";
import { OPENAPI_SNAPSHOT_VERSION } from "./openapi.generated";
// The generated module also exports the raw wire types for the 2.3.0 snapshot. Normalisers take
// `unknown` on purpose: a newer server must not be able to violate our types at runtime, it should
// only produce a degraded-but-renderable UI plus a contract warning.

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const firstString = (...values: unknown[]): string | undefined => values.map(str).find((v) => v !== undefined);

/** Runtime narrowing for the "other" message family; unknown types are dropped, never mislabelled. */
function isOtherMessageType(type: string): type is OtherMessageType {
  return (OTHER_MESSAGE_TYPES as readonly string[]).includes(type);
}

export { OPENAPI_SNAPSHOT_VERSION };

export function normalizeModelRef(raw: unknown): ModelRef | undefined {
  const o = obj(raw);
  const id = o && firstString(o.id, o.modelID);
  const providerID = o && str(o.providerID);
  if (!id || !providerID) return undefined;
  const variant = o && str(o.variant);
  return variant ? { id, providerID, variant } : { id, providerID };
}

export function normalizeTokenUsage(raw: unknown): TokenUsage {
  const o = obj(raw) ?? {};
  const cache = obj(o.cache) ?? {};
  return {
    input: num(o.input) ?? 0,
    output: num(o.output) ?? 0,
    reasoning: num(o.reasoning) ?? 0,
    cache: { read: num(cache.read) ?? 0, write: num(cache.write) ?? 0 },
  };
}

export function normalizeError(raw: unknown): StructuredError | undefined {
  const o = obj(raw);
  const type = o && str(o.type);
  const message = o && str(o.message);
  if (!type || message === undefined) return undefined;
  const status = o && num(o.status);
  return status === undefined ? { type, message } : { type, message, status };
}

export function normalizeSessionInfo(raw: unknown): SessionInfo | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const id = str(o.id);
  if (!id) return undefined;
  const time = obj(o.time) ?? {};
  const location = obj(o.location) ?? {};
  const model = normalizeModelRef(o.model);
  const agent = str(o.agent);
  const outcome = str(o.outcome);
  return {
    id,
    parentID: str(o.parentID),
    projectID: str(o.projectID) ?? "",
    cost: num(o.cost) ?? 0,
    tokens: normalizeTokenUsage(o.tokens),
    outcome: outcome === "succeeded" || outcome === "failed" || outcome === "interrupted" ? outcome : undefined,
    time: {
      created: num(time.created) ?? 0,
      updated: num(time.updated) ?? num(time.created) ?? 0,
      busy: num(time.busy),
      idle: num(time.idle),
      archived: num(time.archived),
    },
    location: { directory: str(location.directory) ?? "" },
    title: str(o.title),
    agent,
    model,
  };
}

function normalizeToolState(raw: unknown): ToolState {
  const o = obj(raw) ?? {};
  const status = str(o.status) ?? "running";
  const rawInput = obj(o.input);
  const input: Obj = rawInput ?? {};
  const metadata = obj(o.metadata);
  const content = arr(o.content)
    .map(normalizeToolContent)
    .filter((c): c is ToolContent => !!c);
  if (status === "streaming") return { status, input: str(o.input) ?? (rawInput ? JSON.stringify(rawInput) : "") };
  const error = normalizeError(o.error);
  if (status === "error") return { status: "error", input, error: error ?? { type: "unknown", message: "" }, content, metadata };
  if (status === "completed") return { status: "completed", input, content, metadata };
  return { status: "running", input, metadata };
}

function normalizeToolContent(raw: unknown): ToolContent | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const type = str(o.type);
  if (type === "text") {
    const text = str(o.text);
    return text === undefined ? undefined : { type: "text", text };
  }
  if (type === "file") {
    const uri = str(o.uri);
    const mime = str(o.mime);
    return uri && mime ? { type: "file", uri, mime, name: str(o.name) } : undefined;
  }
  return undefined;
}

function normalizeAssistantContent(raw: unknown): AssistantContent | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const type = str(o.type);
  if (type === "text" || type === "reasoning") {
    const text = str(o.text);
    if (text === undefined) return undefined;
    const time = obj(o.time) ?? {};
    const stamp = num(time.created);
    const stampData = stamp === undefined ? undefined : { created: stamp, completed: num(time.completed) };
    return type === "text" ? { type, text } : { type, text, time: stampData };
  }
  if (type === "tool") {
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name) return undefined;
    const time = obj(o.time) ?? {};
    const stamp = num(time.created);
    return {
      type,
      id,
      name,
      state: normalizeToolState(o.state),
      time: stamp === undefined ? undefined : { created: stamp, completed: num(time.completed) },
    };
  }
  return undefined;
}

export function normalizeSessionMessage(raw: unknown): SessionMessage | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const id = str(o.id);
  if (!id) return undefined;
  const time = obj(o.time) ?? {};
  const created = num(time.created) ?? 0;
  const type = str(o.type) ?? "system";
  if (type === "user") {
    return {
      id,
      type: "user",
      text: str(o.text) ?? "",
      time: { created, completed: num(time.completed) },
      files: arr(o.files)
        .map((f) => {
          const file = obj(f);
          if (!file) return undefined;
          const source = obj(file.source) ?? {};
          return {
            uri: str(file.uri) ?? str(source.uri),
            name: str(file.name),
            source: str(source.type) ? (source as { type: string; uri?: string }) : undefined,
          };
        })
        .filter((f) => f !== undefined),
    };
  }
  if (type === "assistant") {
    return {
      id,
      type: "assistant",
      agent: str(o.agent) ?? "",
      model: normalizeModelRef(o.model) ?? { id: "", providerID: "" },
      content: arr(o.content)
        .map(normalizeAssistantContent)
        .filter((c): c is AssistantContent => !!c),
      time: { created, completed: num(time.completed) },
      finish: str(o.finish),
      error: normalizeError(o.error),
      cost: num(o.cost),
      tokens: o.tokens ? normalizeTokenUsage(o.tokens) : undefined,
    };
  }
  if (type === "idle") {
    const outcome = str(o.outcome);
    return {
      id,
      type: "idle",
      outcome: outcome === "succeeded" || outcome === "failed" || outcome === "interrupted" ? outcome : "succeeded",
      time: { created, completed: num(time.completed) },
      error: normalizeError(o.error),
    };
  }
  if (!isOtherMessageType(type)) return undefined;
  return {
    id,
    type,
    time: { created, completed: num(time.completed) },
    text: str(o.text),
    description: str(o.description),
    agent: str(o.agent),
    model: normalizeModelRef(o.model),
    command: str(o.command),
    name: str(o.name),
  };
}

export function normalizeServerEvent(raw: unknown): ServerEvent | undefined {
  const o = obj(raw);
  if (!o) return undefined;
  const type = str(o.type);
  if (!type) return undefined;
  const location = obj(o.location) ?? {};
  return {
    id: str(o.id),
    created: num(o.created),
    type,
    location: str(location.directory) ? { directory: str(location.directory) as string } : undefined,
    // Event handlers dereference `data` directly; guarantee an object even for a malformed/legacy
    // event so a missing field degrades to "no fields" instead of a TypeError in the host.
    data: obj(o.data) ?? {},
  };
}

export function normalizeModel(raw: unknown): ModelInfo | undefined {
  const o = obj(raw);
  const id = o && firstString(o.id, o.modelID);
  if (!o || !id) return undefined;
  const limit = obj(o.limit) ?? {};
  const capabilities = obj(o.capabilities) ?? {};
  return {
    id,
    modelID: str(o.modelID) ?? id,
    providerID: str(o.providerID) ?? "",
    name: str(o.name) ?? id,
    family: str(o.family),
    type: str(o.type),
    enabled: bool(o.enabled) ?? true,
    status: str(o.status),
    variants: arr(o.variants)
      .map((v) => ({ id: str(obj(v)?.id) ?? "" }))
      .filter((v) => v.id),
    capabilities: {
      tools: bool(capabilities.tools) ?? false,
      input: arr(capabilities.input).filter((v): v is string => typeof v === "string"),
      output: arr(capabilities.output).filter((v): v is string => typeof v === "string"),
    },
    limit:
      num(limit.context) === undefined
        ? undefined
        : { context: num(limit.context) as number, input: num(limit.input), output: num(limit.output) ?? 0 },
  };
}

export function normalizeAgent(raw: unknown): AgentInfo | undefined {
  const o = obj(raw);
  const id = o && str(o.id);
  if (!o || !id) return undefined;
  const mode = str(o.mode);
  return {
    id,
    name: str(o.name) ?? id,
    description: str(o.description),
    mode: mode === "subagent" || mode === "primary" || mode === "all" ? mode : "primary",
    hidden: bool(o.hidden) ?? false,
    color: str(o.color),
    model: normalizeModelRef(o.model),
  };
}

export function normalizeSkill(raw: unknown): SkillInfo | undefined {
  const o = obj(raw);
  const id = o && str(o.id);
  if (!o || !id) return undefined;
  return {
    id,
    name: str(o.name) ?? id,
    description: str(o.description),
    autoinvoke: bool(o.autoinvoke),
    path: str(o.path) ?? "",
    content: str(o.content) ?? "",
  };
}

export function normalizeCommand(raw: unknown): CommandInfo | undefined {
  const o = obj(raw);
  const name = o && str(o.name);
  return o && name ? { name, description: str(o.description) } : undefined;
}

export function normalizePermission(raw: unknown): PermissionRequest | undefined {
  const o = obj(raw);
  const id = o && str(o.id);
  const sessionID = o && str(o.sessionID);
  if (!o || !id || !sessionID) return undefined;
  const source = obj(o.source) ?? {};
  const metadata = obj(o.metadata) ?? {};
  return {
    id,
    sessionID,
    action: str(o.action) ?? "",
    resources: arr(o.resources).filter((v): v is string => typeof v === "string"),
    save: arr(o.save).filter((v): v is string => typeof v === "string"),
    metadata: {
      ...metadata,
      files: arr(metadata.files)
        .map(normalizeFileDiff)
        .filter((f): f is FileDiff => !!f),
    },
    source: str(source.type) === "tool" ? { type: "tool", messageID: str(source.messageID) ?? "", id: str(source.id) ?? "" } : undefined,
    message: str(o.message),
  };
}

function normalizeFormField(raw: unknown): FormField | undefined {
  const o = obj(raw);
  const key = o && str(o.key);
  if (!o || !key) return undefined;
  const type = str(o.type);
  return {
    key,
    type: type === "number" || type === "integer" || type === "boolean" || type === "multiselect" || type === "external" ? type : "string",
    title: str(o.title),
    description: str(o.description),
    required: bool(o.required),
    hidden: bool(o.hidden),
    options: arr(o.options).map((v) => {
      const option = obj(v) ?? {};
      return { value: str(option.value) ?? "", label: str(option.label) ?? "", description: str(option.description) };
    }),
    custom: bool(o.custom),
    placeholder: str(o.placeholder),
    default: o.default as FormField["default"],
    url: str(o.url),
    minimum: num(o.minimum),
    maximum: num(o.maximum),
  };
}

export function normalizeForm(raw: unknown): FormRequest | undefined {
  const o = obj(raw);
  const id = o && str(o.id);
  const sessionID = o && str(o.sessionID);
  if (!o || !id || !sessionID) return undefined;
  return {
    id,
    sessionID,
    title: str(o.title) ?? "",
    metadata: obj(o.metadata),
    fields: arr(o.fields)
      .map(normalizeFormField)
      .filter((f): f is FormField => !!f),
  };
}

export function normalizeFileDiff(raw: unknown): FileDiff | undefined {
  const o = obj(raw);
  const file = o && str(o.file);
  const patch = o && str(o.patch);
  if (!o || !file || patch === undefined) return undefined;
  const status = str(o.status);
  return {
    file,
    patch,
    additions: num(o.additions) ?? 0,
    deletions: num(o.deletions) ?? 0,
    status: status === "added" || status === "deleted" ? status : "modified",
  };
}

export function normalizeServerInfo(raw: unknown): ServerInfo | undefined {
  const o = obj(raw);
  const version = o && str(o.version);
  if (!o || !version) return undefined;
  return { version, pid: num(o.pid) ?? 0, urls: arr(o.urls).filter((v): v is string => typeof v === "string") };
}

/** Applies a normaliser to an array, dropping entries that do not match the expected shape. */
export function normalizeList<T>(items: unknown, normalize: (raw: unknown) => T | undefined): T[] {
  return arr(items)
    .map(normalize)
    .filter((item): item is T => item !== undefined);
}

// Keep FormValue referenced so a schema change that swaps its shape is caught at compile time.
