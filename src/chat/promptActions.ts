import * as vscode from "vscode";
import type { OpenCodeClient, PermissionRule } from "../client/http";
import { ExternalServer } from "../server/server";
import type { FileAttachment } from "../shared/api";
import { DEFAULT_SESSION_PERMISSIONS } from "./permissions";
import type { Attachment, ContextItem, HostMessage } from "../shared/protocol";
import { resolveAttachment } from "./attachments";
import { mimeFromName } from "./attachmentService";
import type { CatalogService } from "./catalogService";
import type { ControllerState } from "./controllerState";
import { translatedStrings } from "./controllerSupport";
import type { ChatDraftActions } from "./draftActions";
import type { ChatFileActions } from "./fileActions";
import type { ExecutionStateService } from "./executionState";
import type { ChatLifecycle } from "./lifecycle";
import type { PermissionService } from "./permissionService";
import type { ProjectInstructionService } from "./projectInstructions";
import type { PromptLibraryService } from "./promptLibrary";
import type { ChatSessionService } from "./sessionService";
import type { SessionListService } from "./sessionListService";
import type { ServerHandle } from "../server/server";

export interface PromptActionDeps {
  state: ControllerState;
  execution: ExecutionStateService;
  lifecycle: ChatLifecycle;
  catalog: CatalogService;
  permissions: PermissionService;
  sessionList: SessionListService;
  prompts: PromptLibraryService;
  projectInstructions: ProjectInstructionService<vscode.Uri>;
  fileActions: ChatFileActions;
  draftActions: ChatDraftActions;
  sessionService: ChatSessionService;
  output: vscode.LogOutputChannel;
  getClient(): OpenCodeClient | undefined;
  getServer(): ServerHandle | undefined;
  connect(): Promise<void>;
  prefillDraft(text: string, attachments: Attachment[]): void;
  post(msg: HostMessage): void;
}

/** Prompt delivery and the history-mutating turn actions (revert, fork, regenerate). */
export class ChatPromptActions {
  constructor(private readonly d: PromptActionDeps) {}

  async usePrompt(id: string): Promise<void> {
    if (!id) return;
    const text = await this.d.prompts.resolve(id);
    if (text === undefined) {
      this.d.output.warn(`[chat] unknown prompt: ${id}`);
      return;
    }
    this.d.prefillDraft(text, []);
  }

  async saveInstruction(text: string): Promise<void> {
    await this.d.projectInstructions.save(text);
  }

  async compact(): Promise<void> {
    const sid = this.d.state.sessionId;
    const client = this.d.getClient();
    if (!sid || !client) return;
    try {
      await client.compact(sid);
      this.d.output.info("[chat] compaction requested");
    } catch (err) {
      const s = translatedStrings();
      this.d.post({
        type: "notice",
        error: {
          kind: "requestFailed",
          message: s["error.compactFailed"],
          detail: err instanceof Error ? err.message : String(err),
          actions: ["showLogs"],
        },
      });
    }
  }

  /**
   * Roll a session back to the turn opened by `messageID`. OpenCode stages a boundary (optionally
   * restoring files), then `commit` drops the boundary message and everything after it. Public so
   * tests can exercise the flow without the native confirmation dialog.
   */
  async revertToTurn(sessionId: string, messageID: string, text: string, files: boolean): Promise<void> {
    if (await this.revertBoundary(sessionId, messageID, files)) this.d.post({ type: "reverted", sessionId, text });
  }

