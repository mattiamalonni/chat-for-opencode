import { Component, type ComponentChildren } from "preact";
import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import type { AgentInfo, CommandSuggestion, FileDiff, ModelInfo, ModelRef, ServerEvent, SkillSuggestion } from "../shared/api";
import {
  chatReducer,
  initialChatState,
  mergeChangedFiles,
  orphanForms,
  orphanPermissions,
  selectTodos,
  type TextPart,
  type ToolPart,
  type UiAssistantMessage,
  type UiMessage,
  type UiUserMessage,
} from "../shared/chatReducer";
import { SUPPORTED_SERVER_VERSION, type Compatibility } from "../shared/compatibility";
import { isNewSessionKey } from "../shared/keys";
import { contractSignature, emptyContract, type ContractReport } from "../shared/contract";
import type { Attachment, ConnectionStatus, ContextItem, FolderInfo, HostMessage, SessionSummary, UiError } from "../shared/protocol";
import { STRINGS, type Strings } from "../shared/strings";
import { Composer } from "./composer";
import { collectDroppedFiles, hasFiles, readFileAsBase64, type DragData } from "./dropFiles";
import { env, isolateKeys } from "./env";
import { StringsContext, useT } from "./i18n";
import { IconCheck, IconChevron, IconClose, IconDiff, IconEdit, IconError, IconHistory, IconPlus, IconRefresh, IconTrash, IconWarning } from "./icons";
import { setCopyLabel } from "./markdown";
import { Picker } from "./picker";
import { clearReplyFailures, markReplyFailed } from "./replyFeedback";
import { ActionButton, AssistantStatus, FileList, FormCard, MessageView, PermissionCard, ToolCard, ToolGroup } from "./messages";
import { onHostMessage, post } from "./vscode";

interface Catalog {
  models: ModelInfo[];
  agents: AgentInfo[];
  skills: SkillSuggestion[];
  commands: CommandSuggestion[];
  selectedModel?: ModelRef;
  selectedAgent?: string;
}

