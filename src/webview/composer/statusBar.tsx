import type { ModelInfo } from "../../shared/api";
import { ContextMeter } from "../contextMeter";
import { useT } from "../i18n";
import { IconCompact, IconFolder, IconFork, IconShield } from "../icons";
import { post } from "../vscode";

export function StatusBar(props: {
  busy: boolean;
  disabled: boolean;
  text: string;
  autoApprove: boolean;
  onToggleAutoApprove: (enabled: boolean) => void;
  /** A session is loaded and idle, so session-level actions (fork, compact) can be requested. */
  canActOnSession: boolean;
  contextTokens?: number;
  contextEstimated?: boolean;
  cost?: number;
  currentModel?: ModelInfo;
}) {
  const { text, currentModel } = props;
  const t = useT();
  return (
    <div class="drop-hint">
      <button
        type="button"
        class="icon-button tooltip-host tooltip-above"
        data-tooltip={t("pickFiles")}
        aria-label={t("pickFiles")}
        disabled={props.disabled}
        onClick={() => post({ type: "pickFiles" })}
      >
        <IconFolder />
      </button>
      <span>{props.busy && text.trim() ? t("queueHint") : t("dropFilesHint")}</span>
      <div class="drop-hint-tools">
        <button
          type="button"
          class={`auto-approve tooltip-host tooltip-above ${props.autoApprove ? "on" : ""}`}
          data-tooltip={props.autoApprove ? t("autoApproveOn") : t("autoApproveOff")}
          aria-label={t("autoApprove")}
          aria-pressed={props.autoApprove}
          onClick={() => props.onToggleAutoApprove(!props.autoApprove)}
        >
          <IconShield />
          <span>{t("autoApprove")}</span>
        </button>
        <button
          type="button"
          class="icon-button fork tooltip-host tooltip-above"
          data-tooltip={props.busy ? t("forkBusy") : t("forkTooltip")}
          aria-label={t("forkConversation")}
          disabled={props.disabled || !props.canActOnSession}
          onClick={() => post({ type: "fork" })}
        >
          <IconFork />
        </button>
        <button
          type="button"
          class="icon-button compact tooltip-host tooltip-above"
          data-tooltip={t("compactConversation")}
          aria-label={t("compactConversation")}
          disabled={props.disabled || !props.canActOnSession}
          onClick={() => post({ type: "compact" })}
        >
          <IconCompact />
        </button>
        {currentModel?.limit?.context ? (
          <ContextMeter
            used={props.contextTokens}
            estimated={props.contextEstimated}
            limit={currentModel.limit.context}
            cost={props.cost}
          />
        ) : props.cost !== undefined ? (
          <span
            class="context-meter cost-only tooltip-host tooltip-above"
            role="img"
            aria-label={t("sessionCost", `$${props.cost.toFixed(2)}`)}
            data-tooltip={t("sessionCost", `$${props.cost.toFixed(2)}`)}
          >
            ${props.cost.toFixed(2)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
