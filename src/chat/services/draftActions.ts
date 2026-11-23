import type * as vscode from "vscode";
import type { HostMessage } from "../../shared/protocol";
import type { ControllerState } from "./controllerState";
import { DRAFTS_KEY } from "../storageKeys";

/** Drafts live in workspaceState so they survive a window reload (vscode.setState does not). */
export class ChatDraftActions {
  constructor(
    private readonly d: {
      state: ControllerState;
      workspaceState: vscode.Memento;
      post(msg: HostMessage): void;
    },
  ) {}

  post(): void {
    const d = this.d;
    if (!d.state.folder) return;
    const saved = d.workspaceState.get<{ drafts?: Record<string, string>; globalDraft?: string }>(
      DRAFTS_KEY(d.state.folder.uri.toString()),
    );
    d.post({ type: "drafts", drafts: saved?.drafts ?? {}, globalDraft: saved?.globalDraft });
  }

  async save(sessionId: string | undefined, text: string): Promise<void> {
    const d = this.d;
    if (!d.state.folder) return;
    const key = DRAFTS_KEY(d.state.folder.uri.toString());
    const saved = d.workspaceState.get<{ drafts?: Record<string, string>; globalDraft?: string }>(key) ?? {};
    if (sessionId === undefined) {
      await d.workspaceState.update(key, { ...saved, globalDraft: text });
    } else {
      await d.workspaceState.update(key, { ...saved, drafts: { ...saved.drafts, [sessionId]: text } });
    }
  }
}

/** Removes drafts of deleted sessions; shared by bulk delete and the delete-session command. */
export async function deleteDrafts(workspaceState: vscode.Memento, folderUri: vscode.Uri, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const key = DRAFTS_KEY(folderUri.toString());
  const saved = workspaceState.get<{ drafts?: Record<string, string> }>(key) ?? {};
  if (!saved.drafts) return;
  const drafts = { ...saved.drafts };
  for (const id of ids) delete drafts[id];
  await workspaceState.update(key, { ...saved, drafts });
}
