import { describe, expect, it, vi } from "vitest";

const openCommand = vi.hoisted(() => vi.fn());
vi.mock("vscode", () => ({
  l10n: { t: (s: string) => s },
  Uri: {
    parse: (value: string) => {
      const withQuery = new URL(value);
      return {
        scheme: withQuery.protocol.replace(":", ""),
        fsPath: decodeURIComponent(withQuery.pathname),
        query: withQuery.search.replace(/^\?/, ""),
        with: (_changes: unknown) => ({
          scheme: "file",
          fsPath: decodeURIComponent(withQuery.pathname),
          toString: () => value.split("?")[0],
        }),
        toString: () => value,
      };
    },
    file: (p: string) => ({ scheme: "file", fsPath: p, toString: () => `file://${p}` }),
  },
  workspace: {
    getWorkspaceFolder: (uri: { fsPath: string }) => (uri.fsPath.startsWith("/work/") ? { uri } : undefined),
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath,
  },
  commands: { executeCommand: openCommand },
  window: { showOpenDialog: vi.fn(), showTextDocument: vi.fn() },
}));

import { AttachmentService } from "../../src/chat/attachmentService";

function service() {
  return new AttachmentService(vi.fn(), vi.fn(), vi.fn(), vi.fn());
}

describe("AttachmentService path allowlist", () => {
  it("opens a file inside the workspace", async () => {
    openCommand.mockClear();
    await service().open("file:///work/src/app.ts");
    expect(openCommand).toHaveBeenCalledWith("vscode.open", expect.objectContaining({ fsPath: "/work/src/app.ts" }));
  });

  it("refuses a file outside both the workspace and its own temp copies", async () => {
    openCommand.mockClear();
    const log = vi.fn();
    const s = new AttachmentService(vi.fn(), vi.fn(), log, vi.fn());
    await s.open("file:///etc/passwd");
    expect(openCommand).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("outside the workspace"));
  });

  it("refuses non-file schemes", async () => {
    openCommand.mockClear();
    await service().open("https://example.com/a.ts");
    expect(openCommand).not.toHaveBeenCalled();
  });
});
