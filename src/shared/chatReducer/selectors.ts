import type { FileDiff, FormRequest, PermissionRequest } from "../api";
import type { ChangedFile, ChatState, Todo, ToolPart, UiAssistantMessage } from "./types";

// ---- selectors ---------------------------------------------------------------------------

const TODO_TOOL_RE = /todo/i;

/** Latest todo list written by the `todowrite` tool (experimental in OpenCode 2.2). */
export function selectTodos(state: ChatState): Todo[] | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.kind !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.kind !== "tool" || !TODO_TOOL_RE.test(p.name)) continue;
      const todos = (p.metadata?.todos ?? p.input?.todos) as unknown;
      if (Array.isArray(todos)) {
        return todos
          .filter((t): t is Todo => !!t && typeof t === "object" && typeof (t as Todo).content === "string")
          .map((t) => ({ content: t.content, status: String(t.status ?? "pending") }));
      }
    }
  }
  return undefined;
}

/**
 * Files changed by completed tools in this conversation, reconstructed from `metadata.files`.
 * This is the fallback for `GET /session/{id}/diff`, which is empty outside git repositories.
 */
export function selectToolChangedFiles(state: ChatState): FileDiff[] {
  const byFile = new Map<string, FileDiff>();
  for (const m of state.messages) {
    if (m.kind !== "assistant") continue;
    for (const p of m.parts) {
      if (p.kind !== "tool" || p.status !== "completed") continue;
      for (const f of selectToolFiles(p)) {
        const status: FileDiff["status"] = f.status === "added" || f.status === "deleted" ? f.status : "modified";
        byFile.set(f.file, {
          file: f.file,
          patch: f.patch,
          status,
          additions: Number(f.additions) || 0,
          deletions: Number(f.deletions) || 0,
        });
      }
    }
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Files edited by the completed tools of a single turn, deduplicated by path with the most recent
 * patch winning — the same rule the session-wide `selectToolChangedFiles` uses.
 */
export function selectTurnFiles(msgs: UiAssistantMessage[]): ChangedFile[] {
  const byFile = new Map<string, ChangedFile>();
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.kind !== "tool" || p.status !== "completed") continue;
      for (const f of selectToolFiles(p)) byFile.set(f.file, f);
    }
  }
  return [...byFile.values()];
}

/** Insertions/deletions reported by the completed tools of a single turn. */
export function selectTurnFileChanges(msgs: UiAssistantMessage[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of selectTurnFiles(msgs)) {
    additions += Number(f.additions) || 0;
    deletions += Number(f.deletions) || 0;
  }
  return { additions, deletions };
}

/** Upper bound on remembered step paths; an unbounded list grows for the whole session lifetime. */
const MAX_TOUCHED_FILES = 500;

export function withTouchedFiles(state: ChatState, files: unknown): ChatState {
  const paths = Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  if (paths.length === 0) return state;
  const known = new Set(state.touchedFiles ?? []);
  let added = false;
  for (const p of paths) {
    if (!known.has(p)) {
      known.add(p);
      added = true;
    }
  }
  if (!added) return state;
  const all = [...known];
  return { ...state, touchedFiles: all.length > MAX_TOUCHED_FILES ? all.slice(-MAX_TOUCHED_FILES) : all };
}

/**
 * A session's `/diff` is computed from its start snapshot to the current working tree/HEAD, so it
 * also contains files committed by *other* sessions after this one started (the classic symptom:
 * an idle session lists the edits of the chat you used next). Admit a server row only when this
 * session actually touched that path — step `files` and completed tools' `metadata.files` are
 * session-scoped — while keeping the server's patch/counts for the rows we do show.
 */
export function mergeChangedFiles(fromDiff: FileDiff[], state: ChatState): FileDiff[] {
  const fromTools = selectToolChangedFiles(state);
  const owned = new Set<string>(state.touchedFiles ?? []);
  for (const f of fromTools) owned.add(f.file);

  const merged = new Map<string, FileDiff>();
  // Lowest priority: a step tells us a file was touched, but not how (no patch, no counts).
  for (const file of owned) {
    merged.set(file, { file, patch: "", additions: 0, deletions: 0, status: "modified" });
  }
  for (const f of fromTools) merged.set(f.file, f);
  for (const f of fromDiff) if (owned.has(f.file)) merged.set(f.file, f);
  return [...merged.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Files touched by tools in this conversation (from `metadata.files`), latest patch per file. */
export function selectToolFiles(part: ToolPart): ChangedFile[] {
  const files = part.metadata?.files;
  if (!Array.isArray(files)) return [];
  return files.filter(
    (f): f is ChangedFile =>
      !!f && typeof f === "object" && typeof (f as ChangedFile).file === "string" && typeof (f as ChangedFile).patch === "string",
  );
}

export function permissionsForTool(state: ChatState, toolId: string): PermissionRequest[] {
  return state.permissions.filter((p) => p.source?.id === toolId);
}

export function orphanPermissions(state: ChatState): PermissionRequest[] {
  const toolIds = new Set<string>();
  for (const m of state.messages) {
    if (m.kind === "assistant") for (const p of m.parts) if (p.kind === "tool") toolIds.add(p.id);
  }
  return state.permissions.filter((p) => !p.source || !toolIds.has(p.source.id));
}

export function formsForTool(state: ChatState, toolId: string): FormRequest[] {
  return state.forms.filter((f) => (f.metadata?.tool as { id?: string } | undefined)?.id === toolId);
}
