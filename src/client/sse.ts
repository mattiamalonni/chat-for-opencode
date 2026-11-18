import type { ServerEvent } from "../shared/api";

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Incremental parser for the text/event-stream format (WHATWG HTML §9.2).
 * Comment lines (`: heartbeat`) are reported through `onComment` so callers can use them as
 * keep-alive signals.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  private sawCR = false;

  constructor(
    private readonly onMessage: (msg: SseMessage) => void,
    private readonly onComment: (text: string) => void = () => {},
  ) {}

  feed(chunk: string): void {
    // A CR at the end of the previous chunk may be the first half of CRLF.
    if (this.sawCR && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.sawCR = chunk.endsWith("\r");
    this.buffer += chunk;
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  /** Flushes a trailing event when the stream ends without a final blank line. */
  end(): void {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    this.dispatch();
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) {
      this.onComment(line.slice(1).trimStart());
      return;
    }
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      default:
        break;
    }
  }

  private dispatch(): void {
    if (this.data.length === 0) {
      this.event = undefined;
      return;
    }
    const msg: SseMessage = { data: this.data.join("\n") };
    if (this.event !== undefined) msg.event = this.event;
    if (this.id !== undefined) msg.id = this.id;
    this.data = [];
    this.event = undefined;
    this.onMessage(msg);
  }
}

export function parseServerEvent(msg: SseMessage): ServerEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(msg.data);
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as ServerEvent;
    }
  } catch {
    // ignore malformed payloads
  }
  return undefined;
}

export type StreamStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface EventStreamOptions {
  url: string;
  headers: Record<string, string>;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: StreamStatus, error?: unknown) => void;
  /** Reconnect when nothing (not even a heartbeat) arrives for this long. */
  idleTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Long-lived SSE subscription with automatic reconnection and an idle watchdog.
 * The OpenCode stream is live-only, so callers must resync state when status returns to
 * `connected` after a `reconnecting`.
 */
export class EventStream {
  private controller: AbortController | undefined;
  private closed = false;
  private attempt = 0;
  private watchdog: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private status: StreamStatus = "connecting";

  constructor(private readonly opts: EventStreamOptions) {}

  start(): void {
    this.closed = false;
    void this.connect();
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.controller?.abort();
    this.setStatus("closed");
  }

  private setStatus(status: StreamStatus, error?: unknown): void {
    if (this.status === status && error === undefined) return;
    this.status = status;
    this.opts.onStatus?.(status, error);
  }

  private clearTimers(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.watchdog = undefined;
    this.retryTimer = undefined;
  }

  private kick(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    const timeout = this.opts.idleTimeoutMs ?? 60_000;
    this.watchdog = setTimeout(() => this.controller?.abort(), timeout);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    this.controller = controller;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let failure: unknown;
    try {
      const res = await fetchImpl(this.opts.url, {
        headers: { accept: "text/event-stream", ...this.opts.headers },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Event stream failed: HTTP ${res.status}`);
      this.attempt = 0;
      this.setStatus("connected");
      this.kick();
      const parser = new SseParser(
        (msg) => {
          const event = parseServerEvent(msg);
          if (event) this.opts.onEvent(event);
        },
        () => {},
      );
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.kick();
        parser.feed(decoder.decode(value, { stream: true }));
      }
      // Flush any bytes of a split multi-byte character still held by the decoder.
      parser.feed(decoder.decode());
      parser.end();
    } catch (err) {
      failure = err;
    }
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.closed) return;
    this.setStatus("reconnecting", failure);
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 10_000;
    const delay = Math.min(max, min * 2 ** this.attempt);
    this.attempt++;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
