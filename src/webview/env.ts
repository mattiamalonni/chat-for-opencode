import { shouldIsolateKey, type Platform } from "../shared/keys";

export const env: { platform: Platform } = {
  platform: /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "mac" : /Win/.test(navigator.platform) ? "windows" : "linux",
};

/** Keeps typing keys inside text fields instead of letting VS Code run keybindings (see docs/DECISIONS.md D7). */
export function isolateKeys(e: KeyboardEvent): void {
  if (shouldIsolateKey(e, env.platform)) e.stopPropagation();
}
