/**
 * Pinned registry of the OpenCode endpoints covered by the contract fixture. The compile-time gate
 * in `src/shared/sdkContract.ts` checks the wire types against the SDK's generated client.
 */
export interface ApiEndpoint {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** OpenAPI-style path template with `{name}` segments. */
  readonly path: string;
}

export const ENDPOINTS = {
  info: { method: "GET", path: "api/info" },
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
  integrationList: { method: "GET", path: "api/integration" },
  integrationGet: { method: "GET", path: "api/integration/{integrationID}" },
  connectKey: { method: "POST", path: "api/integration/{integrationID}/connect/key" },
  connectExternal: { method: "POST", path: "api/integration/{integrationID}/connect/external" },
  connectOAuth: { method: "POST", path: "api/integration/{integrationID}/connect/oauth" },
  connectOAuthStatus: { method: "GET", path: "api/integration/{integrationID}/connect/oauth/{attemptID}" },
  connectOAuthCancel: { method: "DELETE", path: "api/integration/{integrationID}/connect/oauth/{attemptID}" },
  connectOAuthComplete: { method: "POST", path: "api/integration/{integrationID}/connect/oauth/{attemptID}/complete" },
  connectCommand: { method: "POST", path: "api/integration/{integrationID}/connect/command" },
  connectCommandStatus: { method: "GET", path: "api/integration/{integrationID}/connect/command/{attemptID}" },
  connectCommandCancel: { method: "DELETE", path: "api/integration/{integrationID}/connect/command/{attemptID}" },
  credentialList: { method: "GET", path: "api/credential" },
  credentialUpdate: { method: "PATCH", path: "api/credential/{credentialID}" },
  credentialRemove: { method: "DELETE", path: "api/credential/{credentialID}" },
  credentialActivate: { method: "POST", path: "api/credential/{credentialID}/activate" },
} as const satisfies Record<string, ApiEndpoint>;

export const REQUIRED_ENDPOINTS: readonly ApiEndpoint[] = Object.values(ENDPOINTS);
