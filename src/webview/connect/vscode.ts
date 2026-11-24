import type { ConnectHostMessage, ConnectWebviewMessage } from "../../shared/protocol";
import { isConnectHostMessage } from "../../shared/protocolGuards";

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
        // Standalone (tests / browser preview): record instead of posting.
        postMessage: (msg) => (window as unknown as { __posted?: unknown[] }).__posted?.push(msg),
        getState: () => undefined,
        setState: () => {},
      };

export function post(msg: ConnectWebviewMessage): void {
  api.postMessage(msg);
}

export function onHostMessage(handler: (msg: ConnectHostMessage) => void): () => void {
  const listener = (e: MessageEvent) => {
    if (isConnectHostMessage(e.data)) handler(e.data);
    else console.warn("[connect] ignored an invalid host message", e.data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
