import { afterEach, describe, expect, it } from "vitest";
import { EventStream, SseParser, parseServerEvent, type SseMessage } from "../../src/client/sse";
import type { ServerEvent } from "../../src/shared/api";
import { startMockServer, type MockServer } from "../mock/mockServer";

function collect(chunks: string[]): { messages: SseMessage[]; comments: string[] } {
  const messages: SseMessage[] = [];
  const comments: string[] = [];
  const p = new SseParser((m) => messages.push(m), (c) => comments.push(c));
  for (const c of chunks) p.feed(c);
  p.end();
  return { messages, comments };
}

describe("SseParser", () => {
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

  it("ignores malformed JSON when decoding server events", () => {
    expect(parseServerEvent({ data: "{nope" })).toBeUndefined();
    expect(parseServerEvent({ data: '{"no":"type"}' })).toBeUndefined();
    expect(parseServerEvent({ data: '{"type":"a","data":{}}' })?.type).toBe("a");
    expect(parseServerEvent({ data: '{"type":"a","data":null}' })).toBeUndefined();
    expect(parseServerEvent({ data: '{"type":"a","data":"oops"}' })).toBeUndefined();
    expect(parseServerEvent({ data: '{"type":"a","data":[1]}' })).toBeUndefined();
  });
});

describe("EventStream", () => {
  let mock: MockServer | undefined;
  let stream: EventStream | undefined;
  afterEach(async () => {
    stream?.close();
    await mock?.close();
  });

  it("reconnects after the server drops the connection", async () => {
    mock = await startMockServer({ password: "pw" });
    const events: ServerEvent[] = [];
    const statuses: string[] = [];
    stream = new EventStream({
      url: `${mock.url}/api/event`,
      headers: { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") },
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      minBackoffMs: 20,
    });
    stream.start();
    await waitUntil(() => events.length === 1);
    mock.dropConnections();
    await waitUntil(() => events.filter((e) => e.type === "server.connected").length === 2);
    expect(statuses).toEqual(["connected", "reconnecting", "connected"]);
    mock.emit({ type: "custom.ping", data: { ok: true } });
    await waitUntil(() => events.some((e) => e.type === "custom.ping"));
  });

  it("flushes a multi-byte character split at the very end of the stream", async () => {
    const bytes = new TextEncoder().encode('data: {"type":"custom.unicode","data":{"v":"é"}}\n\n');
    const split = bytes.indexOf(0xc3); // first byte of the two-byte é
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, split + 1));
            controller.enqueue(bytes.slice(split + 1));
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const events: ServerEvent[] = [];
    stream = new EventStream({
      url: "http://localhost/api/event",
      headers: {},
      onEvent: (e) => events.push(e),
      fetchImpl,
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    stream.start();
    await waitUntil(() => events.some((e) => e.type === "custom.unicode"));
    expect((events.find((e) => e.type === "custom.unicode")!.data as { v: string }).v).toBe("é");
  });

  it("reports reconnecting on 401 and keeps retrying", async () => {
    mock = await startMockServer({ password: "pw" });
    const statuses: string[] = [];
    stream = new EventStream({
      url: `${mock.url}/api/event`,
      headers: {},
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    stream.start();
    await waitUntil(() => mock!.requests.filter((r) => r.path === "/api/event").length >= 3);
    expect(statuses[0]).toBe("reconnecting");
    expect(statuses).not.toContain("connected");
  });

  it("reconnects when the server accepts the socket but never sends headers", async () => {
    let connects = 0;
    const statuses: string[] = [];
    // A real fetch rejects when its signal aborts; the stalled server is emulated that way.
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      connects++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("connect timed out")), { once: true });
      });
    }) as typeof fetch;
    stream = new EventStream({
      url: "http://localhost/api/event",
      headers: {},
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      fetchImpl,
      connectTimeoutMs: 30,
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    stream.start();
    await waitUntil(() => connects >= 2, 2000);
    expect(statuses).toContain("reconnecting");
  });

  it("aborts and reconnects when idle longer than the watchdog", async () => {
    mock = await startMockServer({ password: "pw" });
    let connects = 0;
    stream = new EventStream({
      url: `${mock.url}/api/event`,
      headers: { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64") },
      onEvent: (e) => {
        if (e.type === "server.connected") connects++;
      },
      idleTimeoutMs: 50, // mock heartbeats every 1s, so the watchdog fires first
      minBackoffMs: 10,
    });
    stream.start();
    await waitUntil(() => connects >= 2, 3000);
  });
});

export async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
