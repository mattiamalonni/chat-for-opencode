import * as vscode from "vscode";
import type { OpenCodeClient } from "../client/http";
import { loadBundle } from "../chat/viewProvider";
import { quoteForShell } from "../chat/shell";
import { describeServerError } from "../server/server";
import { isConnectWebviewMessage } from "../shared/protocolGuards";
import type { ConnectAttemptView, ConnectHostMessage, ConnectWebviewMessage } from "../shared/protocol";
import { STRINGS, type Strings } from "../shared/strings";

export interface ConnectControllerDeps {
  /** The chat's connection supervisor owns the server and password; reuse it instead of opening a second one. */
  getClient(): OpenCodeClient | undefined;
  /** Only called when the chat is not connected yet. `connect()` must not be repeated on an open server. */
  ensureClient(): Promise<OpenCodeClient | undefined>;
  getFolder(): vscode.Uri | undefined;
  /** Called after credentials change so the chat catalog and account status pick up new models. */
  onChanged(): Promise<void> | void;
  output: vscode.LogOutputChannel;
}

/**
 * Host side of the dedicated Connect panel (the graphical equivalent of `/connect`).
 *
 * It deliberately never keeps a key: the webview sends it in a single message, the host forwards it
 * to the local OpenCode server and discards it. Only {@link CredentialSummary}-like data (no secret
 * values) is ever posted back to the webview.
 */
