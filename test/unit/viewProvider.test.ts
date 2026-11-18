import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  env: { language: "it" },
  l10n: { t: (s: string) => s },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({ toString: () => parts.join("/") }),
  },
}));

import type * as vscode from "vscode";
import type { ChatController } from "../../src/chat/controller";
import { ChatViewProvider, renderHtml } from "../../src/chat/viewProvider";

describe("chat view HTML", () => {
  it("renders the given lang and escapes attributes", () => {
    const html = renderHtml({
      cspSource: "vscode-resource:",
      scriptUri: "dist/webview.js",
      styleUri: "dist/webview.css",
      lang: 'it" onload="x',
      title: "Chat",
    });
    expect(html).toContain('<html lang="it&quot; onload=&quot;x">');
    expect(html).toContain("<title>Chat</title>");
    expect(html).toContain('src="dist/webview.js"');
  });

  it("uses vscode.env.language as the document language", () => {
    const provider = new ChatViewProvider({} as vscode.Uri, { attachView() {} } as unknown as ChatController);
    let html = "";
    const view = {
      webview: {
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: { toString(): string }) => uri,
        set html(value: string) {
          html = value;
        },
        get html() {
          return html;
        },
      },
    } as unknown as vscode.WebviewView;
    provider.resolveWebviewView(view);
    expect(html).toContain('<html lang="it">');
  });
});
