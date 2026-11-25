import type { UiError } from "../shared/protocol";

/** Errors whose fix is a setup step, not a retry: the empty state adapts to them. */
export const SETUP_ERROR_KINDS = new Set<UiError["kind"]>(["startFailed", "noProvider", "untrustedWorkspace", "noWorkspace"]);
