import { useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import type { AgentInfo, FileDiff, ModelInfo, ModelRef, ServerEvent } from "../shared/api";
import { chatReducer, initialChatState, orphanForms, orphanPermissions, selectTodos } from "../shared/chatReducer";
import { SUPPORTED_SERVER_VERSION, type Compatibility } from "../shared/compatibility";
import type { Attachment, ConnectionStatus, ContextItem, FolderInfo, HostMessage, SessionSummary, UiError } from "../shared/protocol";
import { STRINGS, type Strings } from "../shared/strings";
import { Composer } from "./composer";
import { env } from "./env";
import { StringsContext, useT } from "./i18n";
import { IconCheck, IconChevron, IconClose, IconDiff, IconError, IconHistory, IconPlus, IconRefresh, IconTrash, IconWarning } from "./icons";
import { setCopyLabel } from "./markdown";
import { Picker } from "./picker";
import { ActionButton, FileList, FormCard, MessageView, PermissionCard } from "./messages";
import { onHostMessage, post } from "./vscode";

interface Catalog {
  models: ModelInfo[];
  agents: AgentInfo[];
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
  const [issuesUrl, setIssuesUrl] = useState<string | undefined>();
  const [catalog, setCatalog] = useState<Catalog>({ models: [], agents: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [folders, setFolders] = useState<{ list: FolderInfo[]; active?: string }>({ list: [] });
  const [context, setContext] = useState<ContextItem[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileResults, setFileResults] = useState<{ query: string; items: Attachment[] }>({ query: "", items: [] });
  const [changes, setChanges] = useState<FileDiff[]>([]);
  const [notice, setNotice] = useState<UiError | undefined>();
  const [focusToken, setFocusToken] = useState(0);
  const [showSessions, setShowSessions] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const queue = useRef<ServerEvent[]>([]);
  const frame = useRef<number | undefined>(undefined);

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
          break;
        case "catalog":
          setCatalog({ models: msg.models, agents: msg.agents, selectedModel: msg.selectedModel, selectedAgent: msg.selectedAgent });
          break;
        case "sessions":
          setSessions(msg.items);
          break;
        case "session":
          queue.current = [];
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
          });
          setShowSessions(false);
          break;
        case "event":
          queue.current.push(msg.event);
          frame.current ??= requestAnimationFrame(flush);
          break;
        case "context":
          setContext(msg.items);
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
        case "focusInput":
          setFocusToken((n) => n + 1);
          break;
        case "notice":
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

  // Re-show context chips the user removed once the context itself changes.
  useEffect(() => {
    setExcluded((prev) => new Set([...prev].filter((id) => context.some((c) => c.id === id))));
  }, [context]);

  const todos = useMemo(() => selectTodos(chat), [chat.messages]);
  const send = (text: string) => {
    const ctx = context.filter((c) => !excluded.has(c.id));
    post({ type: "send", text, attachments, context: ctx });
    setAttachments([]);
    setNotice(undefined);
  };

  const connected = status.status === "connected" || status.status === "reconnecting";
  const title = chat.title || sessions.find((s) => s.id === chat.sessionId)?.title || strings.untitled;

  return (
    <StringsContext.Provider value={strings}>
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
        {showSessions && <SessionList sessions={sessions} currentId={chat.sessionId} onClose={() => setShowSessions(false)} />}
        <StatusBanner status={status.status} error={status.error} />
        {(compatibility.status === "untested" || compatibility.status === "unsupported") && !compatibility.dismissed && (
          <CompatibilityBanner
            key={`${compatibility.status}:${compatibility.version ?? "?"}`}
            status={compatibility.status}
            version={compatibility.version}
            issuesUrl={issuesUrl}
          />
        )}
        {notice && <NoticeBanner error={notice} onDismiss={() => setNotice(undefined)} />}
        <Conversation chat={chat} />
        <div class="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
        {todos && todos.length > 0 && <TodoPanel todos={todos} />}
        {changes.length > 0 && <ChangesPanel files={changes} />}
        <Composer
          busy={chat.busy}
          contextTokens={chat.contextTokens}
          disabled={!connected}
          models={catalog.models}
          agents={catalog.agents}
          selectedModel={catalog.selectedModel}
          selectedAgent={catalog.selectedAgent}
          context={context}
          excluded={excluded}
          onExclude={(id) => setExcluded((prev) => new Set([...prev, id]))}
          attachments={attachments}
          onRemoveAttachment={(uri) => setAttachments((prev) => prev.filter((a) => a.uri !== uri))}
          onAddAttachment={(a) => setAttachments((prev) => (prev.some((x) => x.uri === a.uri) ? prev : [...prev, a]))}
          fileResults={fileResults}
          onSend={send}
          focusToken={focusToken}
        />
      </div>
    </StringsContext.Provider>
  );
}

function Header(props: { title: string; folders: { list: FolderInfo[]; active?: string }; showSessions: boolean; onToggleSessions: () => void }) {
  const t = useT();
  return (
    <header class="header">
      <button
        type="button"
        class="session-button"
        aria-haspopup="true"
        aria-expanded={props.showSessions}
        aria-label={`${t("sessions")}: ${props.title}`}
        onClick={props.onToggleSessions}
      >
        <IconHistory />
        <span class="session-title">{props.title}</span>
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
      <button type="button" class="icon-button" title={t("newSession")} aria-label={t("newSession")} onClick={() => post({ type: "newSession" })}>
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

function SessionList(props: { sessions: SessionSummary[]; currentId: string | null; onClose: () => void }) {
  const t = useT();
  const [confirm, setConfirm] = useState<string | undefined>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (ref.current?.querySelector("button.session-item") as HTMLButtonElement | null)?.focus();
  }, []);
  return (
    <div
      class="session-list"
      ref={ref}
      role="dialog"
      aria-label={t("sessions")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <button type="button" class="session-new" onClick={() => post({ type: "newSession" })}>
        <IconPlus /> {t("newSession")}
      </button>
      {props.sessions.length === 0 && <div class="empty">{t("noSessions")}</div>}
      <ul>
        {props.sessions.map((s) => (
          <li key={s.id} class={s.id === props.currentId ? "current" : ""}>
            {confirm === s.id ? (
              <div class="confirm" role="group" aria-label={t("confirmDelete")}>
                <span>{t("confirmDelete")}</span>
                <button type="button" class="primary danger" onClick={() => post({ type: "deleteSession", id: s.id })}>
                  {t("deleteSession")}
                </button>
                <button type="button" class="secondary" onClick={() => setConfirm(undefined)}>
                  {t("cancel")}
                </button>
              </div>
            ) : (
              <>
                <button type="button" class="session-item" aria-current={s.id === props.currentId} onClick={() => post({ type: "selectSession", id: s.id })}>
                  <span class="session-name">{s.title || t("untitled")}</span>
                  <span class="session-time">{s.busy ? t("running") : relativeTime(s.updated)}</span>
                </button>
                <button type="button" class="icon-button" title={t("deleteSession")} aria-label={`${t("deleteSession")}: ${s.title || t("untitled")}`} onClick={() => setConfirm(s.id)}>
                  <IconTrash />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
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
          <button type="button" class="icon-button dismiss" aria-label={t("dismiss")} onClick={onDismiss}>
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
        <button type="button" class="icon-button dismiss" aria-label={t("dismiss")} onClick={() => {
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

function NoticeBanner({ error, onDismiss }: { error: UiError; onDismiss: () => void }) {
  return <ErrorBlock error={error} onDismiss={onDismiss} />;
}

function Conversation({ chat }: { chat: ReturnType<typeof chatReducer> }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
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
    const link = target.closest("a[href]");
    if (link) {
      e.preventDefault();
      post({ type: "openLink", href: link.getAttribute("href") ?? "" });
    }
  };
  return (
    <div
      class="conversation"
      ref={ref}
      role="log"
      aria-label={t("appName")}
      aria-busy={chat.busy}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      onClick={onClick}
    >
      {chat.messages.length === 0 && (
        <div class="welcome">
          <h2>{t("welcomeTitle")}</h2>
          <p>{t("welcomeBody")}</p>
        </div>
      )}
      {chat.messages.map((m, i) => (
        <MessageView key={m.id} message={m} state={chat} grouped={i > 0 && m.kind === "assistant" && chat.messages[i - 1].kind === "assistant"} />
      ))}
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

function ChangesPanel({ files }: { files: FileDiff[] }) {
  const t = useT();
  return (
    <details class="panel changes">
      <summary>
        <IconChevron class="chevron" />
        <IconDiff /> {t("changedFiles")} ({files.length})
        <button
          type="button"
          class="icon-button"
          title={t("refresh")}
          aria-label={t("refresh")}
          onClick={(e) => {
            e.preventDefault();
            post({ type: "refreshChanges" });
          }}
        >
          <IconRefresh />
        </button>
      </summary>
      <FileList files={files} applied />
    </details>
  );
}
