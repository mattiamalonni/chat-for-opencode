import { describe, expect, it } from "vitest";
import {
  attachmentFileName,
  evictOldestAttachments,
  extensionForMime,
  isWithinDirectory,
  normalizePathKey,
} from "../../src/chat/tempAttachments";

describe("tempAttachments", () => {
  it("derives a safe file name and keeps an existing extension", () => {
    expect(attachmentFileName("shot.png", "image/png")).toBe("shot.png");
    expect(attachmentFileName("C:\\tmp\\shot.PNG", "image/png")).toBe("shot.PNG");
    expect(attachmentFileName("../../etc/passwd", undefined)).toBe("passwd.bin");
    expect(attachmentFileName("a/b/notes", "text/markdown")).toBe("notes.md");
  });

  it("falls back to a generic name for clipboard files without one", () => {
    expect(attachmentFileName("", "image/jpeg")).toBe("attachment.jpg");
    expect(attachmentFileName("   ", undefined)).toBe("attachment.bin");
    expect(attachmentFileName("...", "image/gif")).toBe("attachment.gif");
  });

  it("reads the extension from a full mime type", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg; charset=binary")).toBe(".jpg");
    expect(extensionForMime("application/octet-stream")).toBe(".bin");
    expect(extensionForMime(undefined)).toBe(".bin");
  });

  it("normalizes the drive letter so a URI-parsed path still matches on Windows", () => {
    expect(normalizePathKey("C:\\Temp\\shot.png", "win32")).toBe(normalizePathKey("c:\\temp\\SHOT.PNG", "win32"));
    expect(normalizePathKey("/tmp/shot.png", "linux")).toBe("/tmp/shot.png");
  });

  it("accepts only paths inside the temp directory", () => {
    const root = "/Users/me/Library/Application Support/opencode/chat-attachments";
    expect(isWithinDirectory(`${root}/uuid-shot.png`, root)).toBe(true);
    expect(isWithinDirectory(root, root)).toBe(true);
    expect(isWithinDirectory("/Users/me/secret.png", root)).toBe(false);
    expect(isWithinDirectory(`${root}-other/shot.png`, root)).toBe(false);
  });

  it("evicts the oldest entries before a new one is added, only when the cap is full", () => {
    const files = new Set(["a.png", "b.png", "c.png"]);
    const evicted: string[] = [];
    evictOldestAttachments(files, 3, (file) => evicted.push(file));
    expect([...files]).toEqual(["b.png", "c.png"]);
    expect(evicted).toEqual(["a.png"]);

    // Room for one more: the next insert brings the set back to the cap without evicting.
    evictOldestAttachments(files, 3, (file) => evicted.push(file));
    expect([...files]).toEqual(["b.png", "c.png"]);
    expect(evicted).toEqual(["a.png"]);

    files.add("d.png");
    evictOldestAttachments(files, 3, (file) => evicted.push(file));
    expect([...files]).toEqual(["c.png", "d.png"]);
    expect(evicted).toEqual(["a.png", "b.png"]);
  });
});
