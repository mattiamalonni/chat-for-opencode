import { useT } from "../i18n";
import { Picker } from "../picker";

/**
 * Compact dropdown for OpenCode's built-in `build` and `plan` agents. It is always shown: older
 * servers may not expose `/api/agent`, but both agents still exist and can be selected on a session.
 */
export function ModePicker(props: { selectedAgent?: string; onSelect: (agent: string) => void }) {
  const t = useT();
  return (
    <Picker
      label={t("mode")}
      class="mode"
      items={[
        { value: "build", label: t("build"), description: t("buildModeTooltip") },
        { value: "plan", label: t("plan"), description: t("planModeTooltip") },
      ]}
      value={props.selectedAgent === "plan" ? "plan" : "build"}
      onChange={props.onSelect}
    />
  );
}
