import type { ServerEvent } from "../shared/api";
import { jitteredDelay } from "../shared/constants";

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/** Thrown when a stream sends an incomplete line or event larger than the configured cap. */
export class SseOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseOverflowError";
  }
}

export interface SseParserOptions {
  maxUnfinishedBytes?: number;
  maxEventBytes?: number;
}

const DEFAULT_MAX_UNFINISHED_BYTES = 512 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;

/**
 * Parser for recorded wire-format fixtures in `test/unit/sse.test.ts`. Runtime events arrive as
 * typed objects from the SDK.
 */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  private sawCR = false;
  private dataBytes = 0;

  constructor(
    private readonly onMessage: (msg: SseMessage) => void,
    private readonly onComment: (text: string) => void = () => {},
    private readonly opts: SseParserOptions = {},
  ) {}

  feed(chunk: string): void {
    if (this.sawCR && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.sawCR = chunk.endsWith("\r");
    this.buffer += chunk;
    if (this.buffer.length > (this.opts.maxUnfinishedBytes ?? DEFAULT_MAX_UNFINISHED_BYTES)) {
      throw new SseOverflowError("SSE line exceeded the size limit");
    }
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

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
        this.dataBytes += value.length;
        if (this.dataBytes > (this.opts.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES)) {
          throw new SseOverflowError("SSE event exceeded the size limit");
        }
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
    this.dataBytes = 0;
    this.event = undefined;
    this.onMessage(msg);
  }
}

export function parseServerEvent(msg: SseMessage): ServerEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(msg.data);
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      const data = (parsed as { data?: unknown }).data;
      if (data !== undefined && (!data || typeof data !== "object" || Array.isArray(data))) return undefined;
      return parsed as ServerEvent;
    }
  } catch {
    // ignore malformed payloads
  }
  return undefined;
}

export type StreamStatus = "connecting" | "connected" | "reconnecting" | "closed";

export type EventSubscriber = (onEvent: (event: ServerEvent) => void, onClose: (error?: unknown) => void, signal: AbortSignal) => void;

export interface EventStreamOptions {
  subscribe: EventSubscriber;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: StreamStatus, error?: unknown) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Keeps a live SDK event subscription alive. The SDK stream has no replay, so a reconnect is
 * always followed by a resync from history (driven by the controller via `onStatus`).
 */
export class EventStream {
  private controller: AbortController | undefined;
  private closed = false;
  private started = false;
  private generation = 0;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private status: StreamStatus = "connecting";

  constructor(private readonly opts: EventStreamOptions) {}

  start(): void {
    if (this.started && !this.closed) return;
    this.started = true;
    this.closed = false;
    ++this.generation;
    this.connect(this.generation);
  }

  close(): void {
    this.closed = true;
    ++this.generation;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.setStatus("closed");
  }

  private setStatus(status: StreamStatus, error?: unknown): void {
    if (this.status === status && error === undefined) return;
    this.status = status;
    this.opts.onStatus?.(status, error);
  }

  private connect(generation: number): void {
    if (this.closed || generation !== this.generation) return;
    const controller = new AbortController();
    this.controller = controller;
    // "connected" waits for the first event (the SDK always opens with `server.connected`): marking
    // every retry connected made an unreachable server flap connected/reconnecting, and each flap
    // triggered a full resync against a server that was not there.
    let delivered = false;
    let ended = false;
    const onClose = (error?: unknown) => {
      if (ended || this.closed || generation !== this.generation) return;
      ended = true;
      this.setStatus("reconnecting", error);
      const min = this.opts.minBackoffMs ?? 500;
      const max = this.opts.maxBackoffMs ?? 10_000;
      const delay = jitteredDelay(Math.min(max, min * 2 ** this.attempt));
      this.attempt++;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.connect(generation);
      }, delay);
    };
    const onEvent = (event: ServerEvent) => {
      // Only a subscription that actually delivers proves the server healthy. Resetting the
      // backoff on every (re)subscribe kept an unreachable server on a fixed ~500 ms retry loop.
      if (ended || generation !== this.generation) return;
      this.attempt = 0;
      if (!delivered) {
        delivered = true;
        this.setStatus("connected");
      }
      this.opts.onEvent(event);
    };
    try {
      this.opts.subscribe(onEvent, onClose, controller.signal);
    } catch (err) {
      // A subscriber that throws synchronously (e.g. a disposed client) would otherwise escape
      // from the retry timer as an uncaught exception and stop the reconnect loop for good.
      onClose(err);
    }
  }
}
