import type { HostMessage, WebviewMessage } from "../shared/protocol";
import { isHostMessage } from "../shared/protocolGuards";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : {
        // Standalone (tests / browser preview): log instead of posting.
        postMessage: (msg) => (window as unknown as { __posted?: unknown[] }).__posted?.push(msg),
        getState: () => undefined,
        setState: () => {},
      };

export function post(msg: WebviewMessage): void {
  api.postMessage(msg);
}

export function onHostMessage(handler: (msg: HostMessage) => void): () => void {
  const listener = (e: MessageEvent) => {
    // The host is the trusted producer, but a stale bundle or a mismatched payload must not reach
    // the reducer: validate the message shape before handing it to the app.
    if (isHostMessage(e.data)) handler(e.data);
    else console.warn("[webview] ignored an invalid host message", e.data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

interface PersistedState {
  /** Legacy global draft, kept for old saved state and for the "no session" case. */
  draft?: string;
  /** Drafts keyed by session id. */
  drafts?: Record<string, string>;
}

function getPersisted(): PersistedState {
  return (api.getState() as PersistedState | undefined) ?? {};
}

function setPersisted(state: PersistedState): void {
  api.setState(state);
}

/** Read the composer draft for a session; without a session id, use the legacy global field. */
export function getDraft(sessionId?: string): string {
  const state = getPersisted();
  return sessionId === undefined ? (state.draft ?? "") : (state.drafts?.[sessionId] ?? "");
}

/** Persist a composer draft for a session, preserving the rest of the saved state. */
export function setDraft(text: string, sessionId?: string): void {
  const state = getPersisted();
  if (sessionId === undefined) setPersisted({ ...state, draft: text });
  else setPersisted({ ...state, drafts: { ...state.drafts, [sessionId]: text } });
}

/** Merge drafts restored by the host into the fast local state (kept across view rebuilds). */
export function hydrateDrafts(drafts: Record<string, string>, globalDraft?: string): void {
  const state = getPersisted();
  setPersisted({
    ...state,
    drafts: { ...drafts, ...state.drafts },
    draft: state.draft ?? globalDraft,
  });
}
