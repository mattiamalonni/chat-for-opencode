import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { localPathFromUri, mustInline, resolveAttachment, sliceLines } from "../../src/chat/attachments";

const mimeFor = (name: string): string => (name.endsWith(".txt") ? "text/plain" : "application/octet-stream");

describe("attachment inline policy", () => {
  it("inlines local file URIs only for external servers", () => {
    expect(mustInline("file:///work/a.ts", true)).toBe(true);
    expect(mustInline("file:///work/a.ts", false)).toBe(false);
    expect(mustInline("data:text/plain;base64,QQ==", true)).toBe(false);
    expect(mustInline("https://example.com/a.ts", true)).toBe(false);
  });

  it("decodes file URIs and drops the range query", () => {
    const uri = pathToFileURL("/tmp/spazi à/file con spazio.txt").toString() + "?start=2&end=4";
    expect(localPathFromUri(uri)).toBe("/tmp/spazi à/file con spazio.txt");
    expect(localPathFromUri("https://example.com/x")).toBeUndefined();
    expect(localPathFromUri("not a uri")).toBeUndefined();
  });

  it("slices a 1-based inclusive line range like OpenCode does", () => {
    const bytes = Buffer.from("one\ntwo\nthree\nfour\n");
    expect(sliceLines(bytes, "file:///x.txt?start=2&end=3").toString()).toBe("two\nthree");
    expect(sliceLines(bytes, "file:///x.txt?start=2").toString()).toBe("two\nthree\nfour\n");
    expect(sliceLines(bytes, "file:///x.txt").toString()).toBe("one\ntwo\nthree\nfour\n");
  });
});

describe("resolveAttachment", () => {
  it("passes URIs through for a managed server", async () => {
    const result = await resolveAttachment({ uri: "file:///work/missing.ts", name: "missing.ts" }, false, mimeFor);
    expect(result).toEqual({ status: "ok", attachment: { uri: "file:///work/missing.ts", name: "missing.ts" } });
  });

  it("reads a local file inline for an external server, honouring the range", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-attachments-"));
    const file = path.join(dir, "note.txt");
    await writeFile(file, "one\ntwo\nthree\n");
    const uri = pathToFileURL(file).toString() + "?start=2&end=2";

    const result = await resolveAttachment({ uri, name: "note.txt" }, true, mimeFor);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attachment.uri).toBe(`data:text/plain;base64,${Buffer.from("two").toString("base64")}`);
    expect(result.attachment.name).toBe("note.txt");
  });

  it("reports a missing file instead of sending an unreadable URI", async () => {
    const result = await resolveAttachment({ uri: "file:///definitely/not/here.txt", name: "here.txt" }, true, mimeFor);
    expect(result.status).toBe("unreadable");
  });

  it("rejects files above the size limit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-attachments-"));
    const file = path.join(dir, "big.txt");
    await writeFile(file, "x".repeat(64));
    const result = await resolveAttachment({ uri: pathToFileURL(file).toString(), name: "big.txt" }, true, mimeFor, 32);
    expect(result).toEqual({ status: "tooLarge", name: "big.txt" });
  });
});
