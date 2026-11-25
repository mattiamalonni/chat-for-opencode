import { pathToFileURL } from "node:url";
import type { CreateHostOptions, SdkHost } from "./bridge";

/** The entry points the extension needs from the SDK bridge. */
export interface SdkBridge {
  createHost(options?: CreateHostOptions): Promise<SdkHost>;
  makeNetworkApi(baseUrl: string, password?: string): SdkHost;
}

let bridge: SdkBridge | undefined;

/** Test seam: inject a fake bridge instead of the real SDK. */
export function setSdkBridge(value: SdkBridge | undefined): void {
  bridge = value;
}

/**
 * The extension installs the bundled bridge at activation. Integration tests override it through
 * `OC_SDK_BRIDGE_MODULE` so the embedded-host code path can run against the mock API.
 */
export function loadSdkBridge(): Promise<SdkBridge> {
  if (bridge) return Promise.resolve(bridge);
  const override = process.env.OC_SDK_BRIDGE_MODULE;
  if (!override) return Promise.reject(new Error("SDK bridge not registered (activation did not run)"));
  return import(pathToFileURL(override).href) as unknown as Promise<SdkBridge>;
}
