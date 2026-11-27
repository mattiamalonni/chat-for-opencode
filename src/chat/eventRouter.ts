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
import { parseBackgroundResult } from "../shared/backgroundResult";
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
  permissions: { forgetRequest(requestId: string): void; enabled(): boolean };
  /** Only sessions of this window's workspace are routed; the event stream itself is shared. */
  ownership: {
    owns(id: string): boolean;
    learn(raw: unknown): void;
    forget(id: string): void;
  };
  /** Cards from other clients on the same server; the hook ignores sessions we already show. */
  external: {
    observe(event: ServerEvent, sid: string | undefined, isCurrent: boolean, isChild: boolean): void;
    forget(sid: string): void;
  };
  /** Pending background jobs; optional so unit tests can drive the router without the registry. */
  jobs?: { observe(event: ServerEvent): void };
  postExternalCard(event: ServerEvent, sid: string): void;
  execution: ExecutionStateService;
  attention: BoundedSet<string>;
  scheduleInbox(): void;
  scheduleSessions(): void;
  scheduleReconcile(): void;
  scheduleChanges(): void;
  refreshSlashItems(): Promise<void>;
  autoApprove(event: ServerEvent, sid: string, onFailure?: () => void): Promise<void>;
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
    // Creation/deletion is allowed through: it is how new sessions are learned and stale cards
    // are cleared, even when their directory is not known yet.
    const lifecycleEvent = event.type === "session.created" || event.type === "session.deleted";
    if (event.type === "session.created") {
      h.ownership.learn(event.data);
      if (sid) h.ownership.owns(sid); // resolves unknown ids asynchronously
    }
    // The endpoint is shared across windows: drop events belonging to another workspace before
    // they can create cards, notifications or state changes here.
    if (sid && !lifecycleEvent && !h.ownership.owns(sid)) return;
    const isCurrent = sid === h.getSessionId();
    const isChild = !!sid && h.subagents.isTracked(sid);
    if (sid && isCurrent) h.noteSessionEvent();
    h.jobs?.observe(event);

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

    if (sid === h.getSessionId() && event.type === "session.tool.success") {
      // The turn ends as soon as a shell moves to the background, so neither the execution events
      // nor the busy timestamp change. Refresh the picker explicitly to show the "waiting" badge.
      const data = event.data as { input?: { background?: unknown }; content?: { type?: string; text?: string }[] };
      const backgrounded =
        data.input?.background === true ||
        (data.content ?? []).some((c) => c.type === "text" && /moved to the background/i.test(c.text ?? ""));
      if (backgrounded) h.scheduleSessions();
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
      // A background result settles the waiting badge; `inbox.enqueued` is not a turn event.
      if (item?.type === "synthetic") {
        const background = parseBackgroundResult(item.payload?.text);
        if (background) {
          h.scheduleSessions();
          this.announceBackgroundResult(sid, background.id);
        }
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
    if (event.type === "session.deleted" && sid) {
      h.ownership.forget(sid);
      if (h.subagents.hasChild(sid)) h.subagents.forget(sid);
    }

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

    // The toggle is workspace-wide: every owned session is auto-approved at arrival, so no card
    // blocks a turn even when its session is not the one currently open.
    if (event.type === "permission.asked" && sid && h.permissions.enabled()) {
      void h.autoApprove(event, sid, () => {
        if (isCurrent || isChild) h.postSessionEvent(sid, event);
        else h.postExternalCard(event, sid);
        // The request now waits on the user after all: give it the side effects a manual request
        // gets (waiting status, list badge, hidden-view notification) instead of a silent card.
        h.execution.observe(event.type, sid, h.getSessionId());
        h.scheduleSessions();
        this.announcePendingRequest(event, sid);
      });
      return;
    }

    h.external.observe(event, sid, isCurrent, isChild);
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
    const enabled = status === "succeeded" ? cfg.get<boolean>("notifyOnComplete", false) : cfg.get<boolean>("notifyOnFailure", true);
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

  private announceBackgroundResult(sid: string | undefined, id: string | undefined): void {
    const h = this.hooks;
    if (!sid || h.isVisible()) return;
    const key = `background:${sid}:${id ?? ""}`;
    if (h.attention.has(key)) return;
    h.attention.add(key);
    void this.showAndFocus(vscode.l10n.t("OpenCode finished a background command."));
  }

  private announcePendingRequest(event: ServerEvent, sid: string | undefined): void {
    const h = this.hooks;
    // The open session and its children are "tracked" too; they are exactly the ones whose cards
    // the user cannot see while the view is hidden, so they must be announced as well.
    if (!sid || h.isVisible()) return;
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
