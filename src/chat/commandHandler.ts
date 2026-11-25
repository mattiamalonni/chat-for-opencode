/**
 * Dispatches messages coming from the webview.
 *
 * This was a ~260-line switch inside `ChatController` with modal dialogs, destructive actions and
 * session/model mutations inline. The hooks below are the entire boundary to the host: the handler
 * decides *which* action a message means, the controller owns *how* that action is carried out. A
 * fake hooks object can exercise every command without an Extension Development Host.
 */
import type * as vscode from "vscode";
import type { FileDiff, ModelRef, SessionInfo } from "../shared/api";
import type { ActionId, Attachment, ContextItem, DroppedFile, HostMessage, WebviewMessage } from "../shared/protocol";
import type { OpenCodeClient } from "../client/http";
import type { ExecutionStateService } from "./executionState";
import type { Generation } from "./generation";
import type { FileIconsResponse } from "./fileIconTheme";
import { compatibilityKey } from "../shared/compatibility";
import { COMPAT_DISMISSED_KEY, CONTRACT_DISMISSED_KEY } from "./storageKeys";
import { deleteDrafts } from "./services/draftActions";

export interface CommandHandlerHooks {
  getClient(): OpenCodeClient | undefined;
  getSessionId(): string | undefined;
  getFolder(): vscode.WorkspaceFolder | undefined;
  getStatus(): string;
  clearFailedPrompt(): void;
  post(msg: HostMessage): void;
  postInit(): void;
  postConnection(): void;
  postDrafts(): void;
  postLocalIdle(sid: string, generation: number): void;
  connect(): Promise<void>;
  loadAll(): Promise<void>;
  loadSession(info: SessionInfo, stale?: () => boolean): Promise<void>;
  send(text: string, attachments: Attachment[], context: ContextItem[], delivery?: "steer" | "queue", sessionId?: string): Promise<boolean>;
  newSession(): Promise<void>;
  saveDraft(sid: string | undefined, text: string): Promise<void>;
  refreshSessions(): Promise<void>;
  loadMoreSessions(): Promise<void>;
  setAutoApprove(enabled: boolean): Promise<void>;
  dropFiles(files: DroppedFile[]): Promise<void>;
  pickFiles(): Promise<void>;
  openFile(path: string): Promise<void>;
  openToolFile(path: string): Promise<void>;
  openAttachment(uri: string): Promise<void>;
  openLink(href: string): Promise<void>;
  runAction(id: ActionId): Promise<void>;
  switchFolder(folder: vscode.WorkspaceFolder | undefined): Promise<void>;
  refreshChanges(): Promise<FileDiff[]>;
  syncNow(): Promise<void>;
  compact(): Promise<void>;
  revertToTurn(sessionId: string, messageID: string, text: string, files: boolean): Promise<void>;
  forkConversation(): Promise<boolean>;
  regenerateTurn(sessionId: string, messageID: string, text: string, attachments: Attachment[]): Promise<void>;
  refreshInbox(sid: string): Promise<void>;
  deleteAllSessions(): Promise<void>;
  catalog: {
    selectedModel?: ModelRef;
    selectedAgent?: string;
    selectModel(model: ModelRef): void;
    selectAgent(agent: string): void;
  };
  sessionList: { forget(ids: Iterable<string>): void; rename(id: string, title: string): boolean };
  subagents: { snapshot(id: string): Promise<void> };
  execution: ExecutionStateService;
  generation: Generation;
  getFileIndex(): { search(query: string): Promise<Attachment[]> } | undefined;
  applyCode(text: string, path?: string): Promise<void>;
  usePrompt(id: string): Promise<void>;
  saveInstruction(text: string): Promise<void>;
  fileIcons: { resolve(paths: string[]): Promise<FileIconsResponse> };
  diffs: {
    open(root: vscode.Uri, file: string, patch: string, applied: boolean): Promise<void>;
    openCombined(files: Array<{ file: string; patch: string }>, root?: vscode.Uri): Promise<void>;
  };
  workspaceState: vscode.Memento;
  globalState: vscode.Memento;
  /** Host-only services. The handler itself must stay importable without the VS Code runtime. */
  t(message: string, ...args: (string | number)[]): string;
  confirmDanger(opts: { title: string; detail: string; choices: string[] }): Promise<string | undefined>;
  copyToClipboard(text: string): Promise<void>;
  getWorkspaces(): readonly vscode.WorkspaceFolder[];
  log(line: string): void;
}

export class ChatCommandHandler {
  constructor(private readonly hooks: CommandHandlerHooks) {}

