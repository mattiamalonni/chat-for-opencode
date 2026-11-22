/** Storage keys shared by the controller and the webview command handler. */
export const PASSWORD_KEY = (endpoint: string) => `opencode.password:${endpoint}`;
export const SESSION_KEY = (folder: string) => `opencode.session:${folder}`;
export const COMPAT_DISMISSED_KEY = "opencode.compatibilityDismissedFor";
export const CONTRACT_DISMISSED_KEY = "opencode.contractDismissedFor";
export const DRAFTS_KEY = (folder: string) => `opencode.drafts:${folder}`;
