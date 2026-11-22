import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isWithinDirectory } from "../../src/chat/tempAttachments";
import { isWithinDirectoryReal } from "../../src/chat/pathSafety";

const win32 = process.platform === "win32";
const maybe = win32 ? it.skip : it; // creating symlinks needs elevated privileges on Windows

describe("symlink-safe containment", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "oc-safe-"));
    dirs.push(root);
    const outside = path.join(root, "outside");
    const inside = path.join(root, "workspace");
    mkdirSync(outside);
    mkdirSync(inside);
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    writeFileSync(path.join(inside, "ok.txt"), "ok");
    symlinkSync(outside, path.join(inside, "escape"));
    return { root, inside, outside };
  }

  maybe("rejects a link inside the folder that resolves outside it", async () => {
    const { inside } = fixture();
    const link = path.join(inside, "escape", "secret.txt");
    // The old lexical check accepted this path; the real-path check must not.
    expect(isWithinDirectory(link, inside)).toBe(true);
    expect(await isWithinDirectoryReal(link, inside)).toBe(false);
  });

  maybe("accepts real files and not-yet-created paths inside the folder", async () => {
    const { inside } = fixture();
    expect(await isWithinDirectoryReal(path.join(inside, "ok.txt"), inside)).toBe(true);
    expect(await isWithinDirectoryReal(path.join(inside, "new.txt"), inside)).toBe(true);
    expect(await isWithinDirectoryReal(inside, inside)).toBe(true);
    expect(await isWithinDirectoryReal(path.join(inside, "..", "outside", "secret.txt"), inside)).toBe(false);
  });
});
