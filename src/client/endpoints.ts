/**
 * Every HTTP endpoint the extension calls, declared once.
 *
 * `OpenCodeClient` builds its requests from this registry and the contract gate compares it with the
 * pinned OpenAPI snapshot. A hand-written list in the test used to cover only part of the client,
 * so removing an endpoint from 2.2.8 could pass CI unnoticed.
 */
export interface ApiEndpoint {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** OpenAPI-style path template; `{name}` segments are encoded by `endpointPath`. */
  readonly path: string;
}

export const ENDPOINTS = {
  info: { method: "GET", path: "api/info" },
  config: { method: "GET", path: "api/config" },
  event: { method: "GET", path: "api/event" },
  models: { method: "GET", path: "api/model" },
  modelDefault: { method: "GET", path: "api/model/default" },
  agents: { method: "GET", path: "api/agent" },
  skills: { method: "GET", path: "api/skill" },
  commands: { method: "GET", path: "api/command" },
  sessionList: { method: "GET", path: "api/session" },
  sessionCreate: { method: "POST", path: "api/session" },
  sessionGet: { method: "GET", path: "api/session/{sessionID}" },
  sessionDelete: { method: "DELETE", path: "api/session/{sessionID}" },
  sessionRename: { method: "PATCH", path: "api/session/{sessionID}" },
  messages: { method: "GET", path: "api/session/{sessionID}/message" },
  prompt: { method: "POST", path: "api/session/{sessionID}/prompt" },
  command: { method: "POST", path: "api/session/{sessionID}/command" },
  fork: { method: "POST", path: "api/session/{sessionID}/fork" },
  inbox: { method: "GET", path: "api/session/{sessionID}/inbox" },
  inboxDelivery: { method: "PATCH", path: "api/session/{sessionID}/inbox/{inboxID}" },
  inboxCancel: { method: "DELETE", path: "api/session/{sessionID}/inbox/{inboxID}" },
  compact: { method: "POST", path: "api/session/{sessionID}/compact" },
  revertStage: { method: "POST", path: "api/session/{sessionID}/revert/stage" },
  revertCommit: { method: "POST", path: "api/session/{sessionID}/revert/commit" },
  revertDelete: { method: "DELETE", path: "api/session/{sessionID}/revert" },
  wait: { method: "POST", path: "api/experimental/session/{sessionID}/wait" },
  interrupt: { method: "POST", path: "api/session/{sessionID}/interrupt" },
  switchAgent: { method: "POST", path: "api/session/{sessionID}/agent" },
  switchModel: { method: "POST", path: "api/session/{sessionID}/model" },
  permissions: { method: "GET", path: "api/session/{sessionID}/permission" },
  permissionReply: { method: "POST", path: "api/session/{sessionID}/permission/{requestID}/reply" },
  forms: { method: "GET", path: "api/session/{sessionID}/form" },
  formReply: { method: "POST", path: "api/session/{sessionID}/form/{formID}/reply" },
  formCancel: { method: "DELETE", path: "api/session/{sessionID}/form/{formID}" },
  diff: { method: "GET", path: "api/session/{sessionID}/diff" },
} as const satisfies Record<string, ApiEndpoint>;

export const REQUIRED_ENDPOINTS: readonly ApiEndpoint[] = Object.values(ENDPOINTS);

/** Fill a template with encoded path segments. */
export function endpointPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => encodeURIComponent(params[key] ?? ""));
}
