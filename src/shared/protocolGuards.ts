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

import {
  ACTION_IDS,
  UI_ERROR_KINDS,
  type ActionId,
  type ConnectHostMessage,
  type ConnectWebviewMessage,
  type HostMessage,
  type WebviewMessage,
} from "./protocol";

/** Generous caps: large prompts and patches are legitimate, unbounded arrays are not. */
const MAX_ID = 4096;
const MAX_LABEL = 1024;
const MAX_URI = 32_768;
const MAX_TEXT = 4_000_000;
const MAX_PATCH = 8_000_000;
const MAX_LIST = 2_000;
/** A credential form is small; a key or pasted OAuth code is never more than a few KB. */
const MAX_SECRET = 8_192;

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
  kind: oneOf(["file", "selection"] as const),
  detail: opt(str(MAX_TEXT)),
});

const isPromptDefinition: Check = shape({
  id: str(),
  title: str(MAX_LABEL),
  description: str(MAX_TEXT),
  text: str(MAX_TEXT),
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

const isPendingJob: Check = shape({
  id: str(),
  sessionID: str(),
  kind: str(MAX_LABEL),
  status: str(MAX_LABEL),
  title: opt(str(MAX_TEXT)),
  command: opt(str(MAX_TEXT)),
  description: opt(str(MAX_TEXT)),
  started: (value) => typeof value === "number" && Number.isFinite(value),
});

const isSessionRow: Check = shape({
  id: str(),
  title: str(MAX_TEXT),
  updated: (value) => typeof value === "number" && Number.isFinite(value),
  busy: bool,
  waiting: opt(bool),
  needsInput: bool,
  error: opt(oneOf(["failed", "interrupted"] as const)),
  folder: opt(str(MAX_LABEL)),
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
    sessionId: opt(str()),
    resolveVariables: opt(bool),
  }),
  abort: shape({ sessionId: opt(str()) }),
  compact: () => true,
  revertTo: shape({ sessionId: str(), messageID: str(), text: str(MAX_TEXT) }),
  fork: () => true,
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
  usePrompt: shape({ id: str() }),
  fileIcons: shape({ paths: arr(str(MAX_URI)) }),
  dropFiles: shape({ files: arr(isDroppedFile, 100) }),
  pickFiles: () => true,
  openDiff: shape({ file: str(MAX_URI), patch: str(MAX_PATCH), applied: bool }),
  openDiffs: shape({ files: arr(shape({ file: str(MAX_URI), patch: str(MAX_PATCH) }), 500) }),
  openFile: shape({ path: str(MAX_URI) }),
  openToolFile: shape({ path: str(MAX_URI) }),
  openAttachment: shape({ uri: str(MAX_URI) }),
  openLink: shape({ href: str(MAX_URI) }),
  copy: shape({ text: str(MAX_TEXT) }),
  applyCode: shape({ text: str(MAX_TEXT), path: opt(str(MAX_URI)) }),
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
  jobs: shape({ jobs: arr(isPendingJob, 200) }),
  subagent: shape({ snapshot: isSubagentSnapshot }),
  subagentEvent: shape({ sessionId: str(), event: isEvent }),
  externalAttention: shape({
    items: arr(
      shape({
        sessionId: str(),
        label: opt(str(MAX_LABEL)),
        permission: opt(obj),
        question: opt(obj),
      }),
      200,
    ),
  }),
  linkSubagent: shape({ toolId: str(), sessionId: str() }),
  context: shape({ items: arr(isContextItem) }),
  promptCatalog: shape({ items: arr(isPromptDefinition) }),
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
  prefillDraft: shape({ sessionId: opt(str()), text: str(MAX_TEXT), attachments: arr(isAttachment), template: opt(bool) }),
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

/** Exported for tests: validate a context item without needing a full message wrapper. */

/** Exported for tests: validate a dropped file without needing a full message wrapper. */

/** Exported for tests: validate a session row without needing a full message wrapper. */

/** Exported for tests: validate a UI error without needing a full message wrapper. */

/** Exported for tests: validate a model reference without needing a full message wrapper. */

/** Exported for tests: check a single action id against the protocol whitelist. */
export function isActionId(value: unknown): value is ActionId {
  return oneOf(ACTION_IDS)(value);
}

// ---- Connect panel ---------------------------------------------------------------------------

const isFormAnswer: Check = rec(isFormValue);

const isIntegrationMethod: Check = shape({
  id: opt(str()),
  type: oneOf(["oauth", "command", "key", "external", "env"] as const),
  label: opt(str(MAX_LABEL)),
  form: opt(arr(obj, 100)),
  command: opt(arr(str(MAX_LABEL), 50)),
  names: opt(arr(str(MAX_LABEL), 50)),
});

const isIntegration: Check = shape({
  id: str(),
  name: str(MAX_LABEL),
  methods: arr(isIntegrationMethod, 100),
  connections: arr(obj, 200),
  metadata: opt(obj),
});

const isCredentialSummary: Check = shape({
  id: str(),
  integrationID: str(),
  label: str(MAX_LABEL),
  active: bool,
  type: oneOf(["key", "oauth", "external"] as const),
});

const isConnectAttempt: Check = shape({
  kind: oneOf(["oauth", "command"] as const),
  integrationID: str(),
  integrationName: str(MAX_LABEL),
  methodID: str(),
  methodLabel: str(MAX_LABEL),
  attemptID: str(),
  url: opt(str(MAX_URI)),
  instructions: opt(str(MAX_TEXT)),
  mode: opt(oneOf(["auto", "code"] as const)),
  paste: opt(bool),
  command: opt(arr(str(MAX_LABEL), 50)),
});

const CONNECT_WEBVIEW_VALIDATORS: Record<string, Check> = {
  ready: () => true,
  refresh: () => true,
  connectKey: shape({
    integrationID: str(),
    key: str(MAX_SECRET),
    answer: isFormAnswer,
    label: opt(str(MAX_LABEL)),
  }),
  connectExternal: shape({
    integrationID: str(),
    methodID: str(),
    answer: isFormAnswer,
    label: opt(str(MAX_LABEL)),
  }),
  startOAuth: shape({
    integrationID: str(),
    methodID: str(),
    answer: isFormAnswer,
    label: opt(str(MAX_LABEL)),
  }),
  startCommand: shape({ integrationID: str(), methodID: str(), label: opt(str(MAX_LABEL)) }),
  completeOAuth: shape({ code: str(MAX_SECRET) }),
  checkAttempt: () => true,
  cancelAttempt: () => true,
  runCommand: () => true,
  activateCredential: shape({ id: str() }),
  renameCredential: shape({ id: str(), label: str(MAX_LABEL) }),
  deleteCredential: shape({ id: str() }),
  openLink: shape({ href: str(MAX_URI) }),
  copy: shape({ text: str(MAX_TEXT) }),
};

const CONNECT_HOST_VALIDATORS: Record<string, Check> = {
  init: shape({
    strings: rec(str(MAX_TEXT)),
    platform: oneOf(["mac", "windows", "linux"] as const),
  }),
  // A real OpenCode 2.4.0 server exposes ~335 integrations; a tighter cap silently dropped the
  // whole message and left the panel stuck on "Loading providers…".
  integrations: shape({ items: arr(isIntegration, MAX_LIST), credentials: arr(isCredentialSummary, MAX_LIST) }),
  attempt: shape({ attempt: isConnectAttempt }),
  attemptStatus: shape({
    status: oneOf(["pending", "complete", "failed", "needs_auth"] as const),
    message: opt(str(MAX_TEXT)),
    url: opt(str(MAX_URI)),
  }),
  attemptClosed: () => true,
  notice: shape({ kind: oneOf(["success", "error"] as const), message: str(MAX_TEXT) }),
  busy: shape({ busy: bool }),
};

/** Validate a message coming from the Connect webview before the host dispatches it. */
export function isConnectWebviewMessage(value: unknown): value is ConnectWebviewMessage {
  if (!obj(value) || typeof value.type !== "string") return false;
  return CONNECT_WEBVIEW_VALIDATORS[value.type]?.(value) ?? false;
}

/** Validate a message coming from the host before the Connect webview handles it. */
export function isConnectHostMessage(value: unknown): value is ConnectHostMessage {
  if (!obj(value) || typeof value.type !== "string") return false;
  return CONNECT_HOST_VALIDATORS[value.type]?.(value) ?? false;
}
