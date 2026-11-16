import type { PermissionRule } from "../client/http";

/**
 * OpenCode's base policy is `{ action: "*", resource: "*", effect: "allow" }`, so a session
 * created without rules edits files and runs shell commands without prompting. These rules
 * override it for the consequential actions. Users can tighten, relax or disable them (set the
 * setting to `[]` to restore OpenCode's permissive defaults) via `opencode.sessionPermissions`.
 *
 * Kept in sync with the `package.json` default by a unit test. See docs/API_NOTES.md and
 * https://opencode.ai/docs/permissions/ (v2 action names: `edit`, `shell`, not v1's `bash`).
 */
export const DEFAULT_SESSION_PERMISSIONS: PermissionRule[] = [
  { action: "edit", resource: "*", effect: "ask" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
];
