import { useEffect, useRef } from "preact/hooks";

import type { FolderInfo } from "../shared/protocol";

import { isolateKeys } from "./env";
import { useT } from "./i18n";
import { IconChevron, IconClose, IconDownload, IconHistory, IconPlus, IconRefresh } from "./icons";

import { Picker } from "./picker";
import { post } from "./vscode";

/** Magnifier drawn locally so no new icon file/dependency is needed. */
function IconSearch() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6.8" cy="6.8" r="4.6" />
      <path d="m10.2 10.2 3.5 3.5" stroke-linecap="round" />
    </svg>
  );
}
export function Header(props: {
  title: string;
  folders: { list: FolderInfo[]; active?: string };
  showSessions: boolean;
  onToggleSessions: () => void;
  onExport: () => void;
  onSync: () => void;
  onNewSession: () => void;
  syncing: boolean;
  searchOpen: boolean;
  onToggleSearch: () => void;
  onCloseSearch: () => void;
  searchFocusToken: number;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchCount: number;
  activeMatch: number;
  matchCount: number;
  onNavigateMatch: (direction: number) => void;
}) {
  const t = useT();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.searchOpen) searchRef.current?.focus();
  }, [props.searchOpen]);
  // Cmd/Ctrl+F re-focuses and selects the query even when the search was already open.
  useEffect(() => {
    if (props.searchOpen && props.searchFocusToken > 0) {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [props.searchFocusToken]);
  return (
    <header class="header">
      <button
        type="button"
        class="session-button session-toggle"
        aria-haspopup="true"
        aria-expanded={props.showSessions}
        aria-label={`${t("sessions")}: ${props.title}`}
        onClick={props.onToggleSessions}
      >
        <IconHistory />
        <span class="session-button-label">{t("sessions")}</span>
        <span class="session-current">
          <span class="session-current-dot" aria-hidden="true" />
          <span class="session-title">{props.title}</span>
        </span>
        <IconChevron class={`chevron ${props.showSessions ? "down" : ""}`} />
      </button>
      {props.folders.list.length > 1 && (
        <Picker
          label={t("folder")}
          class="folder"
          placement="bottom"
          items={props.folders.list.map((f) => ({ value: f.uri, label: f.name }))}
          value={props.folders.active}
          onChange={(uri) => post({ type: "selectFolder", uri })}
        />
      )}
      <button
        type="button"
        class="icon-button tooltip-host new-session"
        data-tooltip={t("newSession")}
        aria-label={t("newSession")}
        onClick={props.onNewSession}
      >
        <IconPlus />
      </button>
      <button
        type="button"
        class={`icon-button tooltip-host${props.syncing ? " syncing" : ""}`}
        data-tooltip={t("syncConversation")}
        aria-label={t("syncConversation")}
        aria-busy={props.syncing}
        disabled={props.syncing}
        onClick={props.onSync}
      >
        <IconRefresh />
      </button>
      <button
        type="button"
        class="icon-button tooltip-host"
        data-tooltip={t("exportConversation")}
        aria-label={t("exportConversation")}
        onClick={props.onExport}
      >
        <IconDownload />
      </button>
      <button
        type="button"
        class={`icon-button tooltip-host${props.searchOpen ? " active" : ""}`}
        data-tooltip={t("searchMessages")}
        aria-label={t("searchMessages")}
        aria-expanded={props.searchOpen}
        onClick={props.onToggleSearch}
      >
        <IconSearch />
      </button>
      {props.searchOpen && (
        <div class="header-search">
          <IconSearch />
          <input
            ref={searchRef}
            type="search"
            class="search-input"
            aria-label={t("searchMessages")}
            placeholder={t("searchMessagesPlaceholder")}
            value={props.searchQuery}
            onInput={(e) => props.onSearchChange((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                props.onCloseSearch();
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                props.onNavigateMatch(e.shiftKey ? -1 : 1);
                return;
              }
              isolateKeys(e);
            }}
          />
          <span class="search-count">
            {props.searchQuery.trim() && props.matchCount > 0
              ? `${t("searchMatchPosition", props.activeMatch + 1, props.matchCount)} · ${t("searchResults", props.searchCount)}`
              : t("searchResults", props.searchCount)}
          </span>
          <button
            type="button"
            class="icon-button"
            aria-label={t("previousMatch")}
            data-tooltip={t("previousMatch")}
            onClick={() => props.onNavigateMatch(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label={t("nextMatch")}
            data-tooltip={t("nextMatch")}
            onClick={() => props.onNavigateMatch(1)}
          >
            ↓
          </button>
          <button type="button" class="icon-button" aria-label={t("dismiss")} onClick={props.onCloseSearch}>
            <IconClose />
          </button>
        </div>
      )}
    </header>
  );
}
