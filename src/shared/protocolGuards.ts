/**
 * Runtime validation for the webview ↔ extension-host boundary.
 *
 * `HostMessage` / `WebviewMessage` are TypeScript types: they disappear at runtime, so a stale
 * bundle or a compromised webview can deliver any shape. The host side is privileged (it can open
 * files, run terminal commands and delete sessions), so every inbound message is checked before
 * dispatch; the webview validates host messages for the same reason, to fail closed instead of
 * crashing its reducer on an unknown payload.
 *
 * These guards are deliberately structural, not semantic: they check types, enum membership and
 * bounds, not whether a session id exists. Semantic checks stay in the controller where they have
 * access to the current session and can report an actionable error.
 */

import type { ModelRef } from "./api";
import {
  ACTION_IDS,
  CONTEXT_SOURCE_IDS,
  UI_ERROR_KINDS,
  type ActionId,
  type Attachment,
  type ContextItem,
  type DroppedFile,
  type HostMessage,
  type SessionSummary,
  type UiError,
  type WebviewMessage,
} from "./protocol";

/** Generous caps: large prompts and patches are legitimate, unbounded arrays are not. */
const MAX_ID = 4096;
const MAX_LABEL = 1024;
const MAX_URI = 32_768;
const MAX_TEXT = 4_000_000;
const MAX_PATCH = 8_000_000;
const MAX_LIST = 2_000;

type Check = (value: unknown) => boolean;

const obj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const str =
  (max = MAX_ID): Check =>
  (value) =>
    typeof value === "string" && value.length <= max;
const bool: Check = (value) => typeof value === "boolean";
const opt =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const arr =
  (check: Check, max = MAX_LIST): Check =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(check);
const rec =
  (check: Check): Check =>
  (value) =>
    obj(value) && Object.values(value).every(check);
const shape =
  (fields: Record<string, Check>): Check =>
  (value) =>
    obj(value) && Object.entries(fields).every(([key, check]) => check(value[key]));

const oneOf =
  <T extends string>(values: readonly T[]): Check =>
  (value) =>
    typeof value === "string" && (values as readonly string[]).includes(value);

const isAttachment: Check = shape({
  uri: str(MAX_URI),
  name: str(MAX_LABEL),
  kind: oneOf(["file", "selection"] as const),
  detail: opt(str(MAX_TEXT)),
});

const isContextItem: Check = shape({
  id: str(),
  uri: str(MAX_URI),
  label: str(MAX_LABEL),
  kind: oneOf(["file", "selection", ...CONTEXT_SOURCE_IDS] as const),
  detail: opt(str(MAX_TEXT)),
});

const isContextSource: Check = shape({
  id: oneOf(CONTEXT_SOURCE_IDS),
  label: str(MAX_LABEL),
  description: str(MAX_TEXT),
});

const isDroppedFile: Check = shape({
  name: str(MAX_LABEL),
  uri: opt(str(MAX_URI)),
  path: opt(str(MAX_URI)),
  base64: opt(str(MAX_TEXT)),
  mime: opt(str(MAX_LABEL)),
});

const isModelRef: Check = shape({
  id: str(),
  providerID: str(),
  variant: opt(str()),
});

const isEvent: Check = shape({ type: str(256) });

const isUiError: Check = shape({
  kind: oneOf(UI_ERROR_KINDS),
  message: str(MAX_TEXT),
  detail: opt(str(MAX_TEXT)),
  actions: arr(oneOf(ACTION_IDS), ACTION_IDS.length),
  target: opt(shape({ kind: oneOf(["permission", "form"] as const), id: str() })),
});

const isFileIcon: Check = (value) => {
  if (!obj(value)) return false;
  if (value.kind === "svg") return str(MAX_URI)(value.src);
  if (value.kind === "font") {
    return shape({
      fontFamily: str(MAX_LABEL),
      glyph: str(MAX_LABEL),
      color: opt(str(MAX_LABEL)),
      size: opt(str(MAX_LABEL)),
    })(value);
  }
  return false;
};

const isFileIconFont: Check = shape({
  family: str(MAX_LABEL),
  src: str(MAX_URI),
  format: str(MAX_LABEL),
  weight: opt(str(MAX_LABEL)),
  style: opt(str(MAX_LABEL)),
});

const isSessionRow: Check = shape({
  id: str(),
  title: str(MAX_TEXT),
  updated: (value) => typeof value === "number" && Number.isFinite(value),
  busy: bool,
  needsInput: bool,
});

