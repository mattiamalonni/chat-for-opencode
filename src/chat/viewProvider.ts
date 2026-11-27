import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ChatController } from "./controller";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "opencode.chatView";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    loadBundle(view.webview, this.extensionUri, "webview", vscode.l10n.t("OpenCode chat"));
    this.controller.attachView(view);
  }
}

/**
 * Points a webview at one of the bundles in `dist/` (`webview` for the chat, `connect` for the
 * provider panel) with the shared CSP. Every chat/connect surface, restored or new, goes through
 * here so their options and HTML cannot drift apart.
 */
export function loadBundle(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: "webview" | "connect", title: string): void {
  const dist = vscode.Uri.joinPath(extensionUri, "dist");
  webview.options = { enableScripts: true, localResourceRoots: [dist] };
  webview.html = renderHtml({
    cspSource: webview.cspSource,
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, `${bundle}.js`)).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, `${bundle}.css`)).toString(),
    lang: vscode.env.language,
    title,
    // Set by the integration suite so a CDP client can find the real chat webview among VS Code's frames.
    e2e: bundle === "webview" && process.env.OC_IT_E2E === "1",
  });
}

export function renderHtml(opts: {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  lang: string;
  title: string;
  e2e?: boolean;
}): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src ${opts.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${opts.cspSource} data:`,
    `font-src ${opts.cspSource} data:`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="${escapeAttr(opts.lang)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(opts.styleUri)}">
<title>${escapeAttr(opts.title)}</title>
</head>
<body${opts.e2e ? ' data-oc-e2e="1"' : ""}>
<div id="root"></div>
<script nonce="${nonce}" src="${escapeAttr(opts.scriptUri)}"></script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
