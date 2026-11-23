import type { AgentInfo, ModelInfo, ModelRef } from "../../shared/api";
import { useT } from "../i18n";
import { IconSend, IconStop } from "../icons";
import { Picker } from "../picker";
import { post } from "../vscode";
import { ModePicker } from "./modePicker";

export type ModelPickerItem = {
  value: string;
  label: string;
  group: string;
  description: string;
  meta?: string;
  metaLabel?: string;
};

export function Toolbar(props: {
  selectedAgent?: string;
  selectedModel?: ModelRef;
  agents: AgentInfo[];
  models: ModelInfo[];
  busy: boolean;
  disabled: boolean;
  hasExtraAgents: boolean;
  modelItems: ModelPickerItem[];
  modelKey: string;
  currentModel?: ModelInfo;
  text: string;
  onSend: (delivery?: "steer") => void;
}) {
  const { hasExtraAgents, modelItems, modelKey, currentModel, text } = props;
  const send = props.onSend;
  const t = useT();
  return (
    <div class="toolbar">
      <ModePicker selectedAgent={props.selectedAgent} onSelect={(agent) => post({ type: "setAgent", agent })} />
      {hasExtraAgents && (
        <Picker
          label={t("agent")}
          class="agent"
          items={props.agents.map((a) => ({ value: a.id, label: a.name, description: a.description }))}
          value={props.selectedAgent}
          onChange={(agent) => post({ type: "setAgent", agent })}
        />
      )}
      {props.models.length > 0 && (
        <Picker
          label={t("model")}
          class="model"
          searchable={props.models.length > 6}
          searchPlaceholder={t("searchModels")}
          emptyText={t("noModelsFound")}
          placeholder={t("model")}
          items={modelItems}
          value={modelKey}
          onChange={(key) => {
            const [providerID, ...rest] = key.split("/");
            post({ type: "setModel", model: { providerID, id: rest.join("/") } });
          }}
        />
      )}
      {currentModel && currentModel.variants.length > 0 && (
        <Picker
          label={t("variant")}
          class="variant"
          items={[{ value: "", label: t("defaultVariant") }, ...currentModel.variants.map((v) => ({ value: v.id, label: v.id }))]}
          value={props.selectedModel?.variant ?? ""}
          onChange={(v) =>
            post({
              type: "setModel",
              model: { providerID: currentModel.providerID, id: currentModel.id, ...(v ? { variant: v } : {}) },
            })
          }
        />
      )}
      {props.busy && (
        <button
          type="button"
          class="send stop tooltip-host tooltip-above"
          data-tooltip={`${t("stop")} (Esc)`}
          aria-label={t("stop")}
          onClick={() => post({ type: "abort" })}
        >
          <IconStop />
        </button>
      )}
      <button
        type="button"
        class={`send ${props.busy ? "steer" : ""} tooltip-host tooltip-above`}
        data-tooltip={props.busy ? t("steerTooltip") : `${t("send")} (Enter)`}
        aria-label={props.busy ? t("steerTooltip") : t("send")}
        disabled={props.disabled || !text.trim()}
        onClick={() => (props.busy ? send("steer") : send())}
      >
        <IconSend />
      </button>
    </div>
  );
}
