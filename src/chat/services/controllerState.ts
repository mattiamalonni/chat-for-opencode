import type * as vscode from "vscode";
import type { ContractObservations, ContractReport } from "../../shared/contract";
import { emptyContract } from "../../shared/contract";
import type { Attachment, ConnectionStatus, ContextItem, UiError } from "../../shared/protocol";

/** Payload kept so the "Retry" action can resend exactly what the server refused. */
export interface FailedPrompt {
  text: string;
  attachments: Attachment[];
  context: ContextItem[];
  delivery?: "steer" | "queue";
  sessionId?: string;
}

/**
 * Every mutable scalar shared by the controller's feature areas.
 *
 * The fields used to be scattered as private members of `ChatController`, which forced every
 * extracted service to reach back through a wide hook interface. Keeping them in one object lets
 * the services read and write the same state by reference while the controller stays a coordinator.
 * Generation tokens and timers remain in their own owners (`ChatLifecycle`, `ExecutionStateService`,
 * `Generation`) — only the values they guard live here.
 */
export interface ControllerState {
  folder: vscode.WorkspaceFolder | undefined;
  sessionId: string | undefined;
  status: ConnectionStatus;
  lastError: UiError | undefined;
  version: string | undefined;
  contractObservations: ContractObservations;
  contract: ContractReport;
  lastKnownMessage: { sessionId: string; id: string } | undefined;
  catalogRetries: number;
  lastSessionEventAt: number;
  deleteAllAbort: AbortController | undefined;
  connectionAbort: AbortController | undefined;
  failedPrompt: FailedPrompt | undefined;
}

export function createControllerState(): ControllerState {
  return {
    folder: undefined,
    sessionId: undefined,
    status: "idle",
    lastError: undefined,
    version: undefined,
    contractObservations: {},
    contract: emptyContract,
    lastKnownMessage: undefined,
    catalogRetries: 0,
    lastSessionEventAt: 0,
    deleteAllAbort: undefined,
    connectionAbort: undefined,
    failedPrompt: undefined,
  };
}
