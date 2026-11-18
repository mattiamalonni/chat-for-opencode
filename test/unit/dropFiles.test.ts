import { describe, expect, it } from "vitest";
import type { DragData, DropFileLike } from "../../src/webview/dropFiles";
import { collectDroppedFiles, collectPastedFiles, hasFiles, parseUriList } from "../../src/webview/dropFiles";

function drag(types: string[], data: Record<string, string> = {}, files: DropFileLike[] = []): DragData {
  return { types, getData: (type) => data[type] ?? "", files };
}

const read = async () => {
  throw new Error("should not read file content");
};

describe("dropFiles", () => {
  it("recognises file drags and ignores other drags", () => {
    expect(hasFiles(drag(["Files"]))).toBe(true);
    expect(hasFiles(drag(["application/vnd.code.uri-list"]))).toBe(true);
    expect(hasFiles(drag(["text/uri-list"]))).toBe(true);
    expect(hasFiles(drag(["text/plain"]))).toBe(false);
    expect(hasFiles(undefined)).toBe(false);
  });

  it("parses JSON uri-lists, plain uri-lists and bare paths", () => {
    expect(parseUriList('["file:///work/a.ts","file:///work/b.ts"]')).toEqual([
      { uri: "file:///work/a.ts" },
      { uri: "file:///work/b.ts" },
    ]);
    expect(parseUriList("# comment\nfile:///work/a b.ts\n/work/c.ts\n")).toEqual([
      { uri: "file:///work/a b.ts" },
      { path: "/work/c.ts" },
    ]);
  });

  it("uses VS Code's uri-list and decodes display names", async () => {
    const data = drag(["Files", "application/vnd.code.uri-list"], {
      "application/vnd.code.uri-list": '["file:///work/src/my%20file.ts"]',
    });
    expect(await collectDroppedFiles(data, read)).toEqual([
      { uri: "file:///work/src/my%20file.ts", name: "my file.ts" },
    ]);
  });

  it("uses text/uri-list from the desktop and keeps absolute paths", async () => {
    const data = drag(["Files", "text/uri-list"], { "text/uri-list": "file:///Users/me/notes.txt" });
    expect(await collectDroppedFiles(data, read)).toEqual([
      { uri: "file:///Users/me/notes.txt", name: "notes.txt" },
    ]);
  });

  it("falls back to Electron File.path when no uri-list is present", async () => {
    const data = drag(["Files"], {}, [{ name: "report.pdf", path: "/Users/me/report.pdf" }]);
    expect(await collectDroppedFiles(data, read)).toEqual([{ name: "report.pdf", path: "/Users/me/report.pdf" }]);
  });

  it("reads content only when no path could be recovered", async () => {
    const file: DropFileLike = { name: "clip.png", arrayBuffer: async () => new TextEncoder().encode("bytes").buffer };
    const data = drag(["Files"], {}, [file]);
    const reader = async (f: DropFileLike) => Buffer.from(await f.arrayBuffer!()).toString("base64");
    expect(await collectDroppedFiles(data, reader)).toEqual([{ name: "clip.png", base64: "Ynl0ZXM=" }]);
  });

  it("does not read files when a path is available, and dedupes repeated entries", async () => {
    const file: DropFileLike = { name: "a.ts", path: "/work/a.ts", arrayBuffer: async () => new ArrayBuffer(0) };
    const data = drag(["Files", "text/uri-list"], { "text/uri-list": "file:///work/a.ts" }, [file]);
    expect(await collectDroppedFiles(data, read)).toEqual([{ uri: "file:///work/a.ts", name: "a.ts" }]);
  });

  it("skips unreadable files instead of failing the whole drop", async () => {
    const bad: DropFileLike = { name: "bad.bin" };
    const good: DropFileLike = { name: "good.txt", arrayBuffer: async () => new TextEncoder().encode("ok").buffer };
    const reader = async (f: DropFileLike) => {
      if (!f.arrayBuffer) throw new Error("unreadable");
      return Buffer.from(await f.arrayBuffer()).toString("base64");
    };
    expect(await collectDroppedFiles(drag(["Files"], {}, [bad, good]), reader)).toEqual([{ name: "good.txt", base64: "b2s=" }]);
  });
});

describe("collectPastedFiles", () => {
  const reader = async (f: DropFileLike) => Buffer.from(await f.arrayBuffer!()).toString("base64");

  it("reads clipboard files as inline content and keeps their MIME type", async () => {
    const png: DropFileLike = {
      name: "shot.png",
      type: "image/png",
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
    };
    const clipboard = drag(["Files"], {}, [png]);
    expect(await collectPastedFiles(clipboard, reader)).toEqual([
      { name: "shot.png", base64: "iVBORw0KGgo=", mime: "image/png" },
    ]);
  });

  it("falls back to items[].getAsFile() when files is empty", async () => {
    const png: DropFileLike = {
      name: "clip.png",
      type: "image/png",
      arrayBuffer: async () => new TextEncoder().encode("bytes").buffer,
    };
    const clipboard: DragData = {
      types: ["Files"],
      getData: () => "",
      files: [],
      items: [{ kind: "file", type: "image/png", getAsFile: () => png }],
    };
    expect(await collectPastedFiles(clipboard, reader)).toEqual([
      { name: "clip.png", base64: "Ynl0ZXM=", mime: "image/png" },
    ]);
  });

  it("ignores non-file items and skips unreadable files", async () => {
    const bad: DropFileLike = { name: "bad.png", type: "image/png" };
    const good: DropFileLike = {
      name: "ok.png",
      type: "image/png",
      arrayBuffer: async () => new TextEncoder().encode("ok").buffer,
    };
    const clipboard: DragData = {
      types: ["Files"],
      getData: () => "",
      files: [bad, good],
      items: [{ kind: "string", type: "text/plain" }],
    };
    expect(await collectPastedFiles(clipboard, reader)).toEqual([{ name: "ok.png", base64: "b2s=", mime: "image/png" }]);
  });
});
