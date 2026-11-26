import type { OpenCodeClient } from "../client/http";
import type { SessionInfo, SessionMessage } from "../shared/api";
import { normalizeSessionInfo } from "../shared/adapter";
import { sessionLooksBusy, toSessionSummary } from "../shared/chatReducer";
import { mapWithConcurrency } from "../shared/concurrency";
import type { HostMessage, SessionSummary } from "../shared/protocol";
import { Generation } from "./generation";

/** A hit in a session title or in one of its messages, opened from the palette search. */
export interface SessionSearchResult {
  sessionId: string;
  title: string;
  snippet: string;
  messageId?: string;
  updated: number;
}

/** Collect all readable text out of an unknown wire value, for cross-session search snippets. */
function searchableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(searchableText).join(" ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "id" && key !== "sessionID")
      .map(([, v]) => searchableText(v))
      .join(" ");
  }
  return "";
}

/**
 * Owns the session picker's state: paging, busy/needs-input summaries, fork visibility and the
 * bounded search index. The controller keeps `loadSession` (the open conversation) and delegates
 * list work here, so an event burst can refresh the picker without touching the chat state machine.
 */
export class SessionListService {
  private items: SessionSummary[] = [];
  private cursor: string | undefined;
  private hasMore = false;
  private loadingMore = false;
  private readonly forks = new Set<string>();
  /**
   * Deep state (busy/error from history, needsInput from the live endpoints) needs HTTP calls per
   * session. Event bursts refresh the list many times per second, so reuse a short-lived result
   * while `time.updated` is unchanged.
   * The open session is always fetched: it is the one the user is looking at.
   */
  private readonly summaryCache = new Map<
    string,
    { updated: number; expires: number; busy: boolean; waiting: boolean; needsInput: boolean; error?: SessionSummary["error"] }
  >();
  private readonly forkInfoCache = new Map<string, { info: SessionInfo; expires: number }>();
  /**
   * Paging has its own generation: a sessions refresh must not invalidate the pages the user is
   * scrolling through. Conversely switching folders/resetting invalidates both.
   */
  private readonly pagingGeneration = new Generation();
  private refreshAbort?: AbortController;
  private pagingAbort?: AbortController;
  private searchAbort?: AbortController;

  /** Abort a search that has become irrelevant (new query, folder switch, controller dispose). */
  cancelSearch(): void {
    this.searchAbort?.abort();
    this.searchAbort = undefined;
  }

  constructor(
    private readonly client: () => OpenCodeClient | undefined,
    private readonly directory: () => string | undefined,
    private readonly sessionId: () => string | undefined,
    private readonly generation: Generation,
    private readonly post: (msg: HostMessage) => void,
    private readonly log: (line: string) => void,
    private readonly pageSize: () => number,
    private readonly folderName?: () => string | undefined,
    /** Whether a session's pending permissions would be granted automatically when it is opened. */
    private readonly autoApproves?: (sessionId: string) => boolean,
  ) {}

  private withFolder(summary: SessionSummary): SessionSummary {
    const folder = this.folderName?.();
    return folder ? { ...summary, folder } : summary;
  }

  addFork(id: string): void {
    this.forks.add(id);
  }

  forget(ids: Iterable<string>): void {
    const removed = new Set(ids);
    for (const id of removed) {
      this.forks.delete(id);
      this.summaryCache.delete(id);
      this.forkInfoCache.delete(id);
    }
    // Drop deleted rows immediately: a refresh that preserves loaded pages must not resurrect them.
    const before = this.items.length;
    this.items = this.items.filter((s) => !removed.has(s.id));
    if (this.items.length !== before) this.postSessions();
  }

  /** Drop the picker's loaded pages when the folder changes; the next refresh repopulates them. */
  reset(): void {
    this.refreshAbort?.abort();
    this.pagingAbort?.abort();
    this.cancelSearch();
    this.generation.bump();
    this.pagingGeneration.bump();
    this.items = [];
    this.cursor = undefined;
    this.hasMore = false;
    this.forks.clear();
    this.postSessions();
  }

  /** Title of a loaded session, used to label requests that arrive from other clients. */
  titleOf(id: string): string | undefined {
    return this.items.find((s) => s.id === id)?.title;
  }

  /** Keep the picker in sync after a rename; returns false when the id is not on a loaded page. */
  rename(id: string, title: string): boolean {
    if (!this.items.some((s) => s.id === id)) return false;
    this.items = this.items.map((s) => (s.id === id ? { ...s, title } : s));
    this.postSessions();
    return true;
  }

