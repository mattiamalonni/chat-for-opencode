import type * as vscode from "vscode";
import type { OpenCodeClient } from "../../client/http";
import type { ControllerState } from "./controllerState";
import { deleteDrafts } from "./draftActions";
import { MAX_DELETE_IDS, MAX_DELETE_PAGES, translatedStrings } from "./controllerSupport";
import type { Generation } from "../generation";
import type { PermissionService } from "../permissionService";
import type { SessionListService } from "../sessionListService";

/** Bounded, cancelable walk over every session page in the current folder. */
export interface BulkDeleteDeps {
  state: ControllerState;
  deleteGeneration: Generation;
  permissions: PermissionService;
  sessionList: SessionListService;
  workspaceState: vscode.Memento;
  getClient(): OpenCodeClient | undefined;
  logWarn(line: string): void;
  refreshSessions(): Promise<void>;
  newSession(): Promise<void>;
}

export class ChatBulkDelete {
  constructor(private readonly d: BulkDeleteDeps) {}

  async run(): Promise<void> {
    const client = this.d.getClient();
    const folder = this.d.state.folder;
    if (!client || !folder) return;
    const directory = folder.uri.fsPath;
    this.d.state.deleteAllAbort?.abort();
    const abort = new AbortController();
    this.d.state.deleteAllAbort = abort;
    const token = this.d.deleteGeneration.current();
    const stale = () =>
      abort.signal.aborted || !this.d.deleteGeneration.is(token) || this.d.state.folder !== folder || this.d.getClient() !== client;
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    try {
      let exhausted = false;
      for (let page = 0; page < MAX_DELETE_PAGES; page++) {
        if (stale()) return;
        const { items, next } = await client.listSessionsPage(directory, 100, cursor, abort.signal);
        if (stale()) return;
        for (const info of items) ids.add(info.id);
        if (ids.size > MAX_DELETE_IDS) throw new Error("Too many sessions to delete");
        if (!next || seenCursors.has(next)) {
          exhausted = true;
          break;
        }
        seenCursors.add(next);
        cursor = next;
      }
      if (!exhausted) throw new Error("Too many session pages to delete");

      const currentId = this.d.state.sessionId;
      const deleted: string[] = [];
      for (const id of ids) {
        if (stale()) return;
        try {
          await client.deleteSession(id);
          deleted.push(id);
          await this.d.permissions.write(id, undefined);
        } catch (err) {
          // A child already removed with its parent (or a stale session) must not abort the cleanup.
          this.d.logWarn(`[chat] failed to delete session ${id}: ${String(err)}`);
        }
      }
      if (stale()) return;

      this.d.sessionList.forget(deleted);
      await deleteDrafts(this.d.workspaceState, folder.uri, deleted);

      if (ids.size > 0 && deleted.length === 0) {
        // Nothing could be removed; keep the chat as it is and let the list re-sync from the server.
        await this.d.refreshSessions();
        throw new Error(translatedStrings()["error.requestFailed"]);
      }
      // Clear the current chat when its session was among the deleted ones (also covers "no session").
      if (!currentId || ids.has(currentId)) await this.d.newSession();
      else await this.d.refreshSessions();
    } finally {
      if (this.d.state.deleteAllAbort === abort) this.d.state.deleteAllAbort = undefined;
    }
  }

  /** Ask the server to compact the current session (runs at the next step boundary). */
}
