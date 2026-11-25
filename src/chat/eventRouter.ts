/**
 * Routes normalized server events to the chat's state owners.
 *
 * A dedicated router separates subagent bookkeeping, inbox scheduling,
 * turn lifecycle, notifications and picker refreshes. The hooks below are the whole boundary: the
 * router knows *what* an event means, the controller owns *how* each side effect is performed. Unit
 * tests can therefore drive the router with fakes instead of a VS Code host.
 */
import * as vscode from "vscode";
import type { ServerEvent } from "../shared/api";
import { normalizeServerEvent } from "../shared/adapter";
import { eventSessionId } from "../shared/chatReducer";
import type { SubagentCreated } from "./subagentTracker";
import type { BoundedSet } from "../shared/boundedSet";
import type { HostMessage } from "../shared/protocol";
import { parseSubagentReport } from "../shared/subagentReport";
import type { ExecutionStateService, TerminalStatus } from "./executionState";

export interface EventRouterHooks {
  getSessionId(): string | undefined;
  getFolderUri(): vscode.Uri | undefined;
  isVisible(): boolean;
  noteSessionEvent(): void;
  post(msg: HostMessage): void;
  postSessionEvent(sid: string, event: ServerEvent): void;
  subagents: {
    setParent(id: string, parentId: string): void;
    isTracked(id: string): boolean;
    track(id: string, created?: SubagentCreated): void;
    hasChild(id: string): boolean;
    snapshot(id: string): Promise<void>;
    forget(id: string): void;
  };
  permissions: { forgetRequest(requestId: string): void; enabled(sessionId: string | undefined): boolean };
  /** Cards from other clients on the same server; the hook ignores sessions we already show. */
  external: {
    observe(event: ServerEvent, sid: string | undefined, isCurrent: boolean, isChild: boolean): void;
    forget(sid: string): void;
  };
  execution: ExecutionStateService;
  attention: BoundedSet<string>;
  scheduleInbox(): void;
  scheduleSessions(): void;
  scheduleReconcile(): void;
  scheduleChanges(): void;
  refreshSlashItems(): Promise<void>;
  autoApprove(event: ServerEvent, sid: string): Promise<void>;
  newSession(): Promise<void>;
}

const LIST_REFRESH_EVENTS = new Set([
  "session.created",
  "session.renamed",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.status",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
]);

export class ChatEventRouter {
  constructor(private readonly hooks: EventRouterHooks) {}