export class ConnectController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private strings: Strings | undefined;
  private attempt: ConnectAttemptView | undefined;
  private poll: NodeJS.Timeout | undefined;
  private pollFailures = 0;
  private busy = false;
  private integrations: Awaited<ReturnType<OpenCodeClient["integrations"]>> = [];
  private subscriptions: vscode.Disposable[] = [];
  /** Cancels every in-flight request and poll when the panel is closed or the extension is disposed. */
  private abort = new AbortController();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly d: ConnectControllerDeps,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel(
      "opencode.connect",
      vscode.l10n.t("OpenCode – Connect provider"),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [dist],
        retainContextWhenHidden: false,
      },
    );
    this.attachPanel(panel);
  }

  /** Wires a new panel, or a tab restored after a VS Code reload, to this controller. */
  attachPanel(panel: vscode.WebviewPanel): void {
    this.resetAbort();
    this.panel = panel;
    loadBundle(panel.webview, this.extensionUri, "connect", vscode.l10n.t("OpenCode – Connect provider"));
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [
      panel.webview.onDidReceiveMessage((msg: unknown) => {
        if (isConnectWebviewMessage(msg)) void this.handle(msg);
        else this.d.output.warn("[connect] ignored an invalid webview message");
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) this.panel = undefined;
        this.onPanelClosed();
      }),
    ];
  }

  private get signal(): AbortSignal {
    return this.abort.signal;
  }

  private resetAbort(): void {
    if (this.abort.signal.aborted) this.abort = new AbortController();
  }

  private onPanelClosed(): void {
    this.abort.abort();
    this.clearAttempt();
  }

  private post(msg: ConnectHostMessage): void {
    void this.panel?.webview.postMessage(msg).then(undefined, () => undefined);
  }

  private localStrings(): Strings {
    return (this.strings ??= Object.fromEntries(Object.entries(STRINGS).map(([k, v]) => [k, vscode.l10n.t(v)])) as Strings);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.post({ type: "busy", busy });
  }

  private error(err: unknown): void {
    const message = describeServerError(err);
    this.d.output.error(`[connect] ${message}`);
    this.post({ type: "notice", kind: "error", message });
  }

  private async withBusy(run: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    try {
      await run();
    } catch (err) {
      if (!this.signal.aborted) this.error(err);
    } finally {
      this.setBusy(false);
    }
  }

  private get directory(): string | undefined {
    return this.d.getFolder()?.fsPath;
  }

  private async client(): Promise<OpenCodeClient> {
    // `ChatController.connect()` publishes a "starting" status even when the server is already
    // running, and a no-op reconnect never restores "connected". Reuse the live client instead.
    const client = this.d.getClient() ?? (await this.d.ensureClient());
    if (!client) throw new Error(this.localStrings().connectUnavailable);
    return client;
  }

  private async load(): Promise<void> {
    const client = await this.client();
    const [items, credentials] = await Promise.all([client.integrations(this.directory, this.signal), client.credentials(this.signal)]);
    this.integrations = items;
    this.post({ type: "integrations", items, credentials });
  }

  private async refresh(): Promise<void> {
    await this.load();
  }

  private async changed(): Promise<void> {
    await this.d.onChanged();
  }

  private beginAttempt(attempt: ConnectAttemptView): void {
    this.clearAttempt();
    this.attempt = attempt;
    this.pollFailures = 0;
    this.post({ type: "attempt", attempt });
    this.post({ type: "attemptStatus", status: "pending" });
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.signal.aborted) return;
    if (this.poll) clearTimeout(this.poll);
    this.poll = setTimeout(() => void this.pollAttempt(), 1200);
  }

  private clearAttempt(): void {
    if (this.poll) clearTimeout(this.poll);
    this.poll = undefined;
    this.attempt = undefined;
    this.pollFailures = 0;
  }

  private async pollAttempt(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    try {
      const client = await this.client();
      const status =
        attempt.kind === "oauth"
          ? await client.oauthStatus(attempt.integrationID, attempt.attemptID, this.directory, this.signal)
          : await client.commandStatus(attempt.integrationID, attempt.attemptID, this.directory, this.signal);
      if (this.signal.aborted || this.attempt !== attempt) return;
      this.pollFailures = 0;
      this.post({ type: "attemptStatus", status: status.status, message: status.message, url: status.url });
      if (status.status === "complete") {
        this.clearAttempt();
        this.post({ type: "attemptClosed" });
        await this.load();
        await this.changed();
        this.post({ type: "notice", kind: "success", message: this.localStrings().connectSuccess });
        return;
      }
      if (status.status === "failed") {
        this.clearAttempt();
        this.post({ type: "attemptClosed" });
        this.post({ type: "notice", kind: "error", message: status.message || String(this.localStrings().failed) });
        return;
      }
      this.schedulePoll();
    } catch (err) {
      if (this.signal.aborted || this.attempt !== attempt) return;
      this.pollFailures++;
      if (this.pollFailures >= 3) {
        this.clearAttempt();
        this.post({ type: "attemptClosed" });
        this.error(err);
        return;
      }
      this.schedulePoll();
    }
  }

  private async cancelAttempt(): Promise<void> {
    const attempt = this.attempt;
    this.clearAttempt();
    this.post({ type: "attemptClosed" });
    if (!attempt) return;
    const client = await this.client();
    if (attempt.kind === "oauth") await client.cancelOAuth(attempt.integrationID, attempt.attemptID, this.directory, this.signal);
    else await client.cancelCommand(attempt.integrationID, attempt.attemptID, this.directory, this.signal);
    await this.load();
  }

  /** Runs the exact command advertised by the server; the webview only names the method. */
  private async runCommand(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.kind !== "command") return;
    if (!vscode.workspace.isTrusted) {
      this.post({ type: "notice", kind: "error", message: this.localStrings()["error.untrustedWorkspace"] });
      return;
    }
    const integration = this.integrations.find((item) => item.id === attempt.integrationID);
    const method = integration?.methods.find((item) => item.id === attempt.methodID);
    if (!integration || !method || method.type !== "command" || !Array.isArray(method.command) || method.command.length === 0) {
      this.post({ type: "notice", kind: "error", message: this.localStrings().connectNoMethods });
      return;
    }
    const command = method.command.map((part) => quoteForShell(part)).join(" ");
    const terminal = vscode.window.createTerminal({ name: `OpenCode: ${integration.name}`, cwd: this.d.getFolder() });
    terminal.show();
    terminal.sendText(command);
  }

  private async handle(msg: ConnectWebviewMessage): Promise<void> {
    if (msg.type === "ready") {
      const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
      this.post({ type: "init", strings: this.localStrings(), platform });
      await this.withBusy(() => this.refresh());
      return;
    }
    switch (msg.type) {
      case "refresh":
        await this.withBusy(() => this.refresh());
        return;
      case "connectKey":
        await this.withBusy(async () => {
          const client = await this.client();
          await client.connectKey(msg.integrationID, msg.key, msg.answer, msg.label, this.directory, this.signal);
          await this.load();
          await this.changed();
          this.post({ type: "notice", kind: "success", message: this.localStrings().connectSuccess });
        });
        return;
      case "connectExternal":
        await this.withBusy(async () => {
          const client = await this.client();
          await client.connectExternal(msg.integrationID, msg.methodID, msg.answer, msg.label, this.directory, this.signal);
          await this.load();
          await this.changed();
          this.post({ type: "notice", kind: "success", message: this.localStrings().connectSuccess });
        });
        return;
      case "startOAuth":
        await this.withBusy(async () => {
          const client = await this.client();
          const attempt = await client.startOAuth(msg.integrationID, msg.methodID, msg.answer, msg.label, this.directory, this.signal);
          const integration = this.integrations.find((item) => item.id === msg.integrationID);
          const method = integration?.methods.find((item) => item.id === msg.methodID);
          this.beginAttempt({
            kind: "oauth",
            integrationID: msg.integrationID,
            integrationName: integration?.name ?? msg.integrationID,
            methodID: msg.methodID,
            methodLabel: method?.label ?? this.localStrings().connectMethodOAuth,
            attemptID: attempt.attemptID,
            url: attempt.url,
            instructions: attempt.instructions,
            mode: attempt.mode,
            paste: attempt.paste,
          });
        });
        return;
      case "startCommand":
        await this.withBusy(async () => {
          const client = await this.client();
          const attempt = await client.startCommand(msg.integrationID, msg.methodID, msg.label, this.directory, this.signal);
          const integration = this.integrations.find((item) => item.id === msg.integrationID);
          const method = integration?.methods.find((item) => item.id === msg.methodID);
          this.beginAttempt({
            kind: "command",
            integrationID: msg.integrationID,
            integrationName: integration?.name ?? msg.integrationID,
            methodID: msg.methodID,
            methodLabel: method?.label ?? this.localStrings().connectMethodCommand,
            attemptID: attempt.attemptID,
            instructions: this.localStrings().connectWaiting,
            command: method?.command,
          });
        });
        return;
      case "completeOAuth":
        await this.withBusy(async () => {
          const attempt = this.attempt;
          if (!attempt || attempt.kind !== "oauth") return;
          const client = await this.client();
          await client.completeOAuth(attempt.integrationID, attempt.attemptID, msg.code, this.directory, this.signal);
          this.pollFailures = 0;
          this.schedulePoll();
        });
        return;
      case "checkAttempt":
        if (this.attempt) {
          this.pollFailures = 0;
          this.post({ type: "attemptStatus", status: "pending" });
          this.schedulePoll();
        }
        return;
      case "cancelAttempt":
        await this.withBusy(() => this.cancelAttempt());
        return;
      case "runCommand":
        await this.withBusy(() => this.runCommand());
        return;
      case "activateCredential":
        await this.withBusy(async () => {
          const client = await this.client();
          await client.activateCredential(msg.id, this.signal);
          await this.load();
          await this.changed();
        });
        return;
      case "renameCredential":
        await this.withBusy(async () => {
          const label = msg.label.trim();
          if (!label) return;
          const client = await this.client();
          await client.renameCredential(msg.id, label, this.signal);
          await this.load();
        });
        return;
      case "deleteCredential": {
        const confirm = vscode.l10n.t(this.localStrings().connectConfirmDelete);
        const choice = await vscode.window.showWarningMessage(confirm, { modal: true }, vscode.l10n.t("Delete"));
        if (choice !== vscode.l10n.t("Delete")) return;
        await this.withBusy(async () => {
          const client = await this.client();
          await client.deleteCredential(msg.id, this.signal);
          await this.load();
          await this.changed();
        });
        return;
      }
      case "openLink": {
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(msg.href);
        } catch {
          this.post({ type: "notice", kind: "error", message: "Invalid URL" });
          return;
        }
        if (uri.scheme !== "http" && uri.scheme !== "https") return;
        try {
          await vscode.env.openExternal(uri);
        } catch (err) {
          this.error(err);
        }
        return;
      }
      case "copy":
        try {
          await vscode.env.clipboard.writeText(msg.text);
          this.post({ type: "notice", kind: "success", message: this.localStrings().connectCopied });
        } catch (err) {
          this.error(err);
        }
        return;
    }
  }

  dispose(): void {
    this.abort.abort();
    this.clearAttempt();
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [];
    this.panel?.dispose();
    this.panel = undefined;
  }
}