const isSessionPayload: Check = shape({
  id: str(),
  title: opt(str(MAX_TEXT)),
  agent: opt(str()),
  model: opt(isModelRef),
  busy: bool,
  messages: arr(obj),
  permissions: arr(obj),
  forms: arr(obj),
  usage: opt(obj),
});

const isSessionDelta: Check = shape({
  sessionId: str(),
  messages: arr(obj),
  permissions: opt(arr(obj)),
  forms: opt(arr(obj)),
  usage: opt(obj),
  busy: opt(bool),
  title: opt(str(MAX_TEXT)),
  agent: opt(str()),
  model: opt(isModelRef),
});

const isSubagentSnapshot: Check = shape({
  sessionId: str(),
  parentId: opt(str()),
  title: opt(str(MAX_TEXT)),
  agent: opt(str()),
  messages: arr(obj),
  permissions: arr(obj),
  forms: arr(obj),
  busy: bool,
});

const isFormValue: Check = (value) =>
  (typeof value === "string" && value.length <= MAX_TEXT) ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  arr(str(MAX_TEXT), MAX_LIST)(value);

const WEBVIEW_VALIDATORS: Record<string, Check> = {
  ready: () => true,
  send: shape({
    text: str(MAX_TEXT),
    attachments: arr(isAttachment),
    context: arr(isContextItem),
    delivery: opt(oneOf(["steer", "queue"] as const)),
  }),
  abort: () => true,
  compact: () => true,
  revertTo: shape({ sessionId: str(), messageID: str(), text: str(MAX_TEXT) }),
  forkTo: shape({ sessionId: str(), messageID: str() }),
  regenerate: shape({ sessionId: str(), messageID: str(), text: str(MAX_TEXT), attachments: arr(isAttachment) }),
  newSession: () => true,
  selectSession: shape({ id: str() }),
  deleteSession: shape({ id: str() }),
  deleteAllSessions: () => true,
  renameSession: shape({ id: str(), title: str(MAX_LABEL) }),
  refreshSessions: () => true,
  loadMoreSessions: () => true,
  setModel: shape({ model: isModelRef }),
  setAgent: shape({ agent: str() }),
  setAutoApprove: shape({ enabled: bool }),
  saveDraft: shape({ sessionId: opt(str()), text: str(MAX_TEXT) }),
  permissionReply: shape({ sessionId: str(), requestId: str(), decision: oneOf(["once", "always", "reject"] as const) }),
  setInboxDelivery: shape({ sessionId: str(), inboxId: str(), delivery: oneOf(["steer", "queue"] as const) }),
  cancelInbox: shape({ sessionId: str(), inboxId: str() }),
  formReply: shape({ sessionId: str(), formId: str(), answer: rec(isFormValue) }),
  formCancel: shape({ sessionId: str(), formId: str() }),
  searchFiles: shape({ query: str(MAX_LABEL) }),
  addContextSource: shape({ source: oneOf(CONTEXT_SOURCE_IDS) }),
  removeContextSource: shape({ source: oneOf(CONTEXT_SOURCE_IDS) }),
  fileIcons: shape({ paths: arr(str(MAX_URI)) }),
  dropFiles: shape({ files: arr(isDroppedFile, 100) }),
  pickFiles: () => true,
  openDiff: shape({ file: str(MAX_URI), patch: str(MAX_PATCH), applied: bool }),
  openDiffs: shape({ files: arr(shape({ file: str(MAX_URI), patch: str(MAX_PATCH) }), 500) }),
  openFile: shape({ path: str(MAX_URI) }),
  openAttachment: shape({ uri: str(MAX_URI) }),
  openLink: shape({ href: str(MAX_URI) }),
  copy: shape({ text: str(MAX_TEXT) }),
  // `action` is the privileged one: never dispatch an id outside the protocol whitelist.
  action: shape({ id: oneOf(ACTION_IDS) }),
  selectFolder: shape({ uri: str(MAX_URI) }),
  refreshChanges: () => true,
  sync: () => true,
  refreshSubagent: shape({ sessionId: str() }),
  dismissCompatibility: shape({ version: str(256) }),
  dismissContract: shape({ signature: str(256) }),
};