  async handle(msg: WebviewMessage): Promise<void> {
    const h = this.hooks;
    switch (msg.type) {
      case "ready":
        h.postInit();
        h.postConnection();
        h.postDrafts();
        if (h.getClient() && h.getStatus() !== "error") await h.loadAll();
        else await h.connect();
        return;
      case "send":
        await h.send(msg.text, msg.attachments, msg.context, msg.delivery, msg.sessionId);
        return;
      case "abort": {
        // A child session can be stopped from its conversation modal. It has no main composer to
        // unlock, so its local-idle fallback goes on the subagent channel instead.
        const sid = msg.sessionId ?? h.getSessionId();
        const generation = h.execution.generation.current();
        if (h.getClient() && sid) {
          try {
            await h.getClient()!.interrupt(sid);
          } finally {
            // A second interrupt on an idle session emits no terminal event; a failed one (500)
            // must not leave the composer stuck either, so clear busy locally on both paths.
            if (sid === h.getSessionId()) {
              h.postLocalIdle(sid, generation);
            } else {
              h.post({
                type: "subagentEvent",
                sessionId: sid,
                event: { type: "session.status", data: { sessionID: sid, status: { type: "idle", local: true } } },
              });
            }
          }
        }
        return;
      }
      case "newSession":
        return h.newSession();
      case "selectSession": {
        if (!h.getClient()) return;
        h.clearFailedPrompt();
        const generation = h.generation.bump();
        const info = await h.getClient()!.getSession(msg.id);
        if (!h.generation.is(generation)) return;
        return h.loadSession(info, () => !h.generation.is(generation));
      }
      case "deleteSession":
        if (!h.getClient()) return;
        await h.getClient()!.deleteSession(msg.id);
        h.sessionList.forget([msg.id]);
        await this.deleteDraft(msg.id);
        if (msg.id === h.getSessionId()) await h.newSession();
        else await h.refreshSessions();
        return;
      case "deleteAllSessions": {
        const answer = await h.confirmDanger({
          title: h.t("Delete all sessions?"),
          detail: h.t("Every session in this workspace will be permanently removed. This cannot be undone."),
          choices: [h.t("Delete all")],
        });
        if (answer !== h.t("Delete all")) return;
        return h.deleteAllSessions();
      }
      case "renameSession": {
        if (!h.getClient()) return;
        const title = msg.title.trim();
        if (!title) return;
        await h.getClient()!.renameSession(msg.id, title);
        // Optimistic update: the header/list react even when the live event is missed.
        h.sessionList.rename(msg.id, title);
        if (msg.id === h.getSessionId())
          // Both fields come from the already-validated webview message; the shape matches ServerEvent.
          h.post({ type: "event", event: { type: "session.renamed", data: { sessionID: msg.id, title } } });
        return;
      }
      case "refreshSessions":
        return h.refreshSessions();
      case "loadMoreSessions":
        return h.loadMoreSessions();
      case "setModel": {
        const previous = h.catalog.selectedModel;
        try {
          // The server owns the session's model: commit the UI only after it accepted the switch.
          if (h.getClient() && h.getSessionId()) await h.getClient()!.switchModel(h.getSessionId()!, msg.model);
          h.catalog.selectModel(msg.model);
        } catch (err) {
          if (previous) h.catalog.selectModel(previous);
          throw err;
        }
        return;
      }
      case "setAgent": {
        const previous = h.catalog.selectedAgent;
        try {
          if (h.getClient() && h.getSessionId()) await h.getClient()!.switchAgent(h.getSessionId()!, msg.agent);
          h.catalog.selectAgent(msg.agent);
        } catch (err) {
          if (previous) h.catalog.selectAgent(previous);
          throw err;
        }
        return;
      }
      case "setAutoApprove":
        return h.setAutoApprove(msg.enabled);
      case "saveDraft":
        return h.saveDraft(msg.sessionId, msg.text);
      case "permissionReply": {
        const sid = msg.sessionId;
        const generation = h.execution.generation.current();
        try {
          await h.getClient()?.replyPermission(sid, msg.requestId, msg.decision);
          // Rejecting a tool call ends the turn: stop its generation too, or the model keeps
          // answering and the composer stays on "stop" with no card left to act on.
          if (msg.decision === "reject" && h.getClient() && sid) {
            try {
              await h.getClient()!.interrupt(sid);
            } catch (err) {
              h.log(`[chat] interrupt after permission reject failed: ${String(err)}`);
            }
          }
        } finally {
          if (msg.decision === "reject") h.postLocalIdle(sid, generation);
        }
        return;
      }
      case "formReply":
        await h.getClient()?.replyForm(msg.sessionId, msg.formId, msg.answer);
        return;
      case "formCancel": {
        const sid = msg.sessionId;
        const generation = h.execution.generation.current();
        try {
          await h.getClient()?.cancelForm(sid, msg.formId);
          if (h.getClient() && sid) {
            try {
              await h.getClient()!.interrupt(sid);
            } catch (err) {
              h.log(`[chat] interrupt after form cancel failed: ${String(err)}`);
            }
          }
        } finally {
          // The server may answer with only `form.cancelled` and no terminal execution event.
          h.postLocalIdle(sid, generation);
        }
        return;
      }
      case "searchFiles": {
        const items = (await h.getFileIndex()?.search(msg.query)) ?? [];
        h.post({ type: "fileResults", query: msg.query, items });
        return;
      }
      case "applyCode": {
        await h.applyCode(msg.text, msg.path);
        return;
      }
      case "usePrompt": {
        await h.usePrompt(msg.id);
        return;
      }
      case "saveInstruction": {
        await h.saveInstruction(msg.text);
        return;
      }
      case "fileIcons": {
        try {
          h.post({ type: "fileIcons", ...(await h.fileIcons.resolve(msg.paths)) });
        } catch (err) {
          h.log(`[chat] file icon theme: ${String(err)}`);
          // A broken theme must not make the webview retry forever: answer with explicit misses and
          // reset so fonts registered by the previous theme are not kept around.
          h.post({ type: "fileIcons", reset: true, icons: Object.fromEntries(msg.paths.map((p) => [p, null])), fonts: {} });
        }
        return;
      }
      case "dropFiles":
        return h.dropFiles(msg.files);
      case "pickFiles":
        return h.pickFiles();
      case "openDiff":
        if (h.getFolder()) await h.diffs.open(h.getFolder()!.uri, msg.file, msg.patch, msg.applied);
        return;
      case "openDiffs":
        // Native per-file diffs when a folder is available; hunk-only patch view otherwise.
        await h.diffs.openCombined(msg.files, h.getFolder()?.uri);
        return;
      case "openFile":
        return h.openFile(msg.path);
      case "openToolFile":
        return h.openToolFile(msg.path);
      case "openAttachment":
        return h.openAttachment(msg.uri);
      case "openLink":
        return h.openLink(msg.href);
      case "copy":
        await h.copyToClipboard(msg.text);
        return;
      case "action":
        return h.runAction(msg.id);
      case "selectFolder":
        return h.switchFolder(h.getWorkspaces().find((f) => f.uri.toString() === msg.uri));
      case "refreshChanges":
        return void (await h.refreshChanges());
      case "sync":
        return h.syncNow();
      case "refreshSubagent":
        // The card was expanded but its live events may have been missed; fetch the child history.
        return void (await h.subagents.snapshot(msg.sessionId));
      case "compact":
        return h.compact();
      case "revertTo": {
        if (!h.getClient() || !h.getSessionId() || msg.sessionId !== h.getSessionId()) return;
        const rollback = h.t("Roll back");
        const messagesOnly = h.t("Messages only");
        const choice = await h.confirmDanger({
          title: h.t("Roll back to this turn?"),
          detail: h.t(
            "The selected prompt, its reply and every later turn will be removed from the conversation. 'Roll back' also restores file changes made after that point; 'Messages only' keeps the current files. The prompt returns to the composer so you can edit and resend it.",
          ),
          choices: [rollback, messagesOnly, h.t("Cancel")],
        });
        if (choice !== rollback && choice !== messagesOnly) return;
        return h.revertToTurn(msg.sessionId, msg.messageID, msg.text, choice === rollback);
      }
      case "fork":
        await h.forkConversation();
        return;
      case "regenerate": {
        if (!h.getClient() || !h.getSessionId() || msg.sessionId !== h.getSessionId()) return;
        const regenerate = h.t("Regenerate");
        const choice = await h.confirmDanger({
          title: h.t("Regenerate this response?"),
          detail: h.t(
            "The reply and every later turn will be removed and your prompt sent again. Your files stay untouched. Use Roll back if you want to restore files too.",
          ),
          choices: [regenerate, h.t("Cancel")],
        });
        if (choice !== regenerate) return;
        return h.regenerateTurn(msg.sessionId, msg.messageID, msg.text, msg.attachments);
      }
      case "setInboxDelivery": {
        if (!h.getClient() || msg.sessionId !== h.getSessionId()) return;
        await h.getClient()!.setInboxDelivery(msg.sessionId, msg.inboxId, msg.delivery);
        return h.refreshInbox(msg.sessionId);
      }
      case "cancelInbox": {
        if (!h.getClient() || msg.sessionId !== h.getSessionId()) return;
        await h.getClient()!.cancelInbox(msg.sessionId, msg.inboxId);
        return h.refreshInbox(msg.sessionId);
      }
      case "dismissCompatibility":
        await h.globalState.update(COMPAT_DISMISSED_KEY, compatibilityKey(msg.version) ?? msg.version);
        return;
      case "dismissContract":
        await h.globalState.update(CONTRACT_DISMISSED_KEY, msg.signature);
        h.postConnection();
        return;
    }
  }

  private async deleteDraft(id: string): Promise<void> {
    const h = this.hooks;
    const folder = h.getFolder();
    if (!folder) return;
    await deleteDrafts(h.workspaceState, folder.uri, [id]);
  }
}
