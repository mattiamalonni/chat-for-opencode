import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../shared/protocol";
import { renderHtml } from "./viewProvider";

export type ChatWebview = vscode.WebviewView | vscode.WebviewPanel;

/**
 * Owns every live chat view (the sidebar plus any editor tabs) and the listeners attached to them.
 *
 * Six interleaved fields (`views`, `view`, `sidebarView`, `panel`,
 * `viewSubscriptions`, `postListeners`) and the code that kept them in sync. Isolating that bookkeeping
 * here makes handle disposal a single responsibility and lets the lifecycle tests exercise it
 * without constructing a whole controller.
 */
export class ChatViews implements vscode.Disposable {
  private readonly all = new Set<ChatWebview>();
  private readonly subscriptions = new Map<ChatWebview, vscode.Disposable>();
  private readonly listeners = new Set<(msg: HostMessage) => void>();
  private sidebar: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private primary: ChatWebview | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly receive: (msg: WebviewMessage) => void,
    private readonly onShown: (view: ChatWebview) => void,
  ) {}

  get size(): number {
    return this.all.size;
  }

  get hasPrimary(): boolean {
    return this.primary !== undefined;
  }

  get hasPanel(): boolean {
    return this.panel !== undefined;
  }

  has(view: ChatWebview): boolean {
    return this.all.has(view);
  }

  get isVisible(): boolean {
    for (const view of this.all) if (view.visible) return true;
    return false;
  }

  attachView(view: ChatWebview): void {
    // Each view owns its listeners. A second view (editor tab) must not tear down the sidebar
    // view's subscription; disposing a view removes only its own entries.
    this.detachView(view);
    this.all.add(view);
    const sub = view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.receive(msg));
    // The view's onDidDispose also tears down the message listener: if the controller is disposed
    // while the view lives on, that listener would otherwise keep it reachable forever.
    const onDispose = view.onDidDispose(() => this.detachView(view));
    // The live stream has no replay: top up incrementally when a view is shown again so a chat left
    // open in the background cannot drift from the server while it was hidden.
    const shown = () => {
      if (this.all.has(view) && view.visible) this.onShown(view);
    };
    const onVisibility = "onDidChangeVisibility" in view ? view.onDidChangeVisibility(shown) : view.onDidChangeViewState(shown);
    this.subscriptions.set(view, vscode.Disposable.from(sub, onDispose, onVisibility));
    // The first sidebar view is the focus target. Editor panels opt in explicitly via `attachPanel`.
    if (view === this.sidebar || (!this.sidebar && "onDidChangeVisibility" in view)) {
      this.sidebar = view as vscode.WebviewView;
      this.primary = view;
    }
  }

  private detachView(view: ChatWebview): void {
    this.subscriptions.get(view)?.dispose();
    this.subscriptions.delete(view);
    this.all.delete(view);
    // A recreated sidebar WebviewView would otherwise leave the stale one as the focus target.
    if (this.sidebar === view) this.sidebar = undefined;
    if (this.primary === view) this.primary = this.sidebar && this.all.has(this.sidebar) ? this.sidebar : undefined;
  }

  /** Opens (or reveals) the chat in an editor tab so long transcripts and diffs have room. */
  openChatInEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel("opencode.chat", vscode.l10n.t("OpenCode chat"), vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [dist],
    });
    this.attachPanel(panel);
  }

  /** Used by the serializer when VS Code restores an editor tab after a reload. */
  attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = renderHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css")).toString(),
      lang: vscode.env.language,
      title: vscode.l10n.t("OpenCode chat"),
      e2e: process.env.OC_IT_E2E === "1",
    });
    this.attachView(panel);
    // Serialized tabs go through here too, so the dispose cleanup must not live only in
    // `openChatInEditor()`; otherwise a closed tab leaves `panel` pointing at a disposed panel.
    const disposeSub = panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    const existing = this.subscriptions.get(panel);
    this.subscriptions.set(panel, existing ? vscode.Disposable.from(existing, disposeSub) : disposeSub);
  }

  post(msg: HostMessage): void {
    // A long-running load/resync can outlive a view; postMessage rejects on a disposed webview.
    for (const view of this.all) void view.webview.postMessage(msg).then(undefined, () => undefined);
    for (const listener of this.listeners) listener(msg);
  }

  /** Observes messages sent to the webview (used by integration tests). */
  onDidPost(listener: (msg: HostMessage) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  dispose(): void {
    for (const sub of this.subscriptions.values()) sub.dispose();
    this.subscriptions.clear();
    this.all.clear();
    this.listeners.clear();
    this.sidebar = undefined;
    this.panel = undefined;
    this.primary = undefined;
  }
}