  /** Shared boundary stage/commit/reload, used by both rollback and regenerate. */
  async revertBoundary(sessionId: string, messageID: string, files: boolean): Promise<boolean> {
    const client = this.d.getClient();
    if (!client || sessionId !== this.d.state.sessionId) return false;
    this.d.execution.generation.bump();
    const generation = this.d.lifecycle.generations.load.bump();
    try {
      // Staging is rejected while the agent loop runs, and an interrupt can acknowledge before
      // execution settles; wait for idle just like OpenCode's own rewind does.
      await client.interrupt(sessionId).catch(() => false);
      await client.waitIdle(sessionId).catch(() => undefined);
      await client.revertStage(sessionId, messageID, files);
      try {
        await client.revertCommit(sessionId);
      } catch (err) {
        // `stage` already restored the files: undo that side effect if the commit did not land.
        await client.revertClear(sessionId).catch(() => undefined);
        throw err;
      }
      if (!this.d.lifecycle.generations.load.is(generation) || sessionId !== this.d.state.sessionId) return false;
      const info = await client.getSession(sessionId);
      if (!this.d.lifecycle.generations.load.is(generation) || sessionId !== this.d.state.sessionId) return false;
      // A commit deletes messages, so a tail resync cannot detect it: rebuild from history.
      await this.d.sessionService.loadSession(
        info,
        () => !this.d.lifecycle.generations.load.is(generation) || sessionId !== this.d.state.sessionId,
      );
      return true;
    } catch (err) {
      const s = translatedStrings();
      throw new Error(`${s["error.revertFailed"]} ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /**
   * Drop the reply after `messageID` without touching files, then resend the original prompt.
   * The model/agent selection stays as the user left it, so the retry uses the current settings.
   */
  async regenerateTurn(sessionId: string, messageID: string, text: string, attachments: Attachment[]): Promise<void> {
    if (!(await this.revertBoundary(sessionId, messageID, false))) return;
    await this.send(text, attachments, [], undefined);
  }

  /**
   * Copy the conversation up to `messageID` into a new sibling session and open it. The original
   * keeps its full history and files, so unlike a rollback this is a non-destructive "what if".
   */
  async forkToTurn(sessionId: string, messageID: string): Promise<void> {
    const client = this.d.getClient();
    if (!client || sessionId !== this.d.state.sessionId) return;
    const generation = this.d.lifecycle.generations.load.bump();
    try {
      const info = await client.forkSession(sessionId, messageID);
      if (!this.d.lifecycle.generations.load.is(generation) || client !== this.d.getClient()) return;
      this.d.sessionList.addFork(info.id);
      await this.d.sessionService.loadSession(
        info,
        () => !this.d.lifecycle.generations.load.is(generation) || client !== this.d.getClient(),
      );
      if (client !== this.d.getClient()) return;
      this.d.post({ type: "forked", sessionId: info.id, title: info.title });
    } catch (err) {
      const s = translatedStrings();
      this.d.post({
        type: "notice",
        error: {
          kind: "requestFailed",
          message: s["error.forkFailed"],
          detail: err instanceof Error ? err.message : String(err),
          actions: ["showLogs"],
        },
      });
    }
  }

  async restoreFailedPrompt(
    text: string,
    attachments: Attachment[],
    context: ContextItem[],
    delivery: "steer" | "queue" | undefined,
    sid: string | undefined,
    detail: string,
    generation?: number,
  ): Promise<void> {
    this.d.state.failedPrompt = { text, attachments, context, delivery, sessionId: sid };
    if (sid) await this.d.draftActions.save(sid, text).catch(() => undefined);
    this.d.execution.fail(sid, generation);
    this.d.post({ type: "draftRestored", sessionId: sid, text });
    const s = translatedStrings();
    this.d.post({
      type: "notice",
      error: { kind: "promptFailed", message: s["error.promptFailed"], detail, actions: ["retry", "reconnect", "showLogs"] },
    });
  }

  /** Returns false when the prompt never reached the server (no notice is posted for stale loads). */
  async send(text: string, attachments: Attachment[], context: ContextItem[], delivery?: "steer" | "queue"): Promise<boolean> {
    // A queued message starts no turn yet: leave the current turn's reconcile generation alone.
    const turn = { generation: delivery === "queue" ? undefined : this.d.execution.start(this.d.state.sessionId) };
    if (delivery !== "queue") this.d.lifecycle.cancel("reconcile");
    if (!this.d.getClient()) await this.d.connect();
    const client = this.d.getClient();
    if (!client || !this.d.state.folder) {
      await this.restoreFailedPrompt(
        text,
        attachments,
        context,
        delivery,
        this.d.state.sessionId,
        translatedStrings()["error.connectionLost"],
        turn.generation,
      );
      return false;
    }
    const files: FileAttachment[] = [];
    const seen = new Set<string>();
    // An external server cannot stat our local `file:` URIs, so those attachments are sent inline.
    const externalServer = this.d.getServer() instanceof ExternalServer;
    for (const item of [...context, ...attachments]) {
      if (seen.has(item.uri)) continue;
      seen.add(item.uri);
      const resolved = await resolveAttachment(item, externalServer, mimeFromName);
      if (resolved.status === "tooLarge") {
        this.d.fileActions.noticeTooLarge(resolved.name);
        continue;
      }
      if (resolved.status === "unreadable") {
        this.d.fileActions.noticeUnreadable(resolved.name, resolved.detail);
        continue;
      }
      files.push(resolved.attachment);
    }
    try {
      if (!this.d.state.sessionId) {
        const permissions = vscode.workspace
          .getConfiguration("opencode", this.d.state.folder.uri)
          .get<PermissionRule[]>("sessionPermissions", DEFAULT_SESSION_PERMISSIONS);
        const autoApprove = this.d.permissions.takePending();
        const loadGeneration = this.d.lifecycle.generations.load.bump();
        const info = await client.createSession({
          directory: this.d.state.folder.uri.fsPath,
          agent: this.d.catalog.selectedAgent,
          model: this.d.catalog.selectedModel,
          permissions,
        });
        if (autoApprove !== undefined) {
          await this.d.permissions.write(info.id, autoApprove);
        }
        await this.d.sessionService.loadSession(info, () => !this.d.lifecycle.generations.load.is(loadGeneration), undefined, true);
        if (!this.d.lifecycle.generations.load.is(loadGeneration)) {
          this.d.execution.fail(this.d.state.sessionId, turn.generation);
          return false;
        }
        // Loading the freshly created session changes `sessionId`, which correctly closes the
        // previous session's turn. This prompt is still in flight, so re-arm it for the new id.
        if (turn.generation !== undefined && !this.d.execution.is(turn.generation)) {
          turn.generation = this.d.execution.start(this.d.state.sessionId);
        }
      }
      const sid = this.d.state.sessionId;
      if (!sid) {
        this.d.execution.fail(this.d.state.sessionId, turn.generation);
        return false;
      }
      const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      const command = slash && this.d.catalog.commands.find((c) => c.name === slash[1]);
      // A steer replaces the current answer: interrupt first, then send with the server's
      // steering delivery so OpenCode skips the rest of the old turn.
      if (delivery === "steer") await client.interrupt(sid).catch(() => false);
      if (command && slash) {
        await client.command(sid, command.name, (slash[2] ?? "").trim(), files, delivery);
      } else {
        await client.prompt(sid, text, files, delivery);
      }
      this.d.state.failedPrompt = undefined;
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.restoreFailedPrompt(text, attachments, context, delivery, this.d.state.sessionId, detail, turn.generation);
      return false;
    }
  }
}
