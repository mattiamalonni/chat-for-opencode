import { describe, expect, it } from "vitest";
import { composerAction, isNewSessionKey, shouldIsolateKey, type KeyLike } from "../../src/shared/keys";

function k(key: string, mods: Partial<KeyLike> = {}): KeyLike {
  return {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

describe("shouldIsolateKey", () => {
  it("keeps VS Code chords like Ctrl+J / Ctrl+R / Ctrl+K inside the composer", () => {
    for (const platform of ["windows", "linux", "mac"] as const) {
      expect(shouldIsolateKey(k("j", { ctrlKey: true }), platform)).toBe(true);
      expect(shouldIsolateKey(k("r", { ctrlKey: true }), platform)).toBe(true);
      expect(shouldIsolateKey(k("k", { ctrlKey: true }), platform)).toBe(true);
    }
    // macOS Emacs-style editing keys must work in the textarea.
    expect(shouldIsolateKey(k("a", { ctrlKey: true }), "mac")).toBe(true);
    expect(shouldIsolateKey(k("e", { ctrlKey: true }), "mac")).toBe(true);
  });

  it("lets clipboard, undo and command palette reach VS Code", () => {
    expect(shouldIsolateKey(k("c", { metaKey: true }), "mac")).toBe(false);
    expect(shouldIsolateKey(k("v", { ctrlKey: true }), "windows")).toBe(false);
    expect(shouldIsolateKey(k("z", { ctrlKey: true }), "linux")).toBe(false);
    expect(shouldIsolateKey(k("P", { metaKey: true, shiftKey: true }), "mac")).toBe(false);
    expect(shouldIsolateKey(k("F1"), "windows")).toBe(false);
    expect(shouldIsolateKey(k("`", { ctrlKey: true, code: "Backquote" }), "mac")).toBe(false);
  });

  it("isolates AltGr characters on Windows (reported as Ctrl+Alt)", () => {
    // Italian layout: AltGr+ò = @, AltGr+è = [
    expect(shouldIsolateKey(k("@", { ctrlKey: true, altKey: true, code: "Semicolon" }), "windows")).toBe(true);
    expect(shouldIsolateKey(k("[", { ctrlKey: true, altKey: true, code: "BracketLeft" }), "windows")).toBe(true);
  });

  it("isolates IME composition keys and Caps Lock", () => {
    expect(shouldIsolateKey(k("Process", { keyCode: 229 }), "windows")).toBe(true);
    expect(shouldIsolateKey(k("a", { isComposing: true, ctrlKey: true }), "windows")).toBe(true);
    expect(shouldIsolateKey(k("CapsLock"), "windows")).toBe(true);
  });

  it("lets Escape and Tab bubble for focus navigation", () => {
    expect(shouldIsolateKey(k("Escape"), "mac")).toBe(false);
    expect(shouldIsolateKey(k("Tab"), "mac")).toBe(false);
  });
});

describe("isNewSessionKey", () => {
  it("matches plain Cmd+N on mac and Ctrl+N elsewhere", () => {
    expect(isNewSessionKey(k("n", { metaKey: true }), "mac")).toBe(true);
    expect(isNewSessionKey(k("N", { metaKey: true }), "mac")).toBe(true);
    expect(isNewSessionKey(k("n", { ctrlKey: true }), "windows")).toBe(true);
    expect(isNewSessionKey(k("n", { ctrlKey: true }), "linux")).toBe(true);
  });

  it("ignores the wrong modifier, extra modifiers and IME compositions", () => {
    expect(isNewSessionKey(k("n", { ctrlKey: true }), "mac")).toBe(false);
    expect(isNewSessionKey(k("n", { metaKey: true }), "windows")).toBe(false);
    expect(isNewSessionKey(k("n", { metaKey: true, shiftKey: true }), "mac")).toBe(false);
    expect(isNewSessionKey(k("n", { metaKey: true, altKey: true }), "mac")).toBe(false);
    expect(isNewSessionKey(k("n", { metaKey: true, ctrlKey: true }), "mac")).toBe(false);
    expect(isNewSessionKey(k("m", { metaKey: true }), "mac")).toBe(false);
    expect(isNewSessionKey(k("Process", { metaKey: true, keyCode: 229 }), "mac")).toBe(false);
    expect(isNewSessionKey(k("n", { isComposing: true, metaKey: true }), "mac")).toBe(false);
  });
});

describe("composerAction", () => {
  it("sends on Enter and inserts newline on Shift+Enter", () => {
    expect(composerAction(k("Enter"), false)).toBe("send");
    expect(composerAction(k("Enter", { shiftKey: true }), false)).toBe("newline");
    expect(composerAction(k("a"), false)).toBe("none");
  });

  it("never sends while an IME composition is active", () => {
    expect(composerAction(k("Enter"), true)).toBe("none");
    expect(composerAction(k("Enter", { isComposing: true }), false)).toBe("none");
    expect(composerAction(k("Enter", { keyCode: 229 }), false)).toBe("none");
  });
});
