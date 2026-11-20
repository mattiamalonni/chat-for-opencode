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
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = renderHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css")).toString(),
      lang: vscode.env.language,
      title: vscode.l10n.t("OpenCode chat"),
      // Set by the integration suite so a CDP client can find the real webview among VS Code's frames.
      e2e: process.env.OC_IT_E2E === "1",
    });
    this.controller.attachView(view);
  }
}

export function renderHtml(opts: { cspSource: string; scriptUri: string; styleUri: string; lang: string; title: string; e2e?: boolean }): string {
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