  private postSessions(): void {
    this.post({ type: "sessions", items: this.items, currentId: this.sessionId(), hasMore: this.hasMore });
  }

  private async toSummaries(sessions: SessionInfo[], signal?: AbortSignal): Promise<SessionSummary[]> {
    const client = this.client();
    const now = Date.now();
    return mapWithConcurrency(sessions, 6, async (info) => {
      const safe = normalizeSessionInfo(info) ?? info;
      const cached = this.summaryCache.get(info.id);
      if (cached && cached.updated === safe.time.updated && cached.expires > now && info.id !== this.sessionId()) {
        const summary: SessionSummary = {
          ...toSessionSummary(safe),
          busy: cached.busy,
          waiting: cached.waiting,
          needsInput: cached.needsInput,
        };
        if (cached.error) summary.error = cached.error;
        return this.withFolder(summary);
      }
      if (!client) return this.withFolder(toSessionSummary(safe));
      // Busy and error come from the history, so every session needs its messages — including the
      // ones whose busy/idle timestamps look settled (a failed turn can leave them stale). The live
      // endpoints are only needed for the pending permission/question badge, which is not part of
      // the history; skip them when the session cannot have a pending request.
      const deep = sessionLooksBusy(safe.time) || info.id === this.sessionId();
      const [messages, permissions, forms] = await Promise.all([
        client.messages(info.id, 2000, signal).catch(() => undefined),
        deep ? client.permissions(info.id, signal).catch(() => []) : [],
        deep ? client.forms(info.id, signal).catch(() => []) : [],
      ]);
      // Auto-approved permissions never reach the user, so they must not mark the row as waiting.
      // Questions always do: they are answered by the user even with auto-approval enabled.
      const needsInput = forms.length > 0 || (permissions.length > 0 && !this.autoApproves?.(info.id));
      const summary = toSessionSummary(safe, messages && messages, needsInput);
      if (this.summaryCache.size > 200) this.summaryCache.delete(this.summaryCache.keys().next().value as string);
      this.summaryCache.set(info.id, {
        updated: safe.time.updated,
        expires: Date.now() + 3000,
        busy: summary.busy,
        waiting: summary.waiting ?? false,
        needsInput: summary.needsInput,
        error: summary.error,
      });
      return this.withFolder(summary);
    });
  }

  async refresh(): Promise<void> {
    const client = this.client();
    const directory = this.directory();
    if (!client || !directory) return;
    // A new event burst supersedes the previous refresh: abort its requests instead of letting
    // dozens of stale fetches pile up behind it.
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;
    const signal = abort.signal;
    const token = this.generation.bump();
    try {
      const { items, next } = await client.listSessionsPage(directory, this.pageSize(), undefined, signal);
      // A server that omits `time` must not abort the whole refresh (caller would see an empty picker).
      const sessions = items.map((s) => normalizeSessionInfo(s) ?? s).filter((s) => !s.parentID && !s.time.archived);
      // Forks are child sessions, so they never appear in the parent-only page. Keep the ones this
      // window created visible at the top of the picker instead of losing them after a refresh.
      const forks: SessionInfo[] = [];
      const now = Date.now();
      for (const id of this.forks) {
        if (sessions.some((s) => s.id === id)) continue;
        const cached = this.forkInfoCache.get(id);
        const info =
          cached && cached.expires > now
            ? cached.info
            : await client
                .getSession(id, signal)
                .then((s) => normalizeSessionInfo(s) ?? s)
                .catch(() => undefined);
        if (info && !info.time.archived) {
          forks.push(info);
          if (info !== cached?.info) this.forkInfoCache.set(id, { info, expires: now + 30_000 });
        } else {
          this.forkInfoCache.delete(id);
        }
      }
      const summaries = await this.toSummaries([...forks, ...sessions], signal);
      if (!this.generation.is(token) || signal.aborted) return;
      // Preserve pages the user already loaded: the first page is authoritative for the sessions it
      // contains, but a refresh must not throw away the rest of the picker mid-scroll.
      const freshIds = new Set(summaries.map((s) => s.id));
      // With no next page the server has given us the whole list, so any previously loaded row that
      // is absent here was deleted (e.g. delete-all) and must not survive the merge.
      this.items = next ? [...summaries, ...this.items.filter((s) => !freshIds.has(s.id))] : summaries;
      if (!next || this.items.length <= this.pageSize()) {
        this.cursor = next;
        this.hasMore = !!next;
      }
      this.postSessions();
    } catch (err) {
      if (!signal.aborted) this.log(`[chat] failed to refresh sessions: ${String(err)}`);
    } finally {
      if (this.refreshAbort === abort) this.refreshAbort = undefined;
    }
  }

