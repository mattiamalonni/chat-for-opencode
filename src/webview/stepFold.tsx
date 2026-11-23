import { createContext, type ComponentChildren } from "preact";
import { useContext, useState } from "preact/hooks";

import { useT } from "./i18n";
import { IconChevron } from "./icons";

/** Per-turn fold overrides: a finished turn keeps its steps open until the user folds them. */
export interface StepGroup {
  keys: string[];
  defaults: Map<string, boolean>;
}
export interface StepControl {
  expanded: (key: string, fallback: boolean) => boolean;
  toggle: (key: string, fallback: boolean) => void;
  toggleGroup: (group: StepGroup) => void;
}
export const StepControlContext = createContext<StepControl | undefined>(undefined);

/** One step: its prose is always visible, its thoughts/tools expand on demand. */
export function StepBlock({
  index,
  lastIndex,
  details,
  live,
  controlKey,
  group,
  filteredOut = false,
  searchActive = false,
  render,
}: {
  index: number;
  lastIndex: number;
  details: ConversationItem[];
  live: boolean;
  controlKey?: string;
  group?: StepGroup;
  filteredOut?: boolean;
  searchActive?: boolean;
  render: (item: ConversationItem, q: string) => ComponentChildren;
}) {
  const t = useT();
  const control = useContext(StepControlContext);
  const [open, setOpen] = useState(false);
  const fallback = live || open || searchActive;
  const expanded = control && controlKey ? control.expanded(controlKey, fallback) : fallback;
  const label = lastIndex > index ? t("stepsRange", index + 1, lastIndex + 1) : t("stepLabel", index + 1);
  return (
    <section class={`step-block${filteredOut ? " filtered-out" : ""}`}>
      <div class="step-fold">
        <div class="step-fold-bar">
          <button
            type="button"
            class="step-fold-header"
            aria-expanded={expanded}
            aria-label={label}
            onClick={() => (control && controlKey ? control.toggle(controlKey, fallback) : setOpen(!open))}
          >
            <IconChevron class="chevron" />
            <span>{label}</span>
          </button>
          {group && control && group.keys[0] === controlKey && (
            <button
              type="button"
              class="step-fold-all tooltip-host"
              aria-label={expanded ? t("collapseAllSteps") : t("expandAllSteps")}
              data-tooltip={expanded ? t("collapseAllSteps") : t("expandAllSteps")}
              onClick={() => control.toggleGroup(group)}
            >
              {expanded ? t("collapseAll") : t("expandAll")}
            </button>
          )}
        </div>
        {expanded && (
          <div class="step-fold-body">
            {details.map((d, i) => (
              <div key={`${(d as { key?: string }).key ?? i}`}>{render(d, "")}</div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

import type { ConversationItem } from "./conversationModel";
