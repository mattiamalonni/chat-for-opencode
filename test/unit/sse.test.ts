import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStream, SseOverflowError, SseParser, parseServerEvent, type EventSubscriber, type SseMessage } from "../../src/client/sse";
import type { ServerEvent } from "../../src/shared/api";

function collect(chunks: string[]): { messages: SseMessage[]; comments: string[] } {
  const messages: SseMessage[] = [];
  const comments: string[] = [];
  const p = new SseParser(
    (m) => messages.push(m),
    (c) => comments.push(c),
  );
  for (const c of chunks) p.feed(c);
  p.end();
  return { messages, comments };
}

describe("SseParser (recorded wire fixtures)", () => {
  it("parses data-only events and heartbeats like opencode emits them", () => {
    const { messages, comments } = collect([
      'data: {"type":"server.connected","data":{}}\n\n: heartbeat\n\ndata: {"type":"x","data":1}\n\n',
    ]);
    expect(messages.map((m) => m.data)).toEqual(['{"type":"server.connected","data":{}}', '{"type":"x","data":1}']);
    expect(comments).toEqual(["heartbeat"]);
  });

  it("handles events split across arbitrary chunk boundaries", () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    for (let i = 1; i < text.length; i++) {
      const { messages } = collect([text.slice(0, i), text.slice(i)]);
      expect(messages.map((m) => m.data)).toEqual(['{"a":1}', '{"b":2}']);
    }
  });

  it("supports CRLF and CR line endings, including CRLF split between chunks", () => {
    expect(collect(["data: one\r\n\r\ndata: two\r\r"]).messages.map((m) => m.data)).toEqual(["one", "two"]);
    expect(collect(["data: one\r", "\n\r", "\n"]).messages.map((m) => m.data)).toEqual(["one"]);
  });

  it("joins multi-line data and keeps event/id fields", () => {
    const { messages } = collect(["event: update\nid: 7\ndata: a\ndata: b\n\n"]);
    expect(messages).toEqual([{ event: "update", id: "7", data: "a\nb" }]);
  });

  it("flushes a trailing event without blank line at end()", () => {
    expect(collect(["data: last"]).messages.map((m) => m.data)).toEqual(["last"]);
  });

  it("fails a stream that trickles an unterminated line past the cap", () => {
    const p = new SseParser(
      () => {},
      () => {},
      { maxUnfinishedBytes: 100 },
    );
    for (let i = 0; i < 10; i++) p.feed("x".repeat(10));
    expect(() => p.feed("x".repeat(11))).toThrow(SseOverflowError);
  });

  it("fails a single event whose data exceeds the cap", () => {
    const p = new SseParser(
      () => {},
      () => {},
      { maxEventBytes: 50 },
    );
    expect(() => p.feed(`data: ${"x".repeat(51)}\n\n`)).toThrow(SseOverflowError);
  });

  it("ignores malformed JSON when decoding server events", () => {
    expect(parseServerEvent({ data: "{nope" })).toBeUndefined();
    expect(parseServerEvent({ data: '{"no":"type"}' })).toBeUndefined();
    expect(parseServerEvent({ data: '{"type":"a","data":{}}' })?.type).toBe("a");
    expect(parseServerEvent({ data: '{"type":"a","data":null}' })).toBeUndefined();
    expect(parseServerEvent({ data: '{"type":"a","data":"oops"}' })).toBeUndefined();
    expect(parseServerEvent({ data: '{"type":"a","data":[1]}' })).toBeUndefined();
  });
});