const HOST_VALIDATORS: Record<string, Check> = {
  init: shape({
    strings: rec(str(MAX_TEXT)),
    platform: oneOf(["mac", "windows", "linux"] as const),
    folders: arr(shape({ uri: str(MAX_URI), name: str(MAX_LABEL) })),
    activeFolder: opt(str(MAX_URI)),
    issuesUrl: opt(str(MAX_URI)),
    dropzone: opt(bool),
  }),
  connection: shape({
    status: oneOf(["idle", "starting", "connected", "reconnecting", "error"] as const),
    error: opt(isUiError),
    version: opt(str(256)),
    compatibility: opt(oneOf(["ok", "untested", "unsupported", "unknown"] as const)),
    compatibilityDismissed: opt(bool),
    contract: opt(obj),
    contractDismissed: opt(bool),
  }),
  catalog: shape({
    models: arr(obj),
    agents: arr(obj),
    skills: arr(obj),
    commands: opt(arr(obj)),
    selectedModel: opt(isModelRef),
    selectedAgent: opt(str()),
  }),
  sessions: shape({ items: arr(isSessionRow), currentId: opt(str()), hasMore: opt(bool) }),
  session: shape({ session: (value) => value === null || isSessionPayload(value) }),
  sessionDelta: shape({ delta: isSessionDelta }),
  event: shape({ event: isEvent }),
  subagent: shape({ snapshot: isSubagentSnapshot }),
  subagentEvent: shape({ sessionId: str(), event: isEvent }),
  linkSubagent: shape({ toolId: str(), sessionId: str() }),
  context: shape({ items: arr(isContextItem) }),
  contextSources: shape({ items: arr(isContextSource) }),
  fileIcons: shape({
    icons: rec((value) => value === null || isFileIcon(value)),
    fonts: rec(isFileIconFont),
    reset: opt(bool),
  }),
  fileResults: shape({ query: str(MAX_LABEL), items: arr(isAttachment) }),
  addAttachment: shape({ item: isAttachment }),
  changedFiles: shape({ files: arr(obj) }),
  inbox: shape({ items: arr(obj) }),
  forked: shape({ sessionId: str(), title: opt(str(MAX_TEXT)) }),
  autoApprove: shape({ enabled: bool }),
  dropzone: shape({ enabled: bool }),
  drafts: shape({ drafts: rec(str(MAX_TEXT)), globalDraft: opt(str(MAX_TEXT)) }),
  draftRestored: shape({ sessionId: opt(str()), text: str(MAX_TEXT), force: opt(bool) }),
  focusInput: () => true,
  revealMessage: shape({ messageId: str(), sessionId: opt(str()) }),
  prefillDraft: shape({ sessionId: opt(str()), text: str(MAX_TEXT), attachments: arr(isAttachment) }),
  reverted: shape({ sessionId: str(), text: str(MAX_TEXT) }),
  synced: () => true,
  notice: shape({ error: isUiError }),
};

/** Validate a message coming from the webview before the host dispatches it. */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!obj(value) || typeof value.type !== "string") return false;
  return WEBVIEW_VALIDATORS[value.type]?.(value) ?? false;
}

/** Validate a message coming from the host before the webview handles it. */
export function isHostMessage(value: unknown): value is HostMessage {
  if (!obj(value) || typeof value.type !== "string") return false;
  return HOST_VALIDATORS[value.type]?.(value) ?? false;
}

/** Exported for tests: validate an attachment without needing a full message wrapper. */
export function isAttachmentValue(value: unknown): value is Attachment {
  return isAttachment(value);
}

/** Exported for tests: validate a context item without needing a full message wrapper. */
export function isContextItemValue(value: unknown): value is ContextItem {
  return isContextItem(value);
}

/** Exported for tests: validate a dropped file without needing a full message wrapper. */
export function isDroppedFileValue(value: unknown): value is DroppedFile {
  return isDroppedFile(value);
}

/** Exported for tests: validate a session row without needing a full message wrapper. */
export function isSessionSummaryValue(value: unknown): value is SessionSummary {
  return isSessionRow(value);
}

/** Exported for tests: validate a UI error without needing a full message wrapper. */
export function isUiErrorValue(value: unknown): value is UiError {
  return isUiError(value);
}

/** Exported for tests: validate a model reference without needing a full message wrapper. */
export function isModelRefValue(value: unknown): value is ModelRef {
  return isModelRef(value);
}

/** Exported for tests: check a single action id against the protocol whitelist. */
export function isActionId(value: unknown): value is ActionId {
  return oneOf(ACTION_IDS)(value);
}