  /** Appends the next page without discarding the ones already loaded. */
  async loadMore(): Promise<void> {
    const client = this.client();
    const directory = this.directory();
    if (!client || !directory || !this.cursor || this.loadingMore) return;
    this.loadingMore = true;
    // Use the paging generation, not the refresh one: event bursts refresh the picker constantly,
    // and invalidates every "Load more" click before it can publish its page.
    const token = this.pagingGeneration.bump();
    this.pagingAbort?.abort();
    const abort = new AbortController();
    this.pagingAbort = abort;
    try {
      const { items, next } = await client.listSessionsPage(directory, this.pageSize(), this.cursor, abort.signal);
      const known = new Set(this.items.map((s) => s.id));
      const fresh: SessionInfo[] = [];
      for (const raw of items) {
        const s = normalizeSessionInfo(raw) ?? raw;
        if (s.parentID || s.time.archived || known.has(s.id)) continue;
        known.add(s.id);
        fresh.push(s);
      }
      const summaries = await this.toSummaries(fresh, abort.signal);
      if (!this.pagingGeneration.is(token) || abort.signal.aborted) return;
      this.items.push(...summaries);
      this.cursor = next;
      this.hasMore = !!next;
      this.postSessions();
    } catch (err) {
      if (!abort.signal.aborted) this.log(`[chat] failed to load more sessions: ${String(err)}`);
    } finally {
      this.loadingMore = false;
      if (this.pagingAbort === abort) this.pagingAbort = undefined;
    }
  }

  /**
   * Explicit user search over titles and message bodies, bounded to the first pages.
   * A newer query (or a folder switch) aborts the previous search: without this, up to 200 history
   * fetches kept running after the Quick Pick was dismissed.
   */
  async search(query: string, maxSessions = 200): Promise<SessionSearchResult[]> {
    const client = this.client();
    const directory = this.directory();
    const needle = query.trim().toLowerCase();
    if (!client || !directory || !needle) return [];
    this.cancelSearch();
    const abort = new AbortController();
    this.searchAbort = abort;
    const signal = abort.signal;
    const results: SessionSearchResult[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      while (seen.size < maxSessions && !signal.aborted) {
        if (cursor && cursors.has(cursor)) break;
        if (cursor) cursors.add(cursor);
        const page = await client
          .listSessionsPage(directory, 100, cursor, signal)
          .catch(() => ({ items: [] as SessionInfo[], next: undefined as string | undefined }));
        if (signal.aborted) return [];
        const candidates = page.items
          .map((raw) => normalizeSessionInfo(raw) ?? raw)
          .filter((info) => !info.parentID && !info.time.archived && !seen.has(info.id));
        for (const info of candidates) seen.add(info.id);
        const hits = await mapWithConcurrency(candidates, 6, async (info): Promise<SessionSearchResult | undefined> => {
          const title = info.title ?? "";
          if (title.toLowerCase().includes(needle)) {
            return { sessionId: info.id, title: title || "(untitled)", snippet: "Title match", updated: info.time.updated };
          }
          const messages = await client.messages(info.id, 200, signal).catch(() => [] as SessionMessage[]);
          const match = messages.find((m) => searchableText(m).toLowerCase().includes(needle));
          if (!match) return undefined;
          const text = searchableText(match);
          const at = text.toLowerCase().indexOf(needle);
          return {
            sessionId: info.id,
            title: title || "(untitled)",
            snippet: text.slice(Math.max(0, at - 40), at + needle.length + 60).trim(),
            messageId: match.id,
            updated: info.time.updated,
          };
        });
        if (signal.aborted) return [];
        results.push(...hits.filter((hit): hit is SessionSearchResult => hit !== undefined));
        if (!page.next || page.items.length === 0) break;
        cursor = page.next;
      }
      return results.sort((a, b) => b.updated - a.updated);
    } finally {
      if (this.searchAbort === abort) this.searchAbort = undefined;
    }
  }
}
