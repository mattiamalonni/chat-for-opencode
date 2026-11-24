import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import type { AgentInfo, CommandSuggestion, FileDiff, InboxItem, ModelInfo, ModelRef, ServerEvent, SkillSuggestion } from "../shared/api";
import { chatReducer, initialChatState, mergeChangedFiles, selectTodos, type UiUserMessage } from "../shared/chatReducer";
import { type Compatibility } from "../shared/compatibility";
import { estimateDataUrlTokens } from "../shared/format";
import { isFindKey, isNewSessionKey, isOpenModelsKey, isOpenSessionsKey, isSyncKey } from "../shared/keys";
import { emptyContract, type ContractReport } from "../shared/contract";
import type {
  Attachment,
  ConnectionStatus,
  ContextItem,
  FolderInfo,
  HostMessage,
  PromptDefinition,
  SessionSummary,
  UiError,
} from "../shared/protocol";
import { initialSubagentState, pushSubagentSession, subagentReducer, truncateSubagentStack, type SubagentEvent } from "../shared/subagents";
import { STRINGS, type Strings } from "../shared/strings";
import { AttentionOverlay } from "./attentionOverlay";
import { Composer } from "./composer";
import { collectDroppedFiles, hasFiles, readFileAsBase64, type DragData } from "./dropFiles";
import { env } from "./env";
import { StringsContext } from "./i18n";

import { setApplyLabel, setCopyLabel } from "./markdown";

import { clearReplyFailures, markReplyFailed } from "./replyFeedback";
import { SubagentNavContext, SubagentsContext, type SubagentEntry } from "./subagents";
import { messageSearchText } from "./messages";
import { hydrateDrafts, onHostMessage, post, setDraft } from "./vscode";

