import * as vscode from "vscode";
import type { OpenCodeClient, PermissionRule } from "../../client/http";
import { ExternalServer } from "../../server/server";
import type { FileAttachment, SessionInfo } from "../../shared/api";
import { DEFAULT_SESSION_PERMISSIONS } from "../permissions";
import type { Attachment, ContextItem, HostMessage } from "../../shared/protocol";
import { resolveAttachment } from "../attachments";
import { mimeFromName } from "../attachmentService";
import type { CatalogService } from "../catalogService";
import type { ControllerState } from "./controllerState";
import { translatedStrings } from "./controllerSupport";
import type { ChatDraftActions } from "./draftActions";
import type { ChatFileActions } from "./fileActions";
import type { ExecutionStateService } from "../executionState";
import type { ChatLifecycle } from "../lifecycle";
import type { ProjectInstructionService } from "../projectInstructions";
import type { PromptLibraryService } from "../promptLibrary";
import type { ChatSessionService } from "./sessionService";
import type { SessionListService } from "../sessionListService";
import type { ServerHandle } from "../../server/server";

export interface PromptActionDeps {
  state: ControllerState;
  execution: ExecutionStateService;
  lifecycle: ChatLifecycle;
  catalog: CatalogService;
  sessionList: SessionListService;
  prompts: PromptLibraryService;
  projectInstructions: ProjectInstructionService<vscode.Uri>;
  fileActions: ChatFileActions;
  draftActions: ChatDraftActions;
  sessionService: ChatSessionService;
  output: vscode.LogOutputChannel;
  learnSession(info: SessionInfo): void;
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
   * Copy the whole conversation into a new sibling session and open it. The original keeps its
   * history and files, so unlike a rollback this is a non-destructive "what if" from the current
   * point. A turn in flight is refused: the fork must snapshot a settled history.
   */
  async forkConversation(): Promise<boolean> {
    const s = translatedStrings();
    const client = this.d.getClient();
    const sid = this.d.state.sessionId;
    if (!client || !sid) {
      this.d.post({ type: "notice", error: { kind: "requestFailed", message: s["error.forkFailed"], actions: [] } });
      return false;
    }
    if (this.d.execution.state.status === "running") {
      this.d.post({ type: "notice", error: { kind: "requestFailed", message: s.forkBusy, actions: [] } });
      return false;
    }
    const generation = this.d.lifecycle.generations.load.bump();
    try {
      const info = await client.forkSession(sid);
      if (!this.d.lifecycle.generations.load.is(generation) || client !== this.d.getClient()) return false;
      this.d.sessionList.addFork(info.id);
      await this.d.sessionService.loadSession(
        info,
        () => !this.d.lifecycle.generations.load.is(generation) || client !== this.d.getClient(),
      );
      if (client !== this.d.getClient()) return false;
      // A pending retry belongs to the session we just left: never replay it into the branch.
      this.d.state.failedPrompt = undefined;
      this.d.post({ type: "forked", sessionId: info.id, title: info.title });
      return true;
    } catch (err) {
      this.d.post({
        type: "notice",
        error: {
          kind: "requestFailed",
          message: s["error.forkFailed"],
          detail: err instanceof Error ? err.message : String(err),
          actions: ["showLogs"],
        },
      });
      return false;
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

  /** A failed child prompt is reported as a notice: the main composer still owns its own draft. */
  private failChild(detail: string): boolean {
    const s = translatedStrings();
    this.d.post({
      type: "notice",
      error: { kind: "requestFailed", message: s["error.promptFailed"], detail, actions: ["showLogs"] },
    });
    return false;
  }

  /**
   * Returns false when the prompt never reached the server (no notice is posted for stale loads).
   * `targetSessionId` addresses a subagent from its conversation modal: that prompt must not start a
   * turn, load a session or restore a draft in the main chat.
   */
  async send(
    text: string,
    attachments: Attachment[],
    context: ContextItem[],
    delivery?: "steer" | "queue",
    targetSessionId?: string,
  ): Promise<boolean> {
    const child = !!targetSessionId && targetSessionId !== this.d.state.sessionId;
    // Local `/fork`: snapshot the current session first, then deliver the rest of the prompt to the
    // branch. Intercepted before catalog commands so a server-provided `/fork` cannot shadow it.
    const forkCommand = child ? undefined : /^\/fork(?:\s+([\s\S]*))?$/.exec(text);
    if (forkCommand) {
      if (!(await this.forkConversation())) {
        // A refused fork must not eat what the user typed (including its files).
        this.d.prefillDraft(text, attachments);
        return false;
      }
      const continuation = (forkCommand[1] ?? "").trim();
      return continuation ? await this.send(continuation, attachments, context, delivery) : true;
    }
    // A queued message starts no turn yet: leave the current turn's reconcile generation alone.
    const turn = {
      generation: delivery === "queue" || child ? undefined : this.d.execution.start(this.d.state.sessionId),
    };
    if (delivery !== "queue" && !child) this.d.lifecycle.cancel("reconcile");
    if (!this.d.getClient()) await this.d.connect();
    const client = this.d.getClient();
    if (!client || (!child && !this.d.state.folder)) {
      if (child) return this.failChild(translatedStrings()["error.connectionLost"]);
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
      const folder = this.d.state.folder;
      if (!child && !this.d.state.sessionId && folder) {
        const permissions = vscode.workspace
          .getConfiguration("opencode", folder.uri)
          .get<PermissionRule[]>("sessionPermissions", DEFAULT_SESSION_PERMISSIONS);
        const loadGeneration = this.d.lifecycle.generations.load.bump();
        const info = await client.createSession({
          directory: folder.uri.fsPath,
          agent: this.d.catalog.selectedAgent,
          model: this.d.catalog.selectedModel,
          permissions,
        });
        // Register before the server emits events for it: the shared stream has no directory.
        this.d.learnSession(info);
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
      const sid = child ? targetSessionId! : this.d.state.sessionId;
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
      if (child) return true;
      this.d.state.failedPrompt = undefined;
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (child) return this.failChild(detail);
      await this.restoreFailedPrompt(text, attachments, context, delivery, this.d.state.sessionId, detail, turn.generation);
      return false;
    }
  }
}