export function App() {
  const [strings, setStrings] = useState<Strings>({ ...STRINGS });
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const [status, setStatus] = useState<{ status: ConnectionStatus; error?: UiError }>({ status: "idle" });
  const [compatibility, setCompatibility] = useState<{ status: Compatibility; version?: string; dismissed: boolean }>({
    status: "unknown",
    dismissed: false,
  });
  const [contract, setContract] = useState<{ report: ContractReport; dismissed: boolean }>({ report: emptyContract, dismissed: false });
  const [issuesUrl, setIssuesUrl] = useState<string | undefined>();
  const [catalog, setCatalog] = useState<Catalog>({ models: [], agents: [], skills: [], commands: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [folders, setFolders] = useState<{ list: FolderInfo[]; active?: string }>({ list: [] });
  const [context, setContext] = useState<ContextItem[]>([]);
  // Explicit user choices per context chip: the active file is opt-in, selections are opt-out.
  const [contextChoice, setContextChoice] = useState<Map<string, boolean>>(new Map());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileResults, setFileResults] = useState<{ query: string; items: Attachment[] }>({ query: "", items: [] });
  const [changes, setChanges] = useState<FileDiff[]>([]);
  const [dismissedChanges, setDismissedChanges] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [notice, setNotice] = useState<UiError | undefined>();
  const [focusToken, setFocusToken] = useState(0);
  const [scrollToken, setScrollToken] = useState(0);
  const [showSessions, setShowSessions] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const queue = useRef<ServerEvent[]>([]);
  const frame = useRef<number | undefined>(undefined);
  // Conversation-scoped state must be dropped when the loaded session changes (new session,
  // folder switch, switching/deleting a session) but not on a same-session resync.
  const lastSessionId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const flush = () => {
      frame.current = undefined;
      const events = queue.current;
      queue.current = [];
      if (events.length > 0) dispatch({ type: "events", events });
    };
    const off = onHostMessage((msg: HostMessage) => {
      switch (msg.type) {
        case "init":
          setStrings({ ...STRINGS, ...msg.strings });
          setCopyLabel(msg.strings.copy);
          env.platform = msg.platform;
          setFolders({ list: msg.folders, active: msg.activeFolder });
          setIssuesUrl(msg.issuesUrl);
          break;
        case "connection":
          setStatus({ status: msg.status, error: msg.error });
          setCompatibility({ status: msg.compatibility ?? "unknown", version: msg.version, dismissed: !!msg.compatibilityDismissed });
          setContract({ report: msg.contract ?? emptyContract, dismissed: !!msg.contractDismissed });
          break;
        case "catalog":
          setCatalog({ models: msg.models, agents: msg.agents, skills: msg.skills, commands: msg.commands ?? [], selectedModel: msg.selectedModel, selectedAgent: msg.selectedAgent });
          break;
        case "sessions":
          setSessions(msg.items);
          setSessionsHasMore(!!msg.hasMore);
          break;
        case "session": {
          queue.current = [];
          const id = msg.session?.id ?? null;
          if (lastSessionId.current !== id) {
            lastSessionId.current = id;
            setAttachments([]);
            setChanges([]);
            setDismissedChanges(null);
            setNotice(undefined);
            clearReplyFailures();
            // Context chips belong to the editor, not the chat: keep the user's explicit
            // opt-in/opt-out across session switches (stale ids are pruned on the next `context`).
          }
          dispatch({
            type: "load",
            sessionId: msg.session?.id ?? null,
            title: msg.session?.title,
            agent: msg.session?.agent,
            model: msg.session?.model,
            busy: msg.session?.busy,
            messages: msg.session?.messages ?? [],
            permissions: msg.session?.permissions ?? [],
            forms: msg.session?.forms ?? [],
            usage: msg.session?.usage,
          });
          setShowSessions(false);
          break;
        }
        case "event":
          queue.current.push(msg.event);
          frame.current ??= requestAnimationFrame(flush);
          break;
        case "context":
          setContext(msg.items);
          setContextChoice((prev) => {
            if (prev.size === 0) return prev;
            const ids = new Set(msg.items.map((c) => c.id));
            const next = new Map([...prev].filter(([id]) => ids.has(id)));
            return next.size === prev.size ? prev : next;
          });
          break;
        case "fileResults":
          setFileResults({ query: msg.query, items: msg.items });
          break;
        case "addAttachment":
          setAttachments((prev) => (prev.some((a) => a.uri === msg.item.uri) ? prev : [...prev, msg.item]));
          setFocusToken((n) => n + 1);
          break;
        case "changedFiles":
          setChanges(msg.files);
          break;
        case "autoApprove":
          setAutoApprove(msg.enabled);
          break;
        case "focusInput":
          setFocusToken((n) => n + 1);
          break;
        case "notice":
          if (msg.error.target) markReplyFailed(msg.error.target);
          setNotice(msg.error);
          break;
      }
    });
    post({ type: "ready" });
    return () => {
      off();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, []);

  // The session list is an overlay, so a click anywhere else dismisses it. The header trigger is
  // excluded: its own handler toggles the list, and closing it here first would swallow that click.
  useEffect(() => {
    if (!showSessions) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".session-list") || target?.closest(".session-toggle")) return;
      setShowSessions(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showSessions]);

  // Tooltips are absolutely positioned pseudo-elements: even hidden, a long one anchored on the
  // wrong side extends past the viewport and creates a horizontal scrollbar with empty space on
  // the right. Grow each one towards whichever side has room for its (wrapped) width.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const vw = window.innerWidth;
      const updates: { el: HTMLElement; dir: "left" | "right" }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(".tooltip-host")) {
        const tip = getComputedStyle(el, "::after");
        if (tip.content === "none" || tip.display === "none") continue;
        const width = parseFloat(tip.width) || 0;
        const rect = el.getBoundingClientRect();
        updates.push({ el, dir: vw - rect.right >= width + 8 ? "right" : "left" });
      }
      for (const { el, dir } of updates) el.dataset.tipDir = dir;
    });
    return () => cancelAnimationFrame(id);
  });

  // Cmd/Ctrl+N creates a new session while the chat has focus. The VS Code webview preload
  // forwards every keydown that reaches `window` to the workbench (see D7), where this chord
  // means "new file". Capture it before that bubble-phase listener so the workbench never sees it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isNewSessionKey(e, env.platform) || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      post({ type: "newSession" });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Announce completion / attention for screen readers.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !chat.busy) setAnnouncement(strings.responseComplete);
    wasBusy.current = chat.busy;
  }, [chat.busy]);
  useEffect(() => {
    if (chat.permissions.length > 0) setAnnouncement(strings.permissionTitle);
  }, [chat.permissions.length]);
  useEffect(() => {
    if (chat.forms.length > 0) setAnnouncement(strings.questionTitle);
  }, [chat.forms.length]);

  const todos = useMemo(() => selectTodos(chat), [chat.messages]);
  // GET /session/{id}/diff is empty outside git repos, so fall back to patches in tool metadata.
  const changedFiles = useMemo(() => mergeChangedFiles(changes, chat), [changes, chat.messages, chat.touchedFiles]);
  // "Mark as reviewed" hides the panel until the set of changed files actually changes again.
  const changesSignature = useMemo(
    () => JSON.stringify(changedFiles.map((f) => [f.file, f.status, f.additions, f.deletions, f.patch])),
    [changedFiles],
  );
  const changesDismissed = dismissedChanges !== null && dismissedChanges === changesSignature;
  // Prompts already sent in this session, oldest first, for the composer's Up/Down history.
  const promptHistory = useMemo(
    () => chat.messages.filter((m): m is UiUserMessage => m.kind === "user").map((m) => m.text),
    [chat.messages],
  );
  // The active file is opt-in; selections stay attached until the user removes them.
  const selectedContext = useMemo(
    () => new Set(context.filter((c) => contextChoice.get(c.id) ?? c.kind === "selection").map((c) => c.id)),
    [context, contextChoice],
  );
  const send = (text: string) => {
    const ctx = context.filter((c) => selectedContext.has(c.id));
    const skillCommand = /(^|\s)\/(\S+)(?=\s|$)/.exec(text);
    const isCommand = skillCommand && catalog.commands.some((item) => item.name === skillCommand[2]);
    const skill = !isCommand && skillCommand && catalog.skills.find((item) => item.id === skillCommand[2]);
    const prompt = skillCommand && skill
      ? `${text.slice(0, skillCommand.index)}${skillCommand[1]}@${skill.id}${text.slice(skillCommand.index + skillCommand[0].length)}`
      : text;
    post({ type: "send", text: prompt, attachments, context: ctx });
    setAttachments([]);
    setNotice(undefined);
    // Follow the new prompt even if the user had scrolled up to read older messages.
    setScrollToken((n) => n + 1);
  };

  // VS Code delivers file drops to a webview only while Shift is held (otherwise it opens the file
  // in an editor). Listen on window, not just the app element, so events targeting any child are
  // still seen. Dropped files become attachments, exactly like @-mentions.
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer as DragData | null)) return;
      e.preventDefault();
      dragDepth.current++;
      setDropping(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer as DragData | null)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = () => {
      if (dragDepth.current === 0) return;
      dragDepth.current--;
      if (dragDepth.current === 0) setDropping(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer as DragData | null)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDropping(false);
      const files = await collectDroppedFiles(e.dataTransfer as DragData, readFileAsBase64);
      if (files.length > 0) post({ type: "dropFiles", files });
    };
    const onDragEnd = () => {
      dragDepth.current = 0;
      setDropping(false);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  const connected = status.status === "connected" || status.status === "reconnecting";
  const title = chat.title || sessions.find((s) => s.id === chat.sessionId)?.title || strings.untitled;

  return (
    <StringsContext.Provider value={strings}>
      <WebviewErrorBoundary>
        <div class="app">
        <Header
          title={chat.sessionId ? title : strings.untitled}
          folders={folders}
          showSessions={showSessions}
          onToggleSessions={() => {
            if (!showSessions) post({ type: "refreshSessions" });
            setShowSessions(!showSessions);
          }}
        />
        {showSessions && (
          <SessionList
            sessions={sessions}
            currentId={chat.sessionId}
            hasMore={sessionsHasMore}
            onLoadMore={() => post({ type: "loadMoreSessions" })}
            onClose={() => setShowSessions(false)}
          />
        )}
        <StatusBanner status={status.status} error={status.error} />
        {(compatibility.status === "untested" || compatibility.status === "unsupported") && !compatibility.dismissed && (
          <CompatibilityBanner
            key={`${compatibility.status}:${compatibility.version ?? "?"}`}
            status={compatibility.status}
            version={compatibility.version}
            issuesUrl={issuesUrl}
          />
        )}
        {contract.report.failures.length > 0 && !contract.dismissed && (
          <ContractBanner failures={contract.report.failures} issuesUrl={issuesUrl} />
        )}
        {notice && <NoticeBanner error={notice} onDismiss={() => setNotice(undefined)} />}
        <Conversation chat={chat} scrollToken={scrollToken} />
        <div class="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
        {todos && todos.length > 0 && <TodoPanel todos={todos} />}
        {changedFiles.length > 0 && !changesDismissed && (
          <ChangesPanel files={changedFiles} onDismiss={() => setDismissedChanges(changesSignature)} />
        )}
        <Composer
          busy={chat.busy}
          contextTokens={chat.contextTokens}
          disabled={!connected}
          models={catalog.models}
          agents={catalog.agents}
          skills={catalog.skills}
          commands={catalog.commands}
          selectedModel={catalog.selectedModel}
          selectedAgent={catalog.selectedAgent}
          autoApprove={autoApprove}
          cost={chat.usage?.cost}
          onToggleAutoApprove={(enabled) => post({ type: "setAutoApprove", enabled })}
          context={context}
          selectedContext={selectedContext}
          onToggleContext={(id) =>
            setContextChoice((prev) => {
              const next = new Map(prev);
              const item = context.find((c) => c.id === id);
              next.set(id, !(prev.get(id) ?? item?.kind === "selection"));
              return next;
            })
          }
          attachments={attachments}
          onRemoveAttachment={(uri) => setAttachments((prev) => prev.filter((a) => a.uri !== uri))}
          onAddAttachment={(a) => setAttachments((prev) => (prev.some((x) => x.uri === a.uri) ? prev : [...prev, a]))}
          fileResults={fileResults}
          onSend={send}
          promptHistory={promptHistory}
          focusToken={focusToken}
          canCompact={!!chat.sessionId && !chat.busy && connected}
        />
        {dropping && (
          <div class="drop-overlay" aria-hidden="true">
            <div class="drop-overlay-inner">{strings.dropFilesOverlay}</div>
          </div>
        )}
        </div>
      </WebviewErrorBoundary>
    </StringsContext.Provider>
  );
}

