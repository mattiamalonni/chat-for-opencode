import { describe, expect, it } from "vitest";
import { fileRefToOpenPath, findFileRefs, isFileRef } from "../../src/shared/fileRef";

describe("file references", () => {
  it("recognises paths with and without a line number", () => {
    expect(isFileRef("foo.ts")).toBe(true);
    expect(isFileRef("src/app.ts:42")).toBe(true);
    expect(isFileRef("src/app.ts:42:3")).toBe(true);
    expect(isFileRef("foo.ts#L12")).toBe(true);
    expect(isFileRef("./docs/readme.md")).toBe(true);
    expect(isFileRef("C:\\work\\main.go")).toBe(true);
  });

  it("ignores prose, URLs and incomplete words", () => {
    expect(isFileRef("")).toBe(false);
    expect(isFileRef("e.g")).toBe(false);
    expect(isFileRef("OpenCode")).toBe(false);
    expect(isFileRef("https://opencode.ai/docs")).toBe(false);
    expect(isFileRef("mailto:someone@example.com")).toBe(false);
    expect(isFileRef("foo.t")).toBe(false);
  });

  it("ignores numbers, versions and durations that look like extensions", () => {
    for (const value of ["0.2", "0.3", "0.2s", "0.3s", "0.25", "0.30", "0.2ms", "3.14", "1.234", "v2.10.0", "127.0.0.1", "10.20.30"]) {
      expect(isFileRef(value), value).toBe(false);
      expect(findFileRefs(`timer da ${value} secondi`), value).toEqual([]);
    }
  });

  it("converts markdown line anchors to the host's path:line syntax", () => {
    expect(fileRefToOpenPath("foo.ts#L12")).toBe("foo.ts:12");
    expect(fileRefToOpenPath("./foo.ts#L12-L20")).toBe("foo.ts:12");
    expect(fileRefToOpenPath("src/app.ts:42")).toBe("src/app.ts:42");
  });

  it("finds references in prose with their exact offsets", () => {
    const text = "Fix in src/app.ts:42 and see foo.ts#L7. Code `bar.ts:3` is not prose.";
    const refs = findFileRefs(text);
    expect(refs.map((r) => r.text)).toEqual(["src/app.ts:42", "foo.ts#L7", "bar.ts:3"]);
    expect(refs.map((r) => text.slice(r.start, r.start + r.text.length))).toEqual(refs.map((r) => r.text));
  });
});
