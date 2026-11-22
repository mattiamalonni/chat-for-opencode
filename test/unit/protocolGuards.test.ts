import { describe, expect, it } from "vitest";
import { ACTION_IDS } from "../../src/shared/protocol";
import { isActionId, isHostMessage, isWebviewMessage } from "../../src/shared/protocolGuards";

describe("webview → host boundary", () => {
  it("accepts the messages the chat actually sends", () => {
    expect(isWebviewMessage({ type: "ready" })).toBe(true);
    expect(isWebviewMessage({ type: "send", text: "hello", attachments: [], context: [], delivery: "queue" })).toBe(true);
    expect(
      isWebviewMessage({
        type: "send",
        text: "with files",
        attachments: [{ uri: "file:///a.txt", name: "a.txt", kind: "file" }],
        context: [{ id: "c1", uri: "file:///a.txt", label: "a.txt", kind: "file" }],
      }),
    ).toBe(true);
    expect(isWebviewMessage({ type: "permissionReply", sessionId: "s1", requestId: "r1", decision: "once" })).toBe(true);
    expect(isWebviewMessage({ type: "formReply", sessionId: "s1", formId: "f1", answer: { a: "x", b: ["y"], c: 2, d: true } })).toBe(true);
    expect(isWebviewMessage({ type: "usePrompt", id: "review" })).toBe(true);
    expect(isWebviewMessage({ type: "addContextSource", source: "problems" })).toBe(true);
    expect(isWebviewMessage({ type: "removeContextSource", source: "git" })).toBe(true);
    expect(isWebviewMessage({ type: "openDiff", file: "a.txt", patch: "@@", applied: true })).toBe(true);
    expect(isWebviewMessage({ type: "dropFiles", files: [{ name: "a.txt", base64: "YQ==", mime: "text/plain" }] })).toBe(true);
    for (const id of ACTION_IDS) expect(isWebviewMessage({ type: "action", id })).toBe(true);
  });

  it("rejects unknown types, malformed payloads and unbounded input", () => {
    expect(isWebviewMessage(undefined)).toBe(false);
    expect(isWebviewMessage("ready")).toBe(false);
    expect(isWebviewMessage({})).toBe(false);
    expect(isWebviewMessage({ type: "notAProtocolMessage" })).toBe(false);
    expect(isWebviewMessage({ type: "send", text: 42, attachments: [], context: [] })).toBe(false);
    expect(isWebviewMessage({ type: "send", text: "x", attachments: [{}], context: [] })).toBe(false);
    expect(isWebviewMessage({ type: "send", text: "x", attachments: [], context: [], delivery: "steer-now" })).toBe(false);
    expect(isWebviewMessage({ type: "send", text: "x".repeat(4_000_001), attachments: [], context: [] })).toBe(false);
    expect(isWebviewMessage({ type: "fileIcons", paths: new Array(2001).fill("a.txt") })).toBe(false);
    expect(isWebviewMessage({ type: "openLink", href: "x".repeat(32_769) })).toBe(false);
    expect(isWebviewMessage({ type: "usePrompt", id: 7 })).toBe(false);
    expect(isWebviewMessage({ type: "addContextSource", source: "anything" })).toBe(false);
    expect(isWebviewMessage({ type: "removeContextSource" })).toBe(false);
  });

  it("never dispatches an action outside the protocol whitelist", () => {
    expect(isWebviewMessage({ type: "action", id: "deleteEverything" })).toBe(false);
    expect(isWebviewMessage({ type: "action", id: "retry" })).toBe(true);
    // A whitelist check must not be fooled by prototype properties or non-strings.
    expect(isActionId("toString")).toBe(false);
    expect(isActionId(undefined)).toBe(false);
    expect(isActionId("showLogs")).toBe(true);
    expect(isActionId("__proto__")).toBe(false);
  });

  it("rejects a well-typed shell with a bad nested field", () => {
    expect(isWebviewMessage({ type: "setModel", model: { id: "m", providerID: 7 } })).toBe(false);
    expect(isWebviewMessage({ type: "formReply", sessionId: "s1", formId: "f1", answer: { a: {} } })).toBe(false);
    expect(isWebviewMessage({ type: "openDiffs", files: [{ file: "a", patch: "x".repeat(8_000_001) }] })).toBe(false);
  });
});

describe("host → webview boundary", () => {
  const hello = { type: "session", session: { id: "s1", busy: false, messages: [], permissions: [], forms: [] } };

  it("accepts real host messages", () => {
    expect(isHostMessage(hello)).toBe(true);
    expect(isHostMessage({ type: "event", event: { type: "session.status", data: { sessionID: "s1" } } })).toBe(true);
    expect(isHostMessage({ type: "notice", error: { kind: "promptFailed", message: "failed", actions: ["retry"] } })).toBe(true);
    expect(isHostMessage({ type: "revealMessage", messageId: 'a"] [x', sessionId: "s1" })).toBe(true);
    expect(isHostMessage({ type: "linkSubagent", toolId: "tool-1", sessionId: "child-1" })).toBe(true);
    expect(isHostMessage({ type: "contextSources", items: [{ id: "git", label: "Git diff", description: "Changes" }] })).toBe(true);
    expect(
      isHostMessage({
        type: "promptCatalog",
        items: [{ id: "review", title: "Review", description: "Changes", text: "Review $diff" }],
      }),
    ).toBe(true);
    expect(
      isHostMessage({
        type: "context",
        items: [{ id: "context:git", kind: "git", uri: "data:text/markdown;base64,YQ==", label: "Git diff" }],
      }),
    ).toBe(true);
    expect(isHostMessage({ type: "synced" })).toBe(true);
  });

  it("drops malformed messages before they can reach the reducer", () => {
    expect(isHostMessage(null)).toBe(false);
    expect(isHostMessage({ type: "unknown" })).toBe(false);
    expect(isHostMessage({ type: "session", session: { id: "s1", busy: false, messages: "nope" } })).toBe(false);
    expect(isHostMessage({ type: "notice", error: { kind: "nope", message: "x", actions: [] } })).toBe(false);
    expect(isHostMessage({ type: "revealMessage", messageId: 7 })).toBe(false);
    expect(
      isHostMessage({ type: "sessions", items: [{ id: "s1", title: "t", updated: "yesterday", busy: false, needsInput: false }] }),
    ).toBe(false);
  });
});
