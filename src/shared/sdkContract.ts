/**
 * Compile-time contract between the wire types the webview consumes (`shared/api.ts`) and the
 * types generated from OpenCode's authoritative HTTP API (`@opencode/client`, the same client the
 * embedded SDK exposes). An SDK upgrade that changes a field type used by the reducer fails
 * `npm run typecheck` instead of degrading silently at runtime.
 *
 * The snapshot `openapi.generated.ts` is the reference for the type generator; these assertions
 * are the live gate. `CredentialEntry` is deliberately absent: its `value`
 * carries secrets and is projected to `CredentialSummary` by `OpenCodeClient.credentials()`.
 */
import type * as Sdk from "@opencode/client";
import type * as Api from "./api";

type Assignable<From, To> = From extends To ? true : false;
type Assert<T extends true> = T;

export type CheckSession = Assert<Assignable<Sdk.SessionInfo, Api.SessionInfo>>;
export type CheckModel = Assert<Assignable<Sdk.ModelInfo, Api.ModelInfo>>;
export type CheckAgent = Assert<Assignable<Sdk.AgentInfo, Api.AgentInfo>>;
export type CheckSkill = Assert<Assignable<Sdk.SkillInfo, Api.SkillInfo>>;
export type CheckPermission = Assert<Assignable<Sdk.PermissionRequest, Api.PermissionRequest>>;
export type CheckFileDiff = Assert<Assignable<Sdk.FileDiffInfo, Api.FileDiff>>;
export type CheckEvent = Assert<Assignable<Sdk.V2Event, Api.ServerEvent>>;
export type CheckMessage = Assert<Assignable<Sdk.SessionMessageInfo, Api.SessionMessage>>;
