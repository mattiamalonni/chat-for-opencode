import { useEffect, useState } from "preact/hooks";
import type { ReplyTarget } from "../shared/protocol";

/**
 * Tracks reply requests that failed in the host so inline cards can re-enable their buttons.
 *
 * A failed `permissionReply` / `formReply` only produces a generic `notice`: the server never emits
 * the matching `*.replied` event, so the reducer keeps the request and the card would otherwise stay
 * disabled forever (no way to retry). The host tags those notices with the target id (see
 * `UiError.target`), which is recorded here and observed by the cards.
 */

const failed = new Set<string>();
const listeners = new Set<() => void>();

function key(kind: ReplyTarget["kind"], id: string): string {
  return `${kind}:${id}`;
}

export function markReplyFailed(target: ReplyTarget): void {
  const k = key(target.kind, target.id);
  if (failed.has(k)) return;
  failed.add(k);
  for (const listener of listeners) listener();
}

export function clearReplyFailure(target: ReplyTarget): void {
  const k = key(target.kind, target.id);
  if (!failed.delete(k)) return;
  for (const listener of listeners) listener();
}

/** Called when loading a different session: failures belong to the previous conversation. */
export function clearReplyFailures(): void {
  if (failed.size === 0) return;
  failed.clear();
  for (const listener of listeners) listener();
}

export function useReplyFailed(kind: ReplyTarget["kind"], id: string): boolean {
  const [value, setValue] = useState(() => failed.has(key(kind, id)));
  useEffect(() => {
    const update = () => setValue(failed.has(key(kind, id)));
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, [kind, id]);
  return value;
}