/**
 * Catches rendering errors so a single bad message cannot leave the webview blank. The host can
 * resync history, but it cannot recover a webview whose script has thrown, hence the reload action.
 */
class WebviewErrorBoundary extends Component<{ children: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[chat] webview render failed", error);
  }

  render() {
    return this.state.failed ? <CrashFallback /> : this.props.children;
  }
}

function CrashFallback() {
  const t = useT();
  return (
    <div class="app">
      <div class="banner error" role="alert">
        <div class="banner-main">
          <IconError />
          <strong>{t("crashTitle")}</strong>
        </div>
        <p class="banner-text">{t("crashBody")}</p>
        <div class="banner-actions">
          <button type="button" class="primary" onClick={() => window.location.reload()}>
            {t("reloadChat")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Header(props: { title: string; folders: { list: FolderInfo[]; active?: string }; showSessions: boolean; onToggleSessions: () => void }) {
  const t = useT();
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
      <button type="button" class="icon-button tooltip-host tooltip-above" data-tooltip={t("newSession")} aria-label={t("newSession")} onClick={() => post({ type: "newSession" })}>
        <IconPlus />
      </button>
    </header>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: "auto" });
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

function SessionList(props: {
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (ref.current?.querySelector("button.session-item") as HTMLButtonElement | null)?.focus();
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
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (renaming || confirm) closeInline();
        else props.onClose();
      }}
    >
      <button type="button" class="session-new" onClick={() => post({ type: "newSession" })}>
        <IconPlus /> {t("newSession")}
      </button>
      {props.sessions.length === 0 && <div class="empty">{t("noSessions")}</div>}
      <ul>
        {props.sessions.map((s) => (
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
                    <span class="inline-session" title={s.title || t("untitled")}>{s.title || t("untitled")}</span>
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
                <button type="button" class="session-item" aria-current={s.id === props.currentId} onClick={() => post({ type: "selectSession", id: s.id })}>
                  {(s.busy || s.needsInput) && (
                    <span class={`status-dot session-busy ${s.needsInput ? "waiting" : "running"}`} aria-hidden="true" />
                  )}
                  <span class="session-name">{s.title || t("untitled")}</span>
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

function StatusBanner({ status, error }: { status: ConnectionStatus; error?: UiError }) {
  const t = useT();
  if (status === "connected" || status === "idle") return null;
  if (status === "starting") {
    return (
      <div class="banner info" role="status">
        <span class="spinner" aria-hidden="true" /> {t("connecting")}
      </div>
    );
  }
  if (status === "reconnecting") {
    return (
      <div class="banner warning" role="status">
        <span class="spinner" aria-hidden="true" /> {error?.message ?? t("reconnecting")}
        <span class="banner-actions">
          <ActionButton id="reconnect" />
        </span>
      </div>
    );
  }
  return error ? <ErrorBlock error={error} /> : null;
}

function ErrorBlock({ error, onDismiss }: { error: UiError; onDismiss?: () => void }) {
  const t = useT();
  return (
    <div class="banner error" role="alert">
      <div class="banner-main">
        <IconError />
        <strong>{error.message}</strong>
        {onDismiss && (
          <button type="button" class="icon-button dismiss tooltip-host" data-tooltip={t("dismiss")} aria-label={t("dismiss")} onClick={onDismiss}>
            <IconClose />
          </button>
        )}
      </div>
      {error.detail && (
        <details class="banner-detail">
          <summary>{t("details")}</summary>
          <pre>{error.detail}</pre>
        </details>
      )}
      <div class="banner-actions">
        {error.actions.map((a) => (
          <ActionButton key={a} id={a} />
        ))}
      </div>
    </div>
  );
}

/** Warns when the server version differs from the one this extension was verified against. */
function CompatibilityBanner(props: { status: "untested" | "unsupported"; version?: string; issuesUrl?: string }) {
  const { status, version, issuesUrl } = props;
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const unsupported = status === "unsupported";
  return (
    <div class={`banner ${unsupported ? "error" : "warning"}`} role={unsupported ? "alert" : "status"}>
      <div class="banner-main">
        <IconWarning />
        <strong>
          {unsupported
            ? t("unsupportedVersion", version ?? "?", SUPPORTED_SERVER_VERSION)
            : t("untestedVersion", version ?? "?", SUPPORTED_SERVER_VERSION)}
        </strong>
        <button type="button" class="icon-button dismiss tooltip-host" data-tooltip={t("dismiss")} aria-label={t("dismiss")} onClick={() => {
            setDismissed(true);
            // Remembered by the host so the banner stays hidden for this version across reloads.
            if (version) post({ type: "dismissCompatibility", version });
          }}>
          <IconClose />
        </button>
      </div>
      {issuesUrl && (
        <div class="banner-actions">
          <button type="button" class="link-button" onClick={() => post({ type: "openLink", href: issuesUrl })}>
            {t("reportIssue")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Names the capabilities whose response shape does not match the verified 2.2.7 contract. */
function ContractBanner({ failures, issuesUrl }: { failures: ContractReport["failures"]; issuesUrl?: string }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div class="banner warning" role="status">
      <div class="banner-main">
        <IconWarning />
        <strong>{t("contractTitle")}</strong>
        <button
          type="button"
          class="icon-button dismiss tooltip-host"
          data-tooltip={t("dismiss")}
          aria-label={t("dismiss")}
          onClick={() => {
            setDismissed(true);
            post({ type: "dismissContract", signature: contractSignature({ checked: failures.length, failures }) });
          }}
        >
          <IconClose />
        </button>
      </div>
      <ul class="contract-failures">
        {failures.map((f) => (
          <li key={f.id}>
            <span>{t(`contract.${f.id}` as Parameters<typeof t>[0])}</span>
            <small>{f.detail}</small>
          </li>
        ))}
      </ul>
      {issuesUrl && (
        <div class="banner-actions">
          <button type="button" class="link-button" onClick={() => post({ type: "openLink", href: issuesUrl })}>
            {t("reportIssue")}
          </button>
        </div>
      )}
    </div>
  );
}

function NoticeBanner({ error, onDismiss }: { error: UiError; onDismiss: () => void }) {
  return <ErrorBlock error={error} onDismiss={onDismiss} />;
}

type ConversationItem =
  | { kind: "message"; message: UiMessage }
  | { kind: "assistant"; key: string; message: UiAssistantMessage; parts: TextPart[]; grouped: boolean }
  | { kind: "tool"; key: string; part: ToolPart }
  | { kind: "tools"; key: string; parts: ToolPart[] }
  | { kind: "status"; key: string; message: UiAssistantMessage; typing: boolean };

/**
 * Renders a turn in the order the model produced it: narration and thoughts stay where they
 * happened, and only adjacent tool calls collapse into one accordion. OpenCode emits one
 * assistant message per step, so the flattening has to span messages to keep that order.
 */
function conversationItems(messages: UiMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let turn: UiAssistantMessage[] = [];

  const flushTurn = () => {
    if (turn.length === 0) return;
    let tools: ToolPart[] = [];
    let started = false;

    const flushTools = () => {
      if (tools.length === 0) return;
      if (tools.length === 1) items.push({ kind: "tool", key: tools[0].key, part: tools[0] });
      else items.push({ kind: "tools", key: `tools:${tools[0].key}`, parts: tools });
      tools = [];
      started = true;
    };

    for (const m of turn) {
      let texts: TextPart[] = [];
      const flushTexts = () => {
        if (texts.length === 0) return;
        items.push({ kind: "assistant", key: `${m.id}:${texts[0].key}`, message: m, parts: texts, grouped: started });
        texts = [];
        started = true;
      };
      for (const p of m.parts) {
        if (p.kind === "tool") {
          flushTexts();
          tools.push(p);
        } else {
          flushTools();
          texts.push(p);
        }
      }
      flushTexts();
    }
    flushTools();

    // Retry/error feedback belongs to the turn, after whatever content it managed to produce.
    for (const m of turn) {
      if (m.retry || m.error) items.push({ kind: "status", key: `status:${m.id}`, message: m, typing: false });
    }
    const last = turn.at(-1);
    if (last && !last.done && last.parts.length === 0) {
      items.push({ kind: "status", key: `typing:${last.id}`, message: last, typing: true });
    }
    turn = [];
  };

  for (const m of messages) {
    if (m.kind === "assistant") {
      turn.push(m);
      continue;
    }
    flushTurn();
    items.push({ kind: "message", message: m });
  }
  flushTurn();
  return items;
}

function Conversation({ chat, scrollToken }: { chat: ReturnType<typeof chatReducer>; scrollToken: number }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastId = useRef<string | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToEnd = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAtBottom(true);
  };

  // A new prompt always brings the conversation back to the latest message, even if the user had
  // scrolled up. Without this, the reply streams in off-screen and the chat appears frozen.
  useEffect(() => {
    const last = chat.messages.at(-1);
    if (last && last.id !== lastId.current && last.kind === "user") scrollToEnd();
    lastId.current = last?.id;
  }, [chat.messages]);

  useEffect(() => {
    lastId.current = undefined;
    scrollToEnd();
  }, [chat.sessionId]);

  useEffect(() => {
    scrollToEnd();
  }, [scrollToken]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const orphanP = orphanPermissions(chat);
  const orphanF = orphanForms(chat);
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const copy = target.closest("[data-action='copy-code']");
    if (copy) {
      const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
      post({ type: "copy", text: code });
      copy.textContent = t("copied");
      setTimeout(() => (copy.textContent = t("copy")), 1200);
      return;
    }
    // File references linkified in prose carry a data-file attribute; host `openFile`
    // resolves the path against the folder and places the cursor at the right line.
    const fileLink = target.closest<HTMLElement>("[data-file]");
    if (fileLink) {
      e.preventDefault();
      post({ type: "openFile", path: fileLink.dataset.file ?? "" });
      return;
    }
    const link = target.closest("a[href]");
    if (link) {
      e.preventDefault();
      post({ type: "openLink", href: link.getAttribute("href") ?? "" });
    }
  };
  return (
    <div class="conversation-wrap">
      <div
        class="conversation"
        ref={ref}
        role="log"
        aria-label={t("appName")}
        aria-busy={chat.busy}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = bottom;
          setAtBottom((prev) => (prev === bottom ? prev : bottom));
        }}
        onClick={onClick}
      >
      {chat.messages.length === 0 && (
        <div class="welcome">
          <h2>{t("welcomeTitle")}</h2>
          <p>{t("welcomeBody")}</p>
        </div>
      )}
      {conversationItems(chat.messages).map((item) => {
        switch (item.kind) {
          case "tools":
            return <ToolGroup key={item.key} parts={item.parts} state={chat} />;
          case "tool":
            return <ToolCard key={item.key} part={item.part} state={chat} />;
          case "assistant":
            return (
              <MessageView
                key={item.key}
                message={{ ...item.message, parts: item.parts }}
                state={chat}
                grouped={item.grouped}
                showStatus={false}
              />
            );
          case "status":
            return <AssistantStatus key={item.key} message={item.message} typing={item.typing} />;
          case "message":
            return <MessageView key={item.message.id} message={item.message} state={chat} grouped={false} />;
        }
      })}
      {orphanP.map((p) => <PermissionCard key={p.id} request={p} />)}
      {orphanF.map((f) => <FormCard key={f.id} form={f} />)}
      {chat.busy && chat.messages.at(-1)?.kind !== "assistant" && (
        <div class="typing" aria-label={t("thinking")}>
          <span />
          <span />
          <span />
        </div>
      )}
      {chat.retry && (
        <div class="notice warning" role="status">
          <IconWarning />
          {t("retrying", chat.retry.attempt, chat.retry.message)}
        </div>
      )}
      </div>
      {!atBottom && chat.messages.length > 0 && (
        <button type="button" class="jump-latest" onClick={scrollToEnd}>
          <IconChevron />
          {t("jumpToLatest")}
        </button>
      )}
    </div>
  );
}

function TodoPanel({ todos }: { todos: { content: string; status: string }[] }) {
  const t = useT();
  const done = todos.filter((x) => x.status === "completed").length;
  return (
    <details class="panel todos" open>
      <summary>
        <IconChevron class="chevron" />
        {t("todos")} ({done}/{todos.length})
      </summary>
      <ul>
        {todos.map((todo, i) => (
          <li key={i} class={`todo ${todo.status}`}>
            <span class="todo-box" aria-hidden="true">
              {todo.status === "completed" ? <IconCheck /> : todo.status === "in_progress" ? "◐" : ""}
            </span>
            <span class="sr-only">{todo.status}</span>
            <span>{todo.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ChangesPanel({ files, onDismiss }: { files: FileDiff[]; onDismiss: () => void }) {
  const t = useT();
  return (
    <details class="panel changes">
      <summary>
        <IconChevron class="chevron" />
        <IconDiff /> {t("changedFiles")} ({files.length})
        <button
          type="button"
          class="icon-button tooltip-host refresh-changes"
          data-tooltip={t("refresh")}
          aria-label={t("refresh")}
          onClick={(e) => {
            e.preventDefault();
            post({ type: "refreshChanges" });
          }}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          class="icon-button tooltip-host dismiss-changes"
          data-tooltip={t("dismissChanges")}
          aria-label={t("dismissChanges")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }}
        >
          <IconCheck />
        </button>
      </summary>
      <FileList files={files} applied />
    </details>
  );
}
