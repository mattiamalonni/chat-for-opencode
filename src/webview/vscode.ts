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
  draft?: string;
}

export function getPersisted(): PersistedState {
  return (api.getState() as PersistedState | undefined) ?? {};
}

export function setPersisted(state: PersistedState): void {
  api.setState(state);
}
