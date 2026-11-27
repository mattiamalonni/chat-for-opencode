import { describe, expect, it } from "vitest";
import { WebviewMessageQueue } from "../../src/chat/messageQueue";
import type { WebviewMessage } from "../../src/shared/protocol";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("WebviewMessageQueue", () => {
  it("keeps state messages in order: a stop waits for the send before it", async () => {
    const queue = new WebviewMessageQueue();
    const order: string[] = [];
    const send = deferred();
    const first = queue.run({ type: "send", text: "hi", attachments: [], context: [] }, async () => {
      await send.promise;
      order.push("send");
    });
    const second = queue.run({ type: "abort" }, async () => {
      order.push("abort");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    send.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["send", "abort"]);
  });

  it("opens files and links without waiting for a long operation", async () => {
    const queue = new WebviewMessageQueue();
    const order: string[] = [];
    const ready = deferred();
    const connecting = queue.run({ type: "ready" }, async () => {
      await ready.promise;
      order.push("ready");
    });
    await queue.run({ type: "openLink", href: "https://example.com" } as WebviewMessage, async () => {
      order.push("openLink");
    });
    expect(order).toEqual(["openLink"]);
    ready.resolve();
    await connecting;
    expect(order).toEqual(["openLink", "ready"]);
  });

  it("keeps file searches ordered so the latest answer arrives last", async () => {
    const queue = new WebviewMessageQueue();
    const order: string[] = [];
    const slow = deferred();
    const a = queue.run({ type: "searchFiles", query: "ab" }, async () => {
      await slow.promise;
      order.push("ab");
    });
    const b = queue.run({ type: "searchFiles", query: "abc" }, async () => {
      order.push("abc");
    });
    slow.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["ab", "abc"]);
  });

  it("keeps processing after a failed message", async () => {
    const queue = new WebviewMessageQueue();
    await expect(
      queue.run({ type: "refreshSessions" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    let ran = false;
    await queue.run({ type: "refreshSessions" }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
