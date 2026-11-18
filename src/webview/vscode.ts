import type { HostMessage, WebviewMessage } from "../shared/protocol";

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
    const data = e.data as HostMessage | undefined;
    if (data && typeof data === "object" && typeof data.type === "string") handler(data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export interface PersistedState {
  /** Legacy global draft, kept for old saved state and for the "no session" case. */
  draft?: string;
  /** Drafts keyed by session id. */
  drafts?: Record<string, string>;
}

export function getPersisted(): PersistedState {
  return (api.getState() as PersistedState | undefined) ?? {};
}

export function setPersisted(state: PersistedState): void {
  api.setState(state);
}

/** Read the composer draft for a session; without a session id, use the legacy global field. */
export function getDraft(sessionId?: string): string {
  const state = getPersisted();
  return sessionId === undefined ? state.draft ?? "" : state.drafts?.[sessionId] ?? "";
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
