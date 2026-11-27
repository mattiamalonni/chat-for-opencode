import { pathToFileURL } from "node:url";
import type { CreateHostOptions, SdkHost } from "./bridge";

/** The entry points the extension needs from the SDK bridge. */
export interface SdkBridge {
  createHost(options?: CreateHostOptions): Promise<SdkHost>;
  makeNetworkApi(baseUrl: string, password?: string): SdkHost;
}

let bridge: SdkBridge | undefined;
let bridgeModule: string | undefined;
let loading: Promise<SdkBridge> | undefined;

/** Test seam: inject a fake bridge instead of the real SDK. */
export function setSdkBridge(value: SdkBridge | undefined): void {
  bridge = value;
  loading = undefined;
}

/**
 * Activation registers the path of the separately bundled bridge (`dist/sdk.mjs`). The OpenCode
 * SDK is ~20 MB of JavaScript: importing it on first connect instead of at activation keeps it off
 * VS Code's startup path for windows that never open the chat.
 */
export function setSdkBridgeModule(path: string | undefined): void {
  bridgeModule = path;
  loading = undefined;
}

/**
 * Resolves the bridge: an injected one, else the module from `OC_SDK_BRIDGE_MODULE` (integration
 * tests point it at a mock-backed bridge), else the bundled one registered at activation.
 */
export function loadSdkBridge(): Promise<SdkBridge> {
  if (bridge) return Promise.resolve(bridge);
  const path = process.env.OC_SDK_BRIDGE_MODULE ?? bridgeModule;
  if (!path) return Promise.reject(new Error("SDK bridge not registered (activation did not run)"));
  if (!loading) {
    const pending = import(pathToFileURL(path).href) as unknown as Promise<SdkBridge>;
    loading = pending;
    // A failed import (e.g. a missing native module) must be retried on the next connect.
    pending.catch(() => {
      if (loading === pending) loading = undefined;
    });
  }
  return loading;
}
