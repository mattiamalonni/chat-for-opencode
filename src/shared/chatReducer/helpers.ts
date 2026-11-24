import type { FormRequest, ModelRef, PermissionRequest, ServerEvent, TokenUsage } from "../api";

/** Old history can carry `{ id: "", providerID: "" }`; treat that as "no model seen yet". */
export function usableModel(model: ModelRef | undefined): model is ModelRef {
  return !!model && !!model.id && !!model.providerID;
}

/**
 * Tokens the conversation occupies after a step: the prompt (`input` excludes cached tokens, as
 * verified against opencode 2.4.0) plus what the model produced in that step.
 */
export function contextTokensOf(tokens: TokenUsage | undefined): number | undefined {
  if (!tokens) return undefined;
  const total = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning;
  return total > 0 ? total : undefined;
}

// ---- live events -------------------------------------------------------------------------

export type Data = Record<string, unknown>;

export function str(d: Data, k: string): string {
  const v = d[k];
  return typeof v === "string" ? v : "";
}

/** Accept only a well-formed model ref from a live event; drift must not poison `chat.model`. */
export function asModelRef(value: unknown): ModelRef | undefined {
  const model = value as ModelRef | undefined;
  if (!model || typeof model.id !== "string" || typeof model.providerID !== "string") return undefined;
  return model;
}

/**
 * Live `permission.asked`/`form.created` events come straight off the wire (the resync path, by
 * contrast, normalises them in the host). Guarantee the fields the cards dereference so one
 * malformed event can never blank the whole conversation via the error boundary. Kept local to
 * avoid dragging the OpenAPI snapshot into the webview bundle.
 */
export function asPermission(raw: unknown): PermissionRequest | undefined {
  const d = raw as Data | undefined;
  if (!d || typeof d !== "object") return undefined;
  const id = str(d, "id");
  const sessionID = str(d, "sessionID");
  if (!id || !sessionID) return undefined;
  return {
    ...(d as unknown as PermissionRequest),
    id,
    sessionID,
    action: str(d, "action"),
    resources: Array.isArray(d.resources) ? d.resources.filter((r): r is string => typeof r === "string") : [],
    save: Array.isArray(d.save) ? d.save.filter((s): s is string => typeof s === "string") : [],
  };
}

export function asForm(raw: unknown): FormRequest | undefined {
  const d = raw as Data | undefined;
  if (!d || typeof d !== "object") return undefined;
  const id = str(d, "id");
  const sessionID = str(d, "sessionID");
  if (!id || !sessionID) return undefined;
  return {
    ...(d as unknown as FormRequest),
    id,
    sessionID,
    title: str(d, "title"),
    fields: Array.isArray(d.fields) ? (d.fields as FormRequest["fields"]).filter((f) => !!f && typeof f.key === "string") : [],
  };
}

export function eventSessionId(event: ServerEvent): string | undefined {
  const d = event.data as Data | undefined;
  if (!d || typeof d !== "object") return undefined;
  if (typeof d.sessionID === "string") return d.sessionID;
  const form = d.form as Data | undefined;
  if (form && typeof form.sessionID === "string") return form.sessionID;
  return undefined;
}
