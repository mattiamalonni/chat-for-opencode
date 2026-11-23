import { useEffect, useRef } from "preact/hooks";
import type { ModelInfo } from "../shared/api";

import { type SubagentState } from "../shared/subagents";
import { AttentionOverlay } from "./attentionOverlay";

import { isolateKeys } from "./env";
import { useT } from "./i18n";
import { IconChevron, IconClose } from "./icons";

import { type SubagentEntry } from "./subagents";

/**
 * Read-only drill-down into a child session. It reuses the very same `Conversation` as the main
 * chat but with the child's `ChatState`, so steps, tools, reasoning and report render identically.
 * No composer or host actions are wired: replies and prompts still belong to the parent chat.
 */
export function SubagentModal({
  stack,
  entries,
  labels,
  subagents,
  parentTitle,
  models,
  onNavigate,
  onClose,
}: {
  stack: string[];
  entries: Record<string, SubagentEntry>;
  labels: Record<string, string>;
  subagents: SubagentState;
  parentTitle: string;
  models: ModelInfo[];
  onNavigate: (depth: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const currentId = stack[stack.length - 1];
  const entry = entries[currentId];
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Restore focus to the tool button that opened the dialog; without this, Tab starts again
    // from the top of the hidden conversation behind the backdrop.
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    // Escape and Tab must work even before the focus effect above has run.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.getClientRects().length > 0);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);
  return (
    <div
      class="subagent-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="subagent-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("subagentConversation")}
        tabIndex={-1}
        ref={ref}
        onKeyDown={isolateKeys}
      >
        <header class="subagent-modal-header">
          <nav class="subagent-breadcrumb" aria-label={t("subagentConversation")}>
            <button type="button" class="crumb" onClick={() => onNavigate(-1)}>
              {parentTitle || t("mainChat")}
            </button>
            {stack.map((id, i) => {
              const meta = entries[id]?.meta;
              const label = labels[id] || meta?.agent || meta?.title || t("subagent");
              const current = i === stack.length - 1;
              return (
                <span class="crumb-part" key={id}>
                  <IconChevron class="chevron" />
                  <button
                    type="button"
                    class={`crumb${current ? " current" : ""}`}
                    aria-current={current ? "page" : undefined}
                    onClick={() => onNavigate(i)}
                  >
                    {label}
                  </button>
                </span>
              );
            })}
          </nav>
          <button type="button" class="icon-button tooltip-host" data-tooltip={t("dismiss")} aria-label={t("dismiss")} onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div class="subagent-modal-body">
          {entry ? (
            <>
              <Conversation chat={entry.state} models={models} scrollToken={0} searchQuery="" label={t("subagentConversation")} />
              {/* The backdrop hides the chat's overlay, so a subagent waiting for approval needs its
                  own card here. Replies still carry the child's session id. */}
              <AttentionOverlay key={currentId} state={entry.state} subagents={subagents} />
            </>
          ) : (
            <div class="empty">{t("loadingSubagent")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

import { Conversation } from "./conversation";
