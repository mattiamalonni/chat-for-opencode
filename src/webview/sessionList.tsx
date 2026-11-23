import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { SessionSummary } from "../shared/protocol";

import { isolateKeys } from "./env";
import { useT } from "./i18n";
import { IconEdit, IconPlus, IconTrash, IconWarning } from "./icons";

import { post } from "./vscode";

let relativeFormatter: Intl.RelativeTimeFormat | undefined;
let relativeFormatterLang: string | undefined;
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  // Intl formatter construction is expensive; building one per session row per render is waste.
  const lang = document.documentElement.lang || undefined;
  if (!relativeFormatter || relativeFormatterLang !== lang) {
    relativeFormatter = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    relativeFormatterLang = lang;
  }
  const rtf = relativeFormatter;
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

export function SessionList(props: {
  sessions: SessionSummary[];
  currentId: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [confirm, setConfirm] = useState<string | undefined>();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const filterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visible = useMemo(
    () => props.sessions.filter((s) => `${s.title || t("untitled")} ${s.folder ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase())),
    [props.sessions, filter, t],
  );
  useEffect(() => {
    filterRef.current?.focus();
    return () => {
      if (filterTimer.current) clearTimeout(filterTimer.current);
    };
  }, []);
  // Inline forms replace their focused button; return focus to the dialog so Escape keeps working.
  const closeInline = () => {
    setRenaming(undefined);
    setConfirm(undefined);
    ref.current?.focus();
  };
  const saveRename = () => {
    if (!renaming) return;
    const title = draft.trim();
    if (title) post({ type: "renameSession", id: renaming, title });
    closeInline();
  };
  return (
    <div
      class="session-list"
      ref={ref}
      role="dialog"
      tabIndex={-1}
      aria-label={t("sessions")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (renaming || confirm) closeInline();
          else props.onClose();
          return;
        }
        // Roving focus: ↑/↓ walk the filtered rows, Enter activates the focused button.
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (visible.length === 0) return;
          const next = Math.min(visible.length - 1, Math.max(0, activeIndex + (e.key === "ArrowDown" ? 1 : -1)));
          setActiveIndex(next);
          const id = visible[next]?.id;
          if (id) itemRefs.current.get(id)?.focus();
        }
      }}
    >
      <div class="session-header">
        <button type="button" class="session-new" onClick={() => post({ type: "newSession" })}>
          <IconPlus /> {t("newSession")}
        </button>
        {props.sessions.length > 0 && (
          <button
            type="button"
            class="icon-button tooltip-host session-delete-all"
            data-tooltip={t("deleteAllSessions")}
            aria-label={t("deleteAllSessions")}
            onClick={() => post({ type: "deleteAllSessions" })}
          >
            <IconTrash />
          </button>
        )}
        <input
          ref={filterRef}
          type="search"
          class="session-filter"
          aria-label={t("filterSessions")}
          placeholder={t("filterSessions")}
          value={filter}
          onInput={(e) => {
            const value = (e.currentTarget as HTMLInputElement).value;
            setFilter(value);
            setActiveIndex(0);
            if (filterTimer.current) clearTimeout(filterTimer.current);
            // Keep paging until a match appears; the loaded titles are filtered locally.
            if (value.trim()) filterTimer.current = setTimeout(() => props.onLoadMore(), 250);
          }}
          onKeyDown={isolateKeys}
        />
      </div>
      {visible.length === 0 && <div class="empty">{t("noSessions")}</div>}
      <ul>
        {visible.map((s, i) => (
          <li key={s.id} class={s.id === props.currentId ? "current" : ""}>
            {renaming === s.id ? (
              <div class="rename" role="group" aria-label={t("renameSession")}>
                <div class="inline-message">
                  <IconEdit class="inline-icon" />
                  <span class="inline-question">{t("renameSession")}</span>
                </div>
                <input
                  type="text"
                  class="rename-input"
                  aria-label={t("sessionTitle")}
                  value={draft}
                  autoFocus
                  onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    isolateKeys(e);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      closeInline();
                    }
                  }}
                />
                <div class="inline-actions">
                  <button type="button" class="secondary compact" onClick={closeInline}>
                    {t("cancel")}
                  </button>
                  <button type="button" class="primary compact" onClick={saveRename}>
                    {t("save")}
                  </button>
                </div>
              </div>
            ) : confirm === s.id ? (
              <div class="confirm" role="group" aria-label={`${t("confirmDelete")}: ${s.title || t("untitled")}`}>
                <div class="inline-message">
                  <IconWarning class="inline-icon" />
                  <div class="inline-text">
                    <span class="inline-question">{t("confirmDelete")}</span>
                    <span class="inline-session" title={s.title || t("untitled")}>
                      {s.title || t("untitled")}
                    </span>
                  </div>
                </div>
                <div class="inline-actions">
                  <button type="button" class="secondary compact" onClick={closeInline} autoFocus>
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    class="primary danger compact"
                    onClick={() => {
                      post({ type: "deleteSession", id: s.id });
                      closeInline();
                    }}
                  >
                    {t("deleteSession")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  ref={(el) => {
                    if (el) itemRefs.current.set(s.id, el);
                    else itemRefs.current.delete(s.id);
                  }}
                  class="session-item"
                  aria-current={s.id === props.currentId}
                  onFocus={() => setActiveIndex(i)}
                  onClick={() => post({ type: "selectSession", id: s.id })}
                >
                  {(s.busy || s.needsInput) && (
                    <span class={`status-dot session-busy ${s.needsInput ? "waiting" : "running"}`} aria-hidden="true" />
                  )}
                  <span class="session-name">
                    {s.title || t("untitled")}
                    {s.folder && <span class="session-folder">{s.folder}</span>}
                  </span>
                  <span class="session-time">{s.needsInput ? t("needsInput") : s.busy ? t("running") : relativeTime(s.updated)}</span>
                </button>
                <button
                  type="button"
                  class="icon-button tooltip-host tooltip-above"
                  data-tooltip={t("renameSession")}
                  aria-label={`${t("renameSession")}: ${s.title || t("untitled")}`}
                  onClick={() => {
                    setConfirm(undefined);
                    setDraft(s.title);
                    setRenaming(s.id);
                  }}
                >
                  <IconEdit />
                </button>
                <button
                  type="button"
                  class="icon-button tooltip-host tooltip-above"
                  data-tooltip={t("deleteSession")}
                  aria-label={`${t("deleteSession")}: ${s.title || t("untitled")}`}
                  onClick={() => setConfirm(s.id)}
                >
                  <IconTrash />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {props.hasMore && (
        <button type="button" class="session-more" onClick={props.onLoadMore}>
          {t("loadMoreSessions")}
        </button>
      )}
    </div>
  );
}
