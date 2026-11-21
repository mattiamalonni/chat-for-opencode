/**
 * Runtime smoke test of the OpenCode contract. The extension is written against the 2.2.7
 * snapshot (docs/openapi-2.2.7.json), but a version banner alone does not say *what* will break.
 * These checks run on the data the extension already fetches (no extra requests) and name the
 * capabilities whose response shape does not match what the webview expects.
 */
export type CapabilityId =
  | "serverInfo"
  | "models"
  | "agents"
  | "skills"
  | "history"
  | "contextMeter"
  | "changedFiles"
  | "inbox";

export interface ContractFailure {
  id: CapabilityId;
  detail: string;
}

export interface ContractReport {
  checked: number;
  failures: ContractFailure[];
}

export interface ContractObservations {
  version?: string;
  models?: unknown;
  agents?: unknown;
  skills?: unknown;
  messages?: unknown;
  diff?: unknown;
  inbox?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const hasIds = (v: unknown): boolean =>
  Array.isArray(v) && v.every((item) => isObj(item) && typeof item.id === "string");

export const emptyContract: ContractReport = { checked: 0, failures: [] };

/** Stable key for the "already dismissed" preference; changes when the degraded features change. */
export function contractSignature(report: ContractReport): string {
  return report.failures.length === 0
    ? "ok"
    : report.failures
        .map((f) => f.id)
        .sort()
        .join(",");
}

export function checkContract(o: ContractObservations): ContractReport {
  const failures: ContractFailure[] = [];
  let checked = 0;
  const check = (id: CapabilityId, ok: boolean, detail: string) => {
    checked++;
    if (!ok) failures.push({ id, detail });
  };

  check("serverInfo", typeof o.version === "string" && o.version.length > 0, "GET /api/info did not report a server version.");
  check("models", hasIds(o.models), "GET /api/model did not return models with an id.");
  check("agents", hasIds(o.agents), "GET /api/agent did not return agents with an id.");
  check("skills", hasIds(o.skills), "GET /api/skill did not return skills with an id.");
  check(
    "history",
    Array.isArray(o.messages) && o.messages.every((m) => isObj(m) && typeof m.type === "string" && isObj(m.time) && typeof m.time.created === "number"),
    "GET /api/session/{id}/message did not return messages with type and time.created.",
  );

  // Only meaningful when the catalog is present: an empty model list is a "no provider" error,
  // handled separately, not a contract failure.
  if (Array.isArray(o.models) && o.models.length > 0) {
    check(
      "contextMeter",
      o.models.some((m) => isObj(m) && isObj(m.limit) && typeof m.limit.context === "number"),
      "Models do not expose limit.context, so the context meter cannot be shown.",
    );
  }
  if (Array.isArray(o.diff) && o.diff.length > 0) {
    check(
      "changedFiles",
      o.diff.every((f) => isObj(f) && typeof f.file === "string" && typeof f.patch === "string"),
      "GET /api/session/{id}/diff did not return file patches.",
    );
  }
  if (Array.isArray(o.inbox) && o.inbox.length > 0) {
    check(
      "inbox",
      o.inbox.every((i) => isObj(i) && typeof i.id === "string" && typeof i.type === "string" && (i.delivery === "queue" || i.delivery === "steer")),
      "GET /api/session/{id}/inbox did not return items with id, type and delivery.",
    );
  }

  return { checked, failures };
}
