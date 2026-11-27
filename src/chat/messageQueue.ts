import type { WebviewMessage } from "../shared/protocol";

/**
 * Messages that only open, copy or look something up for the user and never touch chat state.
 * They skip the queue, so a link or a file opens at once even while a connect or a session load
 * is still running.
 *
 * Everything else stays strictly ordered. That ordering is deliberate: a "stop" queued after a
 * "send" must interrupt the turn that send started, not an idle session before the prompt was
 * accepted, and `searchFiles` answers must arrive in request order because the composer shows
 * the latest one it received.
 */
export const CONCURRENT_MESSAGE_TYPES: ReadonlySet<WebviewMessage["type"]> = new Set<WebviewMessage["type"]>([
  "copy",
  "fileIcons",
  "openAttachment",
  "openDiff",
  "openDiffs",
  "openFile",
  "openLink",
  "openToolFile",
]);

/** Runs webview messages one at a time, except the {@link CONCURRENT_MESSAGE_TYPES}. */
export class WebviewMessageQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run(msg: WebviewMessage, handle: (msg: WebviewMessage) => Promise<void>): Promise<void> {
    if (CONCURRENT_MESSAGE_TYPES.has(msg.type)) return handle(msg);
    const run = this.tail.then(() => handle(msg));
    // Keep the chain alive after a failed message so later ones are still processed.
    this.tail = run.catch(() => undefined);
    return run;
  }
}