describe("EventStream over SDK subscriptions", () => {
  let stream: EventStream | undefined;
  afterEach(() => stream?.close());

  it("delivers events and resubscribes when the iterable ends", async () => {
    let connections = 0;
    const statuses: string[] = [];
    const events: ServerEvent[] = [];
    const subscribe: EventSubscriber = (onEvent, onClose) => {
      connections++;
      queueMicrotask(() => {
        onEvent({ type: "session.idle", data: { sessionID: "ses" } } as ServerEvent);
        onClose();
      });
    };
    stream = new EventStream({ subscribe, onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s), minBackoffMs: 10 });
    stream.start();
    await waitUntil(() => connections >= 2, 2000);
    expect(events[0].type).toBe("session.idle");
    expect(statuses.slice(0, 3)).toEqual(["connected", "reconnecting", "connected"]);
  });

  it("does not report connected for retries that never deliver an event", async () => {
    let connections = 0;
    const statuses: string[] = [];
    const subscribe: EventSubscriber = (_onEvent, onClose) => {
      connections++;
      queueMicrotask(() => onClose(new Error("unreachable")));
    };
    stream = new EventStream({ subscribe, onEvent: () => {}, onStatus: (s) => statuses.push(s), minBackoffMs: 5, maxBackoffMs: 5 });
    stream.start();
    await waitUntil(() => connections >= 3, 2000);
    expect(statuses).not.toContain("connected");
  });

  it("ignores events from a subscription that already closed", async () => {
    const events: ServerEvent[] = [];
    let late: ((event: ServerEvent) => void) | undefined;
    const subscribe: EventSubscriber = (onEvent, onClose) => {
      if (late) return;
      late = onEvent;
      onEvent({ type: "server.connected", data: {} } as ServerEvent);
      onClose();
    };
    stream = new EventStream({ subscribe, onEvent: (e) => events.push(e), minBackoffMs: 5 });
    stream.start();
    late?.({ type: "session.idle", data: { sessionID: "ses" } } as ServerEvent);
    expect(events.map((e) => e.type)).toEqual(["server.connected"]);
  });

  it("backs off exponentially while subscriptions fail without delivering events", async () => {
    vi.useFakeTimers();
    // Neutral jitter (factor 1.0) so the doubling sequence is exact.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const times: number[] = [];
      const subscribe: EventSubscriber = (_onEvent, onClose) => {
        times.push(Date.now());
        onClose(new Error("unreachable"));
      };
      stream = new EventStream({ subscribe, onEvent: () => {}, minBackoffMs: 100, maxBackoffMs: 10_000 });
      stream.start();
      await vi.advanceTimersByTimeAsync(5_000);
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      expect(gaps.length).toBeGreaterThanOrEqual(3);
      expect(gaps.slice(0, 4)).toEqual([100, 200, 400, 800]);
    } finally {
      stream?.close();
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries when the subscriber throws synchronously", async () => {
    let connections = 0;
    const subscribe: EventSubscriber = () => {
      connections++;
      throw new Error("client disposed");
    };
    stream = new EventStream({ subscribe, onEvent: () => {}, minBackoffMs: 5 });
    stream.start();
    await waitUntil(() => connections >= 2, 2000);
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  it("reports an error that ends a subscription", async () => {
    let done: ((error?: unknown) => void) | undefined;
    const statuses: string[] = [];
    const subscribe: EventSubscriber = (_onEvent, onClose) => {
      done = onClose;
    };
    stream = new EventStream({ subscribe, onEvent: () => {}, onStatus: (s, e) => statuses.push(e ? "error" : s), minBackoffMs: 10 });
    stream.start();
    done?.(new Error("stream broke"));
    expect(statuses).toContain("error");
  });

  it("does not resubscribe after close()", async () => {
    let connections = 0;
    let done: ((error?: unknown) => void) | undefined;
    const subscribe: EventSubscriber = (_onEvent, onClose) => {
      connections++;
      done = onClose;
    };
    stream = new EventStream({ subscribe, onEvent: () => {}, minBackoffMs: 10 });
    stream.start();
    stream.close();
    done?.();
    await new Promise((r) => setTimeout(r, 40));
    expect(connections).toBe(1);
  });

  it("passes an abort signal so a closed subscription can be cancelled", async () => {
    const seen: AbortSignal[] = [];
    const subscribe: EventSubscriber = (_onEvent, _onClose, signal) => {
      seen.push(signal);
    };
    stream = new EventStream({ subscribe, onEvent: () => {} });
    stream.start();
    expect(seen[0].aborted).toBe(false);
    stream.close();
    expect(seen[0].aborted).toBe(true);
  });
});

export async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