  route(incoming: ServerEvent): void {
    const h = this.hooks;
    const event = normalizeServerEvent(incoming);
    if (!event) return;
    const sid = eventSessionId(event);
    const isCurrent = sid === h.getSessionId();
    const isChild = !!sid && h.subagents.isTracked(sid);
    if (sid && isCurrent) h.noteSessionEvent();
    h.external.observe(event, sid, isCurrent, isChild);

    if (event.type === "session.created") {
      const data = event.data as { sessionID?: string; parentID?: string; title?: string; agent?: string };
      if (data.sessionID && data.parentID) {
        h.subagents.setParent(data.sessionID, data.parentID);
        if (h.subagents.isTracked(data.sessionID)) h.subagents.track(data.sessionID, data);
      }
    }

    if (
      sid === h.getSessionId() &&
      (event.type === "session.tool.progress" || event.type === "session.tool.success" || event.type === "session.tool.failed")
    ) {
      const data = event.data as { id?: unknown; metadata?: { sessionID?: unknown } };
      const childId = data.metadata?.sessionID;
      if (typeof childId === "string" && childId) {
        h.subagents.track(childId);
        // Explicit id, not the title: concurrent children can share a description, and the tool
        // card may be created after this event. The webview remembers the id until it appears.
        if (typeof data.id === "string" && data.id) h.post({ type: "linkSubagent", toolId: data.id, sessionId: childId });
      }
    }

    if (sid === h.getSessionId() && event.type === "session.inbox.enqueued") {
      // A background child announces its report after the parent turn ended: re-read its history
      // now, when the steps and report are actually complete.
      const item = (event.data as { item?: { type?: string; payload?: { text?: string } } }).item;
      const parsed = item?.type === "synthetic" ? parseSubagentReport(item.payload?.text) : undefined;
      const openId = h.getSessionId();
      if (parsed && openId) {
        h.subagents.setParent(parsed.sessionId, openId);
        if (h.subagents.hasChild(parsed.sessionId)) void h.subagents.snapshot(parsed.sessionId);
        else h.subagents.track(parsed.sessionId);
      }
    }

    if (
      sid === h.getSessionId() &&
      (event.type === "session.inbox.enqueued" ||
        event.type === "session.inbox.delivered" ||
        event.type === "session.inbox.cancelled" ||
        event.type === "session.inbox.delivery.changed")
    ) {
      h.scheduleInbox();
    }
    if (event.type === "session.deleted" && sid && h.subagents.hasChild(sid)) h.subagents.forget(sid);

    if (event.type === "permission.replied") {
      const requestId = (event.data as { requestID?: string }).requestID;
      if (requestId) h.permissions.forgetRequest(requestId);
      h.attention.delete(`permission.asked:${requestId}`);
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      h.attention.delete(`form.created:${(event.data as { id?: string }).id}`);
    }

    // Plugins can register/remove skills and commands while the chat is open.
    if (event.type === "skill.updated" || event.type === "command.updated") void h.refreshSlashItems();

    // Auto-approve at arrival so a child's `ask` permission cannot block with no inline card.
    if (event.type === "permission.asked" && sid && h.subagents.isTracked(sid) && h.permissions.enabled(h.getSessionId())) {
      void h.autoApprove(event, sid);
      return;
    }

    if (sid) h.postSessionEvent(sid, event);

    // One owner for turn starts and terminals: generation, local-idle grace and host status.
    const terminal = h.execution.observe(event.type, sid, h.getSessionId());
    if (LIST_REFRESH_EVENTS.has(event.type)) h.scheduleSessions();

    if (terminal) this.announceTerminal(sid, terminal);
    if (event.type === "session.deleted" && sid === h.getSessionId()) void h.newSession();
    if (sid === h.getSessionId() && event.type === "session.step.ended") {
      const files = (event.data as { files?: string[] }).files;
      if (files && files.length > 0) h.scheduleChanges();
    }
    this.announcePendingRequest(event, sid);
  }

  private announceTerminal(sid: string | undefined, status: TerminalStatus): void {
    const h = this.hooks;
    h.scheduleReconcile();
    // A resync can replay the terminal event: include the turn token in the dedup key.
    const key = `execution.terminal:${sid}:${h.execution.generation.current()}`;
    if (h.isVisible() || h.attention.has(key)) return;
    const cfg = vscode.workspace.getConfiguration("opencode", h.getFolderUri());
    const enabled = status === "failed" ? cfg.get<boolean>("notifyOnFailure", true) : cfg.get<boolean>("notifyOnComplete", false);
    if (!enabled) return;
    h.attention.add(key);
    const message =
      status === "failed"
        ? vscode.l10n.t("OpenCode turn failed.")
        : status === "interrupted"
          ? vscode.l10n.t("OpenCode turn was interrupted.")
          : vscode.l10n.t("OpenCode turn finished.");
    void this.showAndFocus(message);
  }

  private announcePendingRequest(event: ServerEvent, sid: string | undefined): void {
    const h = this.hooks;
    if (!sid || !h.subagents.isTracked(sid) || h.isVisible()) return;
    if (event.type !== "permission.asked" && event.type !== "form.created") return;
    const id = event.type === "permission.asked" ? (event.data as { id?: string }).id : (event.data as { form?: { id?: string } }).form?.id;
    if (!id) return;
    const key = `${event.type}:${id}`;
    // A resync re-posts the same pending request: announce it once, not on every event.
    if (h.attention.has(key)) return;
    h.attention.add(key);
    const message =
      event.type === "permission.asked"
        ? vscode.l10n.t("OpenCode is asking for permission.")
        : vscode.l10n.t("OpenCode is asking a question.");
    void this.showAndFocus(message);
  }

  private async showAndFocus(message: string): Promise<void> {
    const open = vscode.l10n.t("Open chat");
    const choice = await vscode.window.showInformationMessage(message, open);
    if (choice === open) await vscode.commands.executeCommand("opencode.chatView.focus");
  }
}