/** Bounded queue: a hidden webview gets no requestAnimationFrame, so SSE events cannot drain. */
const MAX_QUEUED_EVENTS = 500;
import { StatusBanner, CompatibilityBanner, ContractBanner, NoticeBanner } from "./banners";
import { Conversation } from "./conversation";
import { WebviewErrorBoundary } from "./errorBoundary";
import { conversationMarkdown, downloadFile } from "./exportConversation";
import { Header } from "./header";
import { InboxPanel, ChangesPanel, TodoPanel } from "./panels";
import { SessionList } from "./sessionList";
import { SubagentModal } from "./subagentModal";
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
  const [subagents, subagentDispatch] = useReducer(subagentReducer, initialSubagentState);
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
  const [prompts, setPrompts] = useState<PromptDefinition[]>([]);
  // Explicit user choices per context chip: the active file is opt-in, selections are opt-out.
  const [contextChoice, setContextChoice] = useState<Map<string, boolean>>(new Map());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileResults, setFileResults] = useState<{ query: string; items: Attachment[] }>({ query: "", items: [] });
  const [changes, setChanges] = useState<FileDiff[]>([]);
  const [dismissedChanges, setDismissedChanges] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [notice, setNotice] = useState<UiError | undefined>();
  const [focusToken, setFocusToken] = useState(0);
  const [modelPickerToken, setModelPickerToken] = useState(0);
  const [draftToken, setDraftToken] = useState(0);
  /** Prompt returned by a rollback; a new token forces the composer to adopt it even if it has text. */
  const [restoredDraft, setRestoredDraft] = useState<{ text: string; token: number } | undefined>();
  const [scrollToken, setScrollToken] = useState(0);
  const [revealMessageId, setRevealMessageId] = useState<string | undefined>(undefined);
  const [showSessions, setShowSessions] = useState(false);
  // The capture-phase shortcut listener is installed once; reach the latest toggle through a ref.
  const showSessionsRef = useRef(showSessions);
  showSessionsRef.current = showSessions;
  const focusComposer = () => setFocusToken((n) => n + 1);
  const closeSessions = () => {
    setShowSessions(false);
    focusComposer();
  };
  const toggleSessions = () => {
    if (showSessionsRef.current) closeSessions();
    else {
      post({ type: "refreshSessions" });
      setShowSessions(true);
    }
  };
  const toggleSessionsRef = useRef(toggleSessions);
  toggleSessionsRef.current = toggleSessions;
  // Read-only drill-down into a child session. Nested children push a crumb; ancestors are kept so
  // the report stays reachable without leaving the parent conversation.
  const [subagentStack, setSubagentStack] = useState<string[]>([]);
  // Human labels captured from the card that opened each child (the child state alone may not know
  // its agent name when only live events were received).
  const [subagentLabels, setSubagentLabels] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  /** Bumped when the host replaces the conversation: lets a crashed render boundary recover. */
  const [errorResetToken, setErrorResetToken] = useState(0);
  // The capture-phase key listener is installed once; keep the latest `syncNow` reachable so its
  // `syncing` guard still sees current state instead of the first render's value.
  const syncNowRef = useRef<() => void>(() => {});
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const [searchQuery, setSearchQuery] = useState("");
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  // Bumped by Cmd/Ctrl+F so re-focusing the search works even when it is already open.
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  // The capture-phase key listener is installed once; reach the latest navigation through a ref.
  const navigateMatchRef = useRef<(direction: number) => void>(() => {});
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  // A live region only announces when its text changes: repeating the same string is silent.
  const announce = (text: string) => setAnnouncement((prev) => ({ text, seq: prev.seq + 1 }));
  // The host-message listener below is installed once; read current strings through a ref so a
  // later `init` with translations is not shadowed by the first render's defaults.
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const [dropping, setDropping] = useState(false);
  const [dropzoneEnabled, setDropzoneEnabled] = useState(true);
  const dragDepth = useRef(0);
  const queue = useRef<ServerEvent[]>([]);
  const childQueue = useRef<SubagentEvent[]>([]);
  // A hidden webview gets no animation frames, so the SSE queues cannot drain. Cap them and ask the
  // host for a fresh snapshot instead of accumulating events forever.
  const resyncPending = useRef(false);
  const childResyncPending = useRef(new Set<string>());
  const frame = useRef<number | undefined>(undefined);
  const tooltipFrame = useRef<number | undefined>(undefined);
  // Conversation-scoped state must be dropped when the loaded session changes (new session,
  // folder switch, switching/deleting a session) but not on a same-session resync.
  const lastSessionId = useRef<string | null | undefined>(undefined);
  // The message filter is kept per session: switching to compare two chats used to wipe it.
  const searchQueries = useRef(new Map<string, string>());

  useEffect(() => {
    const requestResync = () => {
      if (resyncPending.current) return;
      resyncPending.current = true;
      // The `session` message replaces the truncated history and clears both queues.
      post({ type: "sync" });
    };
    const requestChildResync = (sid: string) => {
      if (childResyncPending.current.has(sid)) return;
      childResyncPending.current.add(sid);
      post({ type: "refreshSubagent", sessionId: sid });
    };
    const flush = () => {
      frame.current = undefined;
      const events = queue.current;
      const childEvents = childQueue.current;
      queue.current = [];
      childQueue.current = [];
      if (events.length > 0) dispatch({ type: "events", events });
      if (childEvents.length > 0) subagentDispatch({ type: "events", events: childEvents });
    };
    const off = onHostMessage((msg: HostMessage) => {
      switch (msg.type) {
        case "init":
          setStrings({ ...STRINGS, ...msg.strings });
          setCopyLabel(msg.strings.copy);
          setApplyLabel(msg.strings.applyCode);
          env.platform = msg.platform;
          env.toolOutputLimit = msg.toolOutputLimit ?? 4000;
          setFolders({ list: msg.folders, active: msg.activeFolder });
          setIssuesUrl(msg.issuesUrl);
          setDropzoneEnabled(msg.dropzone ?? true);
          break;
        case "connection":
          setStatus({ status: msg.status, error: msg.error });
          setCompatibility({ status: msg.compatibility ?? "unknown", version: msg.version, dismissed: !!msg.compatibilityDismissed });
          setContract({ report: msg.contract ?? emptyContract, dismissed: !!msg.contractDismissed });
          break;
        case "catalog":
          setCatalog({
            models: msg.models,
            agents: msg.agents,
            skills: msg.skills,
            commands: msg.commands ?? [],
            selectedModel: msg.selectedModel,
            selectedAgent: msg.selectedAgent,
          });
          break;
        case "sessions":
          setSessions(msg.items);
          setSessionsHasMore(!!msg.hasMore);
          break;
        case "session": {
          setErrorResetToken((n) => n + 1);
          queue.current = [];
          childQueue.current = [];
          resyncPending.current = false;
          childResyncPending.current.clear();
          const id = msg.session?.id ?? null;
          if (lastSessionId.current !== id) {
            const previous = lastSessionId.current;
            if (previous) searchQueries.current.set(previous, searchQueryRef.current);
            lastSessionId.current = id;
            setSearchQuery(id ? (searchQueries.current.get(id) ?? "") : "");
            setActiveMatch(0);
            subagentDispatch({ type: "clear" });
            setSubagentStack([]);
            setSubagentLabels({});
            setAttachments([]);
            setChanges([]);
            setInbox([]);
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
        case "sessionDelta":
          // A delta is a snapshot taken after the queued events: apply the live events first so the
          // history entries in the tail can replace their streaming cards rather than duplicate them.
          if (frame.current !== undefined) {
            cancelAnimationFrame(frame.current);
            frame.current = undefined;
          }
          if (queue.current.length > 0) dispatch({ type: "events", events: queue.current });
          if (childQueue.current.length > 0) subagentDispatch({ type: "events", events: childQueue.current });
          queue.current = [];
          childQueue.current = [];
          dispatch({ type: "append", delta: msg.delta });
          break;
        case "event":
          queue.current.push(msg.event);
          if (queue.current.length > MAX_QUEUED_EVENTS) {
            queue.current = queue.current.slice(-MAX_QUEUED_EVENTS);
            requestResync();
          }
          frame.current ??= requestAnimationFrame(flush);
          break;
        case "subagent":
          // A snapshot is authoritative for its child; drop any live events queued before it.
          childResyncPending.current.delete(msg.snapshot.sessionId);
          childQueue.current = childQueue.current.filter((e) => e.sessionId !== msg.snapshot.sessionId);
          subagentDispatch({ type: "snapshot", snapshot: msg.snapshot });
          // A running child has no id in the tool's persisted metadata, so link it now: without
          // this the card offers neither the open action nor the on-demand history refresh.
          dispatch({ type: "linkSubagent", sessionId: msg.snapshot.sessionId, title: msg.snapshot.title });
          break;
        case "subagentEvent":
          childQueue.current.push({ sessionId: msg.sessionId, event: msg.event });
          if (childQueue.current.length > MAX_QUEUED_EVENTS) {
            childQueue.current = childQueue.current.slice(-MAX_QUEUED_EVENTS);
            requestChildResync(msg.sessionId);
          }
          frame.current ??= requestAnimationFrame(flush);
          break;
        case "linkSubagent":
          // Explicit host link: reliable even when two children share a description or the tool
          // card is rendered after the tool event that announced the child session.
          dispatch({ type: "linkSubagent", toolId: msg.toolId, sessionId: msg.sessionId });
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
        case "promptCatalog":
          setPrompts(msg.items);
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
        case "inbox":
          // A snapshot is authoritative over the events queued before it. Apply those first,
          // otherwise an `inbox.enqueued` still in the rAF queue would recreate a prompt that this
          // very snapshot just removed, and the next `execution.started` would deliver it twice.
          if (frame.current !== undefined) {
            cancelAnimationFrame(frame.current);
            frame.current = undefined;
          }
          if (queue.current.length > 0) dispatch({ type: "events", events: queue.current });
          queue.current = [];
          setInbox(msg.items);
          dispatch({ type: "inbox", items: msg.items });
          break;
        case "forked":
          announce(stringsRef.current.forkDone);
          break;
        case "autoApprove":
          setAutoApprove(msg.enabled);
          break;
        case "dropzone":
          setDropzoneEnabled(msg.enabled);
          break;
        case "drafts":
          hydrateDrafts(msg.drafts, msg.globalDraft);
          setDraftToken((n) => n + 1);
          break;
        case "reverted":
          setDraft(msg.text, msg.sessionId);
          setRestoredDraft((prev) => ({ text: msg.text, token: (prev?.token ?? 0) + 1 }));
          post({ type: "saveDraft", sessionId: msg.sessionId, text: msg.text });
          announce(stringsRef.current.revertDone);
          break;
        case "draftRestored":
          setDraft(msg.text, msg.sessionId);
          // Normal restore only fills an empty composer; a successful retry force-clears the text
          // it put back, without clobbering anything the user typed in the meantime.
          if (msg.force) setRestoredDraft((prev) => ({ text: msg.text, token: (prev?.token ?? 0) + 1 }));
          else setDraftToken((n) => n + 1);
          break;
        case "focusInput":
          setFocusToken((n) => n + 1);
          break;
        case "revealMessage":
          setRevealMessageId(msg.messageId);
          break;
        case "prefillDraft":
          setDraft(msg.text, msg.sessionId);
          post({ type: "saveDraft", sessionId: msg.sessionId, text: msg.text });
          setDraftToken((n) => n + 1);
          setAttachments((prev) => {
            const next = [...prev];
            for (const item of msg.attachments) if (!next.some((a) => a.uri === item.uri)) next.push(item);
            return next;
          });
          setFocusToken((n) => n + 1);
          break;
        case "synced":
          setSyncing(false);
          setErrorResetToken((n) => n + 1);
          // A no-op sync (e.g. no client/session yet) posts no `session` message. Without clearing
          // here, the next queue overflow would short-circuit and the hidden chat stays stale.
          resyncPending.current = false;
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
    // This effect runs after every render (including every streamed token). Keep at most one frame
    // pending instead of cancelling and rescheduling it each time: new cards get measured on the
    // next frame, while continuous streaming no longer churns the scheduler.
    if (tooltipFrame.current !== undefined) return;
    tooltipFrame.current = requestAnimationFrame(() => {
      tooltipFrame.current = undefined;
      const vw = window.innerWidth;
      const updates: { el: HTMLElement; dir: "left" | "right" }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(".tooltip-host")) {
        // Direction is decided once: a tooltip's anchor side does not change while the chat
        // streams, so re-measuring every element on every frame is pure forced-layout cost.
        if (el.dataset.tipDir) continue;
        const tip = getComputedStyle(el, "::after");
        if (tip.content === "none" || tip.display === "none") continue;
        const width = parseFloat(tip.width) || 0;
        const rect = el.getBoundingClientRect();
        updates.push({ el, dir: vw - rect.right >= width + 8 ? "right" : "left" });
      }
      for (const { el, dir } of updates) el.dataset.tipDir = dir;
    });
  });
  useEffect(
    () => () => {
      if (tooltipFrame.current !== undefined) cancelAnimationFrame(tooltipFrame.current);
    },
    [],
  );

  // Cmd/Ctrl+N creates a new session, Cmd/Ctrl+F opens the message search, Cmd/Ctrl+R re-syncs,
  // Cmd/Ctrl+L toggles the session list and Cmd/Ctrl+M opens the model picker while the chat has
  // focus. The VS Code preload forwards every keydown that reaches `window` to the workbench (see D7),
  // where these chords mean "new file" / "find" / "open recent" / "expand line selection" /
  // "toggle tab focus mode". Capture them before that bubble-phase listener.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isNewSessionKey(e, env.platform)) {
        e.preventDefault();
        e.stopPropagation();
        post({ type: "newSession" });
      } else if (isFindKey(e, env.platform)) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        setSearchFocusToken((token) => token + 1);
      } else if (isSyncKey(e, env.platform)) {
        e.preventDefault();
        e.stopPropagation();
        syncNowRef.current();
      } else if (isOpenSessionsKey(e, env.platform)) {
        e.preventDefault();
        e.stopPropagation();
        toggleSessionsRef.current();
      } else if (isOpenModelsKey(e, env.platform)) {
        e.preventDefault();
        e.stopPropagation();
        setModelPickerToken((n) => n + 1);
      } else if (e.key === "F3") {
        e.preventDefault();
        e.stopPropagation();
        navigateMatchRef.current(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape" && searchOpenRef.current) {
        // Escape closes the search *and* clears it: leaving the query would keep every non-match
        // dimmed after the search bar disappeared.
        e.preventDefault();
        e.stopPropagation();
        closeSearchRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Announce completion / attention for screen readers.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !chat.busy) announce(strings.responseComplete);
    wasBusy.current = chat.busy;
  }, [chat.busy]);
  useEffect(() => {
    if (chat.permissions.length > 0) announce(strings.permissionTitle);
  }, [chat.permissions.length]);
  useEffect(() => {
    if (chat.forms.length > 0) announce(strings.questionTitle);
  }, [chat.forms.length]);

  const todos = useMemo(() => selectTodos(chat), [chat.messages]);
  // GET /session/{id}/diff is empty outside git repos, so fall back to patches in tool metadata.
  // `chat.messages` is a new array on every streamed token, but file diffs only change when a tool
  // completes. Keep the previous array when its content is identical so the expensive patch
  // signature below is not rebuilt on every frame.
  const lastChangedFiles = useRef<FileDiff[]>([]);
  const changedFiles = useMemo(() => {
    const next = mergeChangedFiles(changes, chat);
    const prev = lastChangedFiles.current;
    if (
      prev.length === next.length &&
      prev.every((p, i) => {
        const n = next[i];
        return (
          p.file === n.file && p.status === n.status && p.additions === n.additions && p.deletions === n.deletions && p.patch === n.patch
        );
      })
    )
      return prev;
    lastChangedFiles.current = next;
    return next;
  }, [changes, chat.messages, chat.touchedFiles]);
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
  const send = (text: string, delivery?: "steer" | "queue") => {
    const ctx = context.filter((c) => selectedContext.has(c.id));
    const skillCommand = /(^|\s)\/(\S+)(?=\s|$)/.exec(text);
    const isCommand = skillCommand && catalog.commands.some((item) => item.name === skillCommand[2]);
    const skill = !isCommand && skillCommand && catalog.skills.find((item) => item.id === skillCommand[2]);
    const prompt =
      skillCommand && skill
        ? `${text.slice(0, skillCommand.index)}${skillCommand[1]}@${skill.id}${text.slice(skillCommand.index + skillCommand[0].length)}`
        : text;
    post({ type: "send", text: prompt, attachments, context: ctx, delivery });
    setAttachments([]);
    setNotice(undefined);
    // Follow the new prompt even if the user had scrolled up to read older messages.
    setScrollToken((n) => n + 1);
  };

  // VS Code delivers file drops to a webview only while Shift is held (otherwise it opens the file
  // in an editor). Listen on window, not just the app element, so events targeting any child are
  // still seen. Dropped files become attachments, exactly like @-mentions.
  useEffect(() => {
    if (!dropzoneEnabled) {
      dragDepth.current = 0;
      setDropping(false);
      return;
    }
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
  }, [dropzoneEnabled]);

  const subagentEntries = useMemo(() => {
    const entries: Record<string, SubagentEntry> = {};
    for (const id of subagents.order) {
      const state = subagents.byId[id];
      if (state) entries[id] = { state, meta: subagents.meta[id] ?? {} };
    }
    return entries;
  }, [subagents]);
  const openSubagent = (sessionId: string, label?: string) => {
    setSubagentStack((prev) => pushSubagentSession(prev, sessionId));
    if (label) setSubagentLabels((prev) => (prev[sessionId] === label ? prev : { ...prev, [sessionId]: label }));
    // A past child has no live stream; reuse the same on-demand fetch the inline card uses.
    const entry = subagentEntries[sessionId];
    if (!entry || entry.state.messages.length === 0) post({ type: "refreshSubagent", sessionId });
  };
  const connected = status.status === "connected" || status.status === "reconnecting";
  const title = chat.title || sessions.find((s) => s.id === chat.sessionId)?.title || strings.untitled;
  // Inline attachments are sent as data URLs; their decoded content costs tokens too.
  const attachmentTokens = [...context, ...attachments].reduce((n, a) => n + estimateDataUrlTokens(a.uri), 0);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searchCount = useMemo(
    () =>
      normalizedQuery
        ? chat.messages.filter((m) => messageSearchText(m).toLowerCase().includes(normalizedQuery)).length
        : chat.messages.length,
    [chat.messages, normalizedQuery],
  );
  // Count the marks that are actually rendered (a collapsed tool can hide text) and keep the
  // highlighted one in sync across re-renders while a turn streams in.
  // Jump to the first hit as soon as it exists, not only on Enter/F3. The query guard keeps the
  // view still while a turn streams new matching text.
  const autoScrolledQuery = useRef("");
  useLayoutEffect(() => {
    const marks = Array.from(document.querySelectorAll<HTMLElement>(".conversation mark[data-search-match]"));
    if (marks.length !== matchCount) setMatchCount(marks.length);
    if (marks.length > 0 && activeMatch >= marks.length) setActiveMatch(0);
    marks.forEach((mark, i) => mark.classList.toggle("match-current", i === activeMatch));
    if (!normalizedQuery) autoScrolledQuery.current = "";
    else if (marks.length > 0 && autoScrolledQuery.current !== normalizedQuery) {
      autoScrolledQuery.current = normalizedQuery;
      marks[0].scrollIntoView({ block: "center", behavior: "instant" });
    }
  }, [normalizedQuery, chat.messages, activeMatch, matchCount]);

  const navigateMatch = (direction: number) => {
    const marks = Array.from(document.querySelectorAll<HTMLElement>(".conversation mark[data-search-match]"));
    if (marks.length === 0) return;
    const next = (activeMatch + direction + marks.length) % marks.length;
    setActiveMatch(next);
    marks[next]?.scrollIntoView({ block: "center", behavior: "instant" });
  };
  navigateMatchRef.current = navigateMatch;

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    if (chat.sessionId) searchQueries.current.set(chat.sessionId, "");
    setActiveMatch(0);
  };
  const closeSearchRef = useRef(closeSearch);
  closeSearchRef.current = closeSearch;

  // Everything stays in the webview: no host message, no network request.
  const exportConversation = () => {
    const markdown = conversationMarkdown(chat.messages, title, strings);
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(markdown, `opencode-${chat.sessionId ?? "session"}-${date}.md`);
  };
  // The host always answers with `synced`, even when there is no session to reload.
  const syncNow = () => {
    if (syncing) return;
    setSyncing(true);
    post({ type: "sync" });
  };
  syncNowRef.current = syncNow;

  /** Pull a queued prompt back into the composer (the API cannot patch its text in place). */
  const editQueued = (item: InboxItem) => {
    const sid = chat.sessionId;
    if (!sid || item.type !== "user" || typeof item.payload.text !== "string") return;
    post({ type: "cancelInbox", sessionId: sid, inboxId: item.id });
    setDraft(item.payload.text, sid);
    setRestoredDraft((prev) => ({ text: item.payload.text!, token: (prev?.token ?? 0) + 1 }));
    post({ type: "saveDraft", sessionId: sid, text: item.payload.text });
    setNotice(undefined);
    setFocusToken((n) => n + 1);
  };
  const removeQueued = (item: InboxItem) => {
    if (!chat.sessionId) return;
    post({ type: "cancelInbox", sessionId: chat.sessionId, inboxId: item.id });
    announce(stringsRef.current.inboxCancelled);
  };
  const sendQueuedNow = (item: InboxItem) => {
    if (!chat.sessionId) return;
    post({ type: "setInboxDelivery", sessionId: chat.sessionId, inboxId: item.id, delivery: "steer" });
  };

  return (
    <StringsContext.Provider value={strings}>
      <SubagentsContext.Provider value={subagentEntries}>
        <SubagentNavContext.Provider value={openSubagent}>
          <WebviewErrorBoundary resetToken={errorResetToken}>
            <div class="app">
              <Header
                title={chat.sessionId ? title : strings.untitled}
                folders={folders}
                showSessions={showSessions}
                onToggleSessions={toggleSessions}
                onExport={exportConversation}
                onSync={syncNow}
                onNewSession={() => post({ type: "newSession" })}
                syncing={syncing}
                searchOpen={searchOpen}
                onToggleSearch={() => setSearchOpen((open) => !open)}
                onCloseSearch={closeSearch}
                searchFocusToken={searchFocusToken}
                searchQuery={searchQuery}
                onSearchChange={(value) => {
                  setSearchQuery(value);
                  if (chat.sessionId) searchQueries.current.set(chat.sessionId, value);
                  setActiveMatch(0);
                }}
                searchCount={searchCount}
                activeMatch={activeMatch}
                matchCount={matchCount}
                onNavigateMatch={navigateMatch}
              />
              {showSessions && (
                <SessionList
                  sessions={sessions}
                  currentId={chat.sessionId}
                  hasMore={sessionsHasMore}
                  onLoadMore={() => post({ type: "loadMoreSessions" })}
                  onClose={closeSessions}
                  onSelect={focusComposer}
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
              <Conversation
                chat={chat}
                models={catalog.models}
                status={status.status}
                error={status.error}
                hasActiveFile={context.some((c) => c.kind === "file")}
                hasSelection={context.some((c) => c.kind === "selection")}
                scrollToken={scrollToken}
                searchQuery={searchQuery}
                revealMessageId={revealMessageId}
                onRevealed={() => setRevealMessageId(undefined)}
                onSuggestedPrompt={(text) => {
                  setDraft(text, chat.sessionId ?? undefined);
                  setDraftToken((n) => n + 1);
                  setFocusToken((n) => n + 1);
                  post({ type: "saveDraft", sessionId: chat.sessionId ?? undefined, text });
                }}
              />
              <div class="sr-only" role="status" aria-live="polite">
                {announcement.text + "\u200b".repeat(announcement.seq % 2)}
              </div>
              {todos && todos.length > 0 && <TodoPanel todos={todos} />}
              {changedFiles.length > 0 && !changesDismissed && (
                <ChangesPanel files={changedFiles} onDismiss={() => setDismissedChanges(changesSignature)} />
              )}
              {/* When the subagent modal is open it renders its own overlay; passing the child requests
            here too would duplicate the same cards (and the same DOM ids) behind the backdrop. */}
              <AttentionOverlay key={chat.sessionId ?? "new"} state={chat} subagents={subagentStack.length === 0 ? subagents : undefined} />
              {inbox.length > 0 && <InboxPanel items={inbox} onSendNow={sendQueuedNow} onEdit={editQueued} onRemove={removeQueued} />}
              <Composer
                sessionId={chat.sessionId ?? undefined}
                draftToken={draftToken}
                restoredDraft={restoredDraft}
                busy={chat.busy}
                contextTokens={chat.contextTokens === undefined ? undefined : chat.contextTokens + attachmentTokens}
                contextEstimated={attachmentTokens > 0}
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
                prompts={prompts}
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
                modelPickerToken={modelPickerToken}
                onModelSelected={focusComposer}
                canCompact={!!chat.sessionId && !chat.busy && connected}
              />
              {dropping && (
                <div class="drop-overlay" aria-hidden="true">
                  <div class="drop-overlay-inner">{strings.dropFilesOverlay}</div>
                </div>
              )}
              {subagentStack.length > 0 && (
                <SubagentModal
                  stack={subagentStack}
                  entries={subagentEntries}
                  labels={subagentLabels}
                  subagents={subagents}
                  parentTitle={title}
                  models={catalog.models}
                  onNavigate={(depth) => setSubagentStack((prev) => truncateSubagentStack(prev, depth))}
                  onClose={() => setSubagentStack([])}
                />
              )}
            </div>
          </WebviewErrorBoundary>
        </SubagentNavContext.Provider>
      </SubagentsContext.Provider>
    </StringsContext.Provider>
  );
}
