import { Component, createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import type { AgentInfo, CommandSuggestion, FileDiff, InboxItem, ModelInfo, ModelRef, ServerEvent, SkillSuggestion } from "../shared/api";
import {
  chatReducer,
  initialChatState,
  mergeChangedFiles,
  selectTodos,
  selectTurnFileChanges,
  selectTurnFiles,
  type TextPart,
  type ToolPart,
  type TurnStats,
  type UiAssistantMessage,
  type UiMessage,
  type UiUserMessage,
} from "../shared/chatReducer";
import { SUPPORTED_SERVER_VERSION, type Compatibility } from "../shared/compatibility";
import { estimateDataUrlTokens } from "../shared/format";
import { isFindKey, isNewSessionKey, isSyncKey } from "../shared/keys";
import { contractSignature, emptyContract, type ContractReport } from "../shared/contract";
import type {
  ActionId,
  Attachment,
  ConnectionStatus,
  ContextItem,
  FolderInfo,
  HostMessage,
  SessionSummary,
  UiError,
} from "../shared/protocol";
import {
  initialSubagentState,
  pushSubagentSession,
  subagentReducer,
  truncateSubagentStack,
  type SubagentEvent,
  type SubagentState,
} from "../shared/subagents";
import { format, STRINGS, type Strings } from "../shared/strings";
import { AttentionOverlay } from "./attentionOverlay";
import { Composer } from "./composer";
import { collectDroppedFiles, hasFiles, readFileAsBase64, type DragData } from "./dropFiles";
import { env, isolateKeys } from "./env";
import { StringsContext, useT } from "./i18n";
import {
  IconCheck,
  IconChevron,
  IconClose,
  IconEdit,
  IconError,
  IconFileMarkdown,
  IconHistory,
  IconPlus,
  IconRefresh,
  IconSend,
  IconTrash,
  IconWarning,
} from "./icons";
import { setCopyLabel } from "./markdown";
import { Picker } from "./picker";
import { clearReplyFailures, markReplyFailed } from "./replyFeedback";
import { SubagentNavContext, SubagentsContext, type SubagentEntry } from "./subagents";
import { ActionButton, AssistantStatus, FileList, MessageView, messageSearchText, ToolCard, ToolGroup, TurnStatsRow } from "./messages";
import { hydrateDrafts, onHostMessage, post, setDraft } from "./vscode";

/** Bounded queue: a hidden webview gets no requestAnimationFrame, so SSE events cannot drain. */
const MAX_QUEUED_EVENTS = 500;

/** Errors whose fix is a setup step, not a retry: the empty state adapts to them. */
const SETUP_ERROR_KINDS = new Set<UiError["kind"]>(["notInstalled", "startFailed", "noProvider", "untrustedWorkspace", "noWorkspace"]);

/** Per-turn fold overrides: a finished turn keeps its steps open until the user folds them. */
interface StepGroup {
  keys: string[];
  defaults: Map<string, boolean>;
}
interface StepControl {
  expanded: (key: string, fallback: boolean) => boolean;
  toggle: (key: string, fallback: boolean) => void;
  toggleGroup: (group: StepGroup) => void;
}
const StepControlContext = createContext<StepControl | undefined>(undefined);

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
  const [draftToken, setDraftToken] = useState(0);
  /** Prompt returned by a rollback; a new token forces the composer to adopt it even if it has text. */
  const [restoredDraft, setRestoredDraft] = useState<{ text: string; token: number } | undefined>();
  const [scrollToken, setScrollToken] = useState(0);
  const [revealMessageId, setRevealMessageId] = useState<string | undefined>(undefined);
  const [showSessions, setShowSessions] = useState(false);
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

  // Cmd/Ctrl+N creates a new session, Cmd/Ctrl+F opens the message search and Cmd/Ctrl+R re-syncs
  // the session while the chat has focus. The VS Code webview preload forwards every keydown that
  // reaches `window` to the workbench (see D7), where these chords mean "new file" / "find" /
  // "open recent". Capture them before that bubble-phase listener so the workbench never sees them.
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
  const attachmentTokens = attachments.reduce((n, a) => n + estimateDataUrlTokens(a.uri), 0);

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
      marks[0].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [normalizedQuery, chat.messages, activeMatch, matchCount]);

  const navigateMatch = (direction: number) => {
    const marks = Array.from(document.querySelectorAll<HTMLElement>(".conversation mark[data-search-match]"));
    if (marks.length === 0) return;
    const next = (activeMatch + direction + marks.length) % marks.length;
    setActiveMatch(next);
    marks[next]?.scrollIntoView({ block: "center", behavior: "smooth" });
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
                onToggleSessions={() => {
                  if (!showSessions) post({ type: "refreshSessions" });
                  setShowSessions(!showSessions);
                }}
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
              <Conversation
                chat={chat}
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
              {subagentStack.length > 0 && (
                <SubagentModal
                  stack={subagentStack}
                  entries={subagentEntries}
                  labels={subagentLabels}
                  subagents={subagents}
                  parentTitle={title}
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

/**
 * Catches rendering errors so a single bad message cannot leave the webview blank. A new `session`
 * or a completed resync increments `resetToken`, which retries the render with the fresh data; the
 * reload action remains as a last resort if the same payload keeps throwing.
 */
class WebviewErrorBoundary extends Component<{ children: ComponentChildren; resetToken: number }, { failed: boolean; token: number }> {
  state = { failed: false, token: this.props.resetToken };

  static getDerivedStateFromProps(props: { resetToken: number }, state: { failed: boolean; token: number }) {
    return props.resetToken !== state.token ? { failed: false, token: props.resetToken } : null;
  }

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

/** Turns the in-memory chat into a portable, readable Markdown transcript. */
function conversationMarkdown(messages: ReturnType<typeof chatReducer>["messages"], title: string, strings: Strings): string {
  const text = (key: keyof Strings, ...args: (string | number)[]) => format(strings[key] ?? STRINGS[key], ...args);
  const lines: string[] = [`# ${title || STRINGS.appName}`, ""];
  for (const m of messages) {
    if (m.kind === "user") {
      lines.push(`## ${text("you")}`, "", m.text, "");
      for (const f of m.files) lines.push(`- \`${f.name ?? f.uri}\``);
      if (m.files.length > 0) lines.push("");
      continue;
    }
    if (m.kind === "notice") {
      lines.push(`> **${m.level}:** ${m.text.replace(/\s*\n\s*/g, " ")}`, "");
      continue;
    }
    for (const p of m.parts) {
      if (p.kind === "tool") {
        lines.push(`> **${text("tool")}:** \`${p.name}\`${p.status === "error" ? ` (${text("failed")})` : ""}`);
        for (const l of p.inputText.split("\n")) lines.push(`> ${l}`);
        const output = p.output.map((c) => (c.type === "text" ? c.text : `[${c.mime}] ${c.name ?? c.uri}`)).join("\n");
        for (const l of output.split("\n")) if (l) lines.push(`> ${l}`);
        lines.push("");
      } else if (p.kind === "text") {
        lines.push(p.text, "");
      } else if (p.text.trim()) {
        lines.push("<details><summary>Thoughts</summary>", "", p.text, "", "</details>", "");
      }
    }
    if (m.error?.message) lines.push(`> **${text("error")}:** ${m.error.message}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Blob + anchor download: works under the webview CSP (no `connect-src` needed) and sends nothing to the host. */
function downloadFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Header(props: {
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
        <IconFileMarkdown />
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
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const filterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visible = useMemo(
    () => props.sessions.filter((s) => (s.title || t("untitled")).toLowerCase().includes(filter.trim().toLowerCase())),
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
          <button
            type="button"
            class="icon-button dismiss tooltip-host"
            data-tooltip={t("dismiss")}
            aria-label={t("dismiss")}
            onClick={onDismiss}
          >
            <IconClose />
          </button>
        )}
      </div>
      {error.detail &&
        (SETUP_ERROR_KINDS.has(error.kind) ? (
          <pre class="banner-detail-inline">{error.detail}</pre>
        ) : (
          <details class="banner-detail">
            <summary>{t("details")}</summary>
            <pre>{error.detail}</pre>
          </details>
        ))}
      <div class="banner-actions">
        {error.actions.map((a) => (
          <ActionButton key={a} id={a} />
        ))}
      </div>
    </div>
  );
}

/**
 * Empty state for a setup blocker. The banner above explains the failure; this turns it into a
 * short checklist so a first-run user knows what to do next instead of staring at chat prompts.
 */
function SetupWelcome({ error }: { error: UiError }) {
  const t = useT();
  const steps: Array<{ label: string; done: boolean; action?: ActionId }> = [
    {
      label: t("setupTrust"),
      done: error.kind !== "untrustedWorkspace" && error.kind !== "noWorkspace",
      action: error.kind === "noWorkspace" ? "openFolder" : error.kind === "untrustedWorkspace" ? "trustWorkspace" : undefined,
    },
    {
      label: t("setupInstall"),
      done: error.kind !== "notInstalled" && error.kind !== "startFailed",
      action: error.kind === "notInstalled" || error.kind === "startFailed" ? "install" : undefined,
    },
    {
      label: t("setupProvider"),
      done: error.kind !== "noProvider",
      action: error.kind === "noProvider" ? "login" : undefined,
    },
  ];
  return (
    <div class="welcome setup" aria-label={t("setupTitle")}>
      <h2>{t("setupTitle")}</h2>
      <p>{t("setupBody")}</p>
      <ol class="setup-steps">
        {steps.map((step) => (
          <li class={step.done ? "done" : "pending"} key={step.label}>
            <span class="setup-step-icon" aria-hidden="true">
              {step.done ? <IconCheck /> : <IconError />}
            </span>
            <span class="setup-step-label">{step.label}</span>
            {step.action && <ActionButton id={step.action} />}
          </li>
        ))}
      </ol>
      <p class="welcome-hint">{error.message}</p>
      <p class="welcome-hint">{t("setupHint")}</p>
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
        <button
          type="button"
          class="icon-button dismiss tooltip-host"
          data-tooltip={t("dismiss")}
          aria-label={t("dismiss")}
          onClick={() => {
            setDismissed(true);
            // Remembered by the host so the banner stays hidden for this version across reloads.
            if (version) post({ type: "dismissCompatibility", version });
          }}
        >
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
  | { kind: "status"; key: string; message: UiAssistantMessage; typing: boolean }
  | { kind: "step"; key: string; index: number; lastIndex: number; details: ConversationItem[]; live: boolean }
  | { kind: "turnStats"; key: string; stats: TurnStats };

/** The summary of a turn is emitted once, after the last assistant message it produced. */
function statsForTurn(turns: TurnStats[], msgs: UiAssistantMessage[]): TurnStats | undefined {
  const first = msgs[0]?.created;
  if (first === undefined) return undefined;
  const matches = turns.filter((t) => t.ended !== undefined && t.started <= first && first <= t.ended);
  if (matches.length === 0) return undefined;
  // A reconcile can add a history turn covering the same window whose tool metadata omits the
  // file counts. Prefer the turn that kept the counts captured live; fall back to whatever the
  // current tool parts still report (e.g. a turn first seen mid-stream).
  const kept =
    [...matches].reverse().find((t) => (t.additions ?? 0) > 0 || (t.deletions ?? 0) > 0 || (t.files?.length ?? 0) > 0) ??
    matches[matches.length - 1];
  const derived = selectTurnFileChanges(msgs);
  const files = selectTurnFiles(msgs);
  return {
    ...kept,
    additions: Math.max(kept.additions ?? 0, derived.additions),
    deletions: Math.max(kept.deletions ?? 0, derived.deletions),
    files: kept.files?.length ? kept.files : files,
  };
}

type StepPiece = { kind: "prose" | "details"; item: ConversationItem };

/**
 * Splits one step into always-visible prose and collapsible thoughts/tools, keeping their real
 * order. The model usually thinks before it speaks, but a reasoning part can also arrive *after*
 * a text part in the same assistant message; grouping all thoughts first used to move that late
 * thought above the sentence it followed (visible until the next part re-rendered the step).
 */
function splitStep(items: ConversationItem[]): StepPiece[] {
  const out: StepPiece[] = [];
  for (const it of items) {
    if (it.kind !== "assistant") {
      out.push({ kind: "details", item: it });
      continue;
    }
    let run: TextPart[] = [];
    let runKind: "text" | "reasoning" | undefined;
    let seq = 0;
    const flush = () => {
      if (run.length === 0) return;
      out.push({
        kind: runKind === "text" ? "prose" : "details",
        item: {
          ...it,
          key: `${it.key}:${runKind === "text" ? "text" : "thoughts"}:${seq++}`,
          parts: run,
        },
      });
      run = [];
    };
    for (const p of it.parts) {
      if (runKind !== undefined && runKind !== p.kind) flush();
      runKind = p.kind;
      run.push(p);
    }
    flush();
  }
  return out;
}

/**
 * Consecutive thoughts/tools collapse into one fold; prose breaks the run and stays where the
 * model produced it. This keeps the common "think then speak" order (details above the answer)
 * without reordering a thought that arrived after a sentence. The live step's fold stays expanded
 * while the turn streams; finished ones collapse.
 */
function stepBlocks(groups: ConversationItem[][], liveIndex: number, allLive = false): ConversationItem[] {
  const out: ConversationItem[] = [];
  let pending: ConversationItem[] = [];
  let pendingFrom = -1;
  let pendingTo = -1;
  let foldSeq = 0;

  const flushPending = () => {
    if (pendingFrom < 0) return;
    out.push({
      kind: "step",
      key: `steps:${pendingFrom}:${pendingTo}:${foldSeq++}`,
      index: pendingFrom,
      lastIndex: pendingTo,
      details: pending,
      live: allLive || (liveIndex >= pendingFrom && liveIndex <= pendingTo),
    });
    pending = [];
    pendingFrom = -1;
    pendingTo = -1;
  };

  for (let s = 0; s < groups.length; s++) {
    for (const piece of splitStep(groups[s])) {
      if (piece.kind === "details") {
        if (pendingFrom < 0) pendingFrom = s;
        pending.push(piece.item);
        pendingTo = s;
      } else {
        flushPending();
        out.push(piece.item);
      }
    }
  }
  // A trailing textless run (turn ended after tool calls) still needs a fold.
  flushPending();
  return out;
}

/**
 * Renders a turn in the order the model produced it. OpenCode emits one assistant message per step;
 * each becomes a block with its prose visible and its thoughts/tools in a dedicated collapsible.
 */
function conversationItems(messages: UiMessage[], turns: TurnStats[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let turn: UiAssistantMessage[] = [];
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "assistant") {
      lastAssistant = i;
      break;
    }
  }

  const flushTurn = () => {
    if (turn.length === 0) return;

    // One group per assistant message: OpenCode emits one message per step, so a group boundary
    // is a step boundary. Keeping the groups lets us fold past steps even while the turn streams.
    const groups: ConversationItem[][] = [];
    let stepItems: ConversationItem[] = [];
    let tools: ToolPart[] = [];
    let started = false;

    const flushTools = () => {
      if (tools.length === 0) return;
      if (tools.length === 1) stepItems.push({ kind: "tool", key: tools[0].key, part: tools[0] });
      else stepItems.push({ kind: "tools", key: `tools:${tools[0].key}`, parts: tools });
      tools = [];
      started = true;
    };

    for (const m of turn) {
      let texts: TextPart[] = [];
      const flushTexts = () => {
        if (texts.length === 0) return;
        stepItems.push({ kind: "assistant", key: `${m.id}:${texts[0].key}`, message: m, parts: texts, grouped: started });
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
      // Close the step here instead of at the end of the turn: adjacent tool calls from two
      // different steps must not merge into one accordion.
      flushTools();
      groups.push(stepItems);
      stepItems = [];
    }

    // Retry/error feedback belongs to the turn, after whatever content it managed to produce.
    for (const m of turn) {
      if (m.retry || m.error) {
        groups[groups.length - 1].push({ kind: "status", key: `status:${m.id}`, message: m, typing: false });
      }
    }
    const last = turn.at(-1);
    if (last && !last.done && last.parts.length === 0) {
      groups[groups.length - 1].push({ kind: "status", key: `typing:${last.id}`, message: last, typing: true });
    }

    const stats = statsForTurn(turns, turn);
    // While streaming, the last step stays open. Once a turn finishes, keep *its* steps open —
    // that is exactly what someone reviewing the reply wants to see — and fold older turns.
    const isLatestTurn = lastAssistant >= 0 && turn.includes(messages[lastAssistant] as UiAssistantMessage);
    const allLive = !!stats && isLatestTurn;
    const liveIndex = stats ? (allLive ? groups.length - 1 : -1) : groups.length - 1;
    items.push(...stepBlocks(groups, liveIndex, allLive));
    if (stats) items.push({ kind: "turnStats", key: `stats:${stats.id}`, stats });
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

/** Text of a rendered conversation item, for the header's filter. */
function itemSearchText(item: ConversationItem): string {
  switch (item.kind) {
    case "message":
      return messageSearchText(item.message);
    case "assistant":
      return item.parts.map((p) => p.text).join(" ");
    case "tool":
      return [
        item.part.name,
        item.part.inputText,
        ...item.part.output.map((c) => (c.type === "text" ? c.text : `[${c.mime}] ${c.name ?? c.uri}`)),
      ].join(" ");
    case "tools":
      return item.parts.map((p) => [p.name, p.inputText].join(" ")).join(" ");
    case "status":
      return [item.message.error?.message ?? "", item.message.retry?.message ?? ""].join(" ");
    case "step":
      return item.details.map(itemSearchText).join(" ");
    case "turnStats":
      return "";
  }
}

/** One step: its prose is always visible, its thoughts/tools expand on demand. */
function StepBlock({
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

function Conversation({
  chat,
  status,
  error,
  hasActiveFile,
  hasSelection,
  scrollToken,
  searchQuery,
  label,
  revealMessageId,
  onRevealed,
  onSuggestedPrompt,
}: {
  chat: ReturnType<typeof chatReducer>;
  status?: ConnectionStatus;
  error?: UiError;
  hasActiveFile?: boolean;
  hasSelection?: boolean;
  scrollToken: number;
  searchQuery: string;
  label?: string;
  revealMessageId?: string;
  onRevealed?: () => void;
  onSuggestedPrompt?: (text: string) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastId = useRef<string | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(true);
  const items = useMemo(() => conversationItems(chat.messages, chat.turns), [chat.messages, chat.turns]);
  const query = searchQuery.trim().toLowerCase();

  // Fold state is owned here so one control can expand/collapse every step of a turn. Defaults
  // come from the items themselves (latest finished turn open, older turns folded, search open).
  const [stepOverrides, setStepOverrides] = useState<Map<string, boolean>>(new Map());
  useEffect(() => setStepOverrides(new Map()), [chat.sessionId]);
  const stepGroups = useMemo(() => {
    const groups: StepGroup[] = [];
    let current: StepGroup | undefined;
    for (const item of items) {
      if (item.kind === "step") {
        if (!current) {
          current = { keys: [], defaults: new Map() };
          groups.push(current);
        }
        current.keys.push(item.key);
        current.defaults.set(item.key, item.live || !!query);
      } else if (item.kind === "turnStats" || item.kind === "message") {
        current = undefined;
      }
    }
    return groups;
  }, [items, query]);
  const groupByKey = useMemo(() => {
    const map = new Map<string, StepGroup>();
    for (const group of stepGroups) for (const key of group.keys) map.set(key, group);
    return map;
  }, [stepGroups]);
  const stepControl: StepControl = {
    expanded: (key, fallback) => stepOverrides.get(key) ?? fallback,
    toggle: (key, fallback) =>
      setStepOverrides((prev) => {
        const next = new Map(prev);
        next.set(key, !(prev.get(key) ?? fallback));
        return next;
      }),
    toggleGroup: (group) =>
      setStepOverrides((prev) => {
        const open = group.keys.every((key) => prev.get(key) ?? group.defaults.get(key) ?? false);
        const next = new Map(prev);
        for (const key of group.keys) next.set(key, !open);
        return next;
      }),
  };

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

  // A reveal is a one-shot command, not persistent state. Previously the id stayed set, so every
  // streamed token re-ran this effect, scrolled the user back to the old hit and fought auto-scroll.
  const consumedReveal = useRef<string | undefined>(undefined);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!revealMessageId) {
      consumedReveal.current = undefined;
      return;
    }
    if (consumedReveal.current === revealMessageId) return;
    const container = ref.current;
    if (!container) return;
    // Compare `dataset` instead of interpolating the id into a CSS selector: message ids come from
    // the server, so quotes/brackets in one used to throw a SyntaxError and take down the webview.
    const el = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (candidate) => candidate.dataset.messageId === revealMessageId,
    );
    if (!el) return; // Not rendered yet (e.g. still loading): retry when messages change.
    consumedReveal.current = revealMessageId;
    // Scroll only the chat container: `scrollIntoView` would also scroll the surrounding webview
    // (and the editor), which can leave the visible chat apparently stuck somewhere else.
    const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += delta - container.clientHeight / 2 + el.clientHeight / 2;
    stick.current = false;
    setAtBottom(false);
    el.classList.add("revealed");
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => el.classList.remove("revealed"), 1600);
    onRevealed?.();
  }, [revealMessageId, chat.messages, onRevealed]);

  // Pin to the bottom only when the conversation actually grows (a streamed token, a new
  // message, a new card). This used to run after *every* render, so an unrelated state change
  // (tooltip direction, context chips, session refresh) yanked the view back
  // down while the user was scrolling up through old history — the chat felt stuck to the
  // bottom. Comparing scroll heights also avoids fighting the user when content is replaced
  // rather than appended (e.g. steps folding into a summary).
  const lastScrollHeight = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = lastScrollHeight.current;
    lastScrollHeight.current = el.scrollHeight;
    if (el.scrollHeight > previous && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.permissions, chat.forms, chat.retry, chat.busy, items.length]);

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
  const renderItem = (item: ConversationItem, q: string) => {
    const filteredOut = !!q && !itemSearchText(item).toLowerCase().includes(q);
    switch (item.kind) {
      case "tools":
        return <ToolGroup key={item.key} parts={item.parts} state={chat} filteredOut={filteredOut} searchQuery={q} />;
      case "tool":
        return <ToolCard key={item.key} part={item.part} state={chat} filteredOut={filteredOut} searchQuery={q} />;
      case "assistant":
        return (
          <MessageView
            key={item.key}
            message={{ ...item.message, parts: item.parts }}
            state={chat}
            grouped={item.grouped}
            showStatus={false}
            filteredOut={filteredOut}
            searchQuery={q}
          />
        );
      case "status":
        return <AssistantStatus key={item.key} message={item.message} typing={item.typing} filteredOut={filteredOut} />;
      case "step":
        return (
          <StepBlock
            key={item.key}
            index={item.index}
            lastIndex={item.lastIndex}
            details={item.details}
            live={item.live}
            controlKey={item.key}
            group={groupByKey.get(item.key)}
            filteredOut={filteredOut}
            searchActive={!!q}
            render={renderItem}
          />
        );
      case "turnStats":
        return <TurnStatsRow key={item.key} stats={item.stats} />;
      case "message":
        return (
          <MessageView
            key={item.message.id}
            message={item.message}
            state={chat}
            grouped={false}
            filteredOut={filteredOut}
            searchQuery={q}
          />
        );
    }
  };
  return (
    <StepControlContext.Provider value={stepControl}>
      <div class="conversation-wrap">
        <div
          class="conversation"
          ref={ref}
          role="log"
          aria-label={label ?? t("appName")}
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
          {chat.messages.length === 0 &&
            (error && SETUP_ERROR_KINDS.has(error.kind) ? (
              <SetupWelcome error={error} />
            ) : (
              <div class="welcome">
                <h2>{t("welcomeTitle")}</h2>
                <p>{t("welcomeBody")}</p>
                {(status === "error" || status === "reconnecting") && <p class="welcome-hint">{t("setupHint")}</p>}
                {onSuggestedPrompt && (
                  <>
                    <p class="welcome-hint">{t("welcomeHint")}</p>
                    <div class="welcome-starters" aria-label={t("welcomeStarters")}>
                      <span class="welcome-starters-label">{t("welcomeStarters")}</span>
                      {[
                        { text: t("starterExplain"), enabled: !!hasActiveFile },
                        { text: t("starterBugs"), enabled: !!hasSelection },
                        { text: t("starterTests"), enabled: !!hasActiveFile },
                        { text: t("starterPlan"), enabled: !!hasActiveFile },
                      ]
                        .filter((starter) => starter.enabled)
                        .map((starter) => (
                          <button type="button" class="welcome-starter" key={starter.text} onClick={() => onSuggestedPrompt(starter.text)}>
                            {starter.text}
                          </button>
                        ))}
                      {!hasActiveFile && !hasSelection && <p class="welcome-hint">{t("starterAvailabilityHint")}</p>}
                    </div>
                  </>
                )}
              </div>
            ))}
          {items.map((item) => renderItem(item, query))}
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
    </StepControlContext.Provider>
  );
}

/**
 * Read-only drill-down into a child session. It reuses the very same `Conversation` as the main
 * chat but with the child's `ChatState`, so steps, tools, reasoning and report render identically.
 * No composer or host actions are wired: replies and prompts still belong to the parent chat.
 */
function SubagentModal({
  stack,
  entries,
  labels,
  subagents,
  parentTitle,
  onNavigate,
  onClose,
}: {
  stack: string[];
  entries: Record<string, SubagentEntry>;
  labels: Record<string, string>;
  subagents: SubagentState;
  parentTitle: string;
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
              <Conversation chat={entry.state} scrollToken={0} searchQuery="" label={t("subagentConversation")} />
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

/** Prompts the server has accepted but not delivered yet, with actions mirroring the API. */
function InboxPanel(props: {
  items: InboxItem[];
  onSendNow: (item: InboxItem) => void;
  onEdit: (item: InboxItem) => void;
  onRemove: (item: InboxItem) => void;
}) {
  const t = useT();
  return (
    <details class="panel inbox" open>
      <summary>
        <IconChevron class="chevron" />
        {t("inbox")} ({props.items.length})
      </summary>
      <ul>
        {props.items.map((item) => {
          const text = item.type === "user" ? (item.payload.text ?? "") : (item.payload.description ?? item.payload.text ?? item.type);
          const editable = item.type === "user" && typeof item.payload.text === "string";
          return (
            <li class="inbox-item" key={item.id}>
              <span class="inbox-text" title={text}>
                {text}
              </span>
              {item.delivery === "queue" && <span class="inbox-delivery">{t("inboxDeliveryQueue")}</span>}
              <span class="inbox-actions">
                {item.delivery === "queue" && (
                  <button
                    type="button"
                    class="icon-button tooltip-host"
                    data-tooltip={t("inboxSendNow")}
                    aria-label={t("inboxSendNow")}
                    onClick={() => props.onSendNow(item)}
                  >
                    <IconSend />
                  </button>
                )}
                {editable && (
                  <button
                    type="button"
                    class="icon-button tooltip-host"
                    data-tooltip={t("inboxEdit")}
                    aria-label={t("inboxEdit")}
                    onClick={() => props.onEdit(item)}
                  >
                    <IconEdit />
                  </button>
                )}
                <button
                  type="button"
                  class="icon-button tooltip-host"
                  data-tooltip={t("inboxRemove")}
                  aria-label={t("inboxRemove")}
                  onClick={() => props.onRemove(item)}
                >
                  <IconClose />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
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
  const additions = files.reduce((n, f) => n + (Number(f.additions) || 0), 0);
  const deletions = files.reduce((n, f) => n + (Number(f.deletions) || 0), 0);
  return (
    // `<summary>` stays the only child of `<details>` that toggles it: nesting buttons inside a
    // summary gives them unreliable keyboard/screen-reader semantics. The action row is a sibling.
    <div class="changes-panel">
      <details class="panel changes" open>
        <summary>
          <IconChevron class="chevron" />
          {files.length === 1 ? t("changedFile", files.length) : t("changedFiles", files.length)}
        </summary>
        <FileList files={files} applied />
      </details>
      <div class="changes-actions">
        <button
          type="button"
          class="icon-button view-all-changes"
          aria-label={t("viewAllChanges")}
          data-tooltip={t("viewAllChanges")}
          onClick={() =>
            post({
              type: "openDiffs",
              files: files.filter((f) => f.patch).map((f) => ({ file: f.file, patch: f.patch })),
            })
          }
        >
          <span class="adds">+{additions}</span>
          {additions > 0 && deletions > 0 ? " " : ""}
          {deletions > 0 && <span class="dels">-{deletions}</span>}
        </button>
        <button
          type="button"
          class="icon-button tooltip-host refresh-changes"
          data-tooltip={t("refresh")}
          aria-label={t("refresh")}
          onClick={() => post({ type: "refreshChanges" })}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          class="icon-button tooltip-host dismiss-changes"
          data-tooltip={t("dismissChanges")}
          aria-label={t("dismissChanges")}
          onClick={onDismiss}
        >
          <IconCheck />
        </button>
      </div>
    </div>
  );
}
