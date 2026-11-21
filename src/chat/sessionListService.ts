import type { OpenCodeClient } from "../client/http";
import type { SessionInfo, SessionMessage } from "../shared/api";
import { normalizeSessionInfo } from "../shared/adapter";
import { sessionLooksBusy, toSessionSummary } from "../shared/chatReducer";
import type { HostMessage, SessionSummary } from "../shared/protocol";
import type { Generation } from "./generation";

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
   * Deep state (busy/needsInput) needs three HTTP calls per busy session. Event bursts refresh the
   * list many times per second, so reuse a short-lived result while `time.updated` is unchanged.
   * The open session is always fetched: it is the one the user is looking at.
   */
  private readonly summaryCache = new Map<string, { updated: number; expires: number; busy: boolean; needsInput: boolean }>();
  private readonly forkInfoCache = new Map<string, { info: SessionInfo; expires: number }>();

  constructor(
    private readonly client: () => OpenCodeClient | undefined,
    private readonly directory: () => string | undefined,
    private readonly sessionId: () => string | undefined,
    private readonly generation: Generation,
    private readonly post: (msg: HostMessage) => void,
    private readonly log: (line: string) => void,
    private readonly pageSize: () => number,
  ) {}

  addFork(id: string): void {
    this.forks.add(id);
  }

  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      this.forks.delete(id);
      this.summaryCache.delete(id);
      this.forkInfoCache.delete(id);
    }
  }

  /** Drop the picker's loaded pages when the folder changes; the next refresh repopulates them. */
  reset(): void {
    this.items = [];
    this.cursor = undefined;
    this.hasMore = false;
    this.forks.clear();
    this.postSessions();
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

  private async toSummaries(sessions: SessionInfo[]): Promise<SessionSummary[]> {
    const client = this.client();
    const now = Date.now();
    return Promise.all(
      sessions.map(async (info) => {
        const safe = normalizeSessionInfo(info) ?? info;
        if (!client || !sessionLooksBusy(safe.time)) return toSessionSummary(safe);
        const cached = this.summaryCache.get(info.id);
        if (cached && cached.updated === safe.time.updated && cached.expires > now && info.id !== this.sessionId()) {
          return { ...toSessionSummary(safe), busy: cached.busy, needsInput: cached.needsInput };
        }
        const [messages, permissions, forms] = await Promise.all([
          client.messages(info.id).catch(() => undefined),
          client.permissions(info.id).catch(() => []),
          client.forms(info.id).catch(() => []),
        ]);
        const summary = toSessionSummary(safe, messages && messages, permissions.length > 0 || forms.length > 0);
        if (this.summaryCache.size > 200) this.summaryCache.delete(this.summaryCache.keys().next().value as string);
        this.summaryCache.set(info.id, { updated: safe.time.updated, expires: Date.now() + 3000, busy: summary.busy, needsInput: summary.needsInput });
        return summary;
      }),
    );
  }

  async refresh(): Promise<void> {
    const client = this.client();
    const directory = this.directory();
    if (!client || !directory) return;
    const token = this.generation.bump();
    const { items, next } = await client.listSessionsPage(directory, this.pageSize());
    // A server that omits `time` must not abort the whole refresh (the caller would see an empty picker).
    const sessions = items.map((s) => normalizeSessionInfo(s) ?? s).filter((s) => !s.parentID && !s.time.archived);
    // Forks are child sessions, so they never appear in the parent-only page. Keep the ones this
    // window created visible at the top of the picker instead of losing them after a refresh.
    const forks: SessionInfo[] = [];
    const now = Date.now();
    for (const id of this.forks) {
      if (sessions.some((s) => s.id === id)) continue;
      const cached = this.forkInfoCache.get(id);
      const info = cached && cached.expires > now
        ? cached.info
        : await client.getSession(id).then((s) => normalizeSessionInfo(s) ?? s).catch(() => undefined);
      if (info && !info.time.archived) {
        forks.push(info);
        if (info !== cached?.info) this.forkInfoCache.set(id, { info, expires: now + 30_000 });
      } else {
        this.forkInfoCache.delete(id);
      }
    }
    const summaries = await this.toSummaries([...forks, ...sessions]);
    if (!this.generation.is(token)) return;
    this.items = summaries;
    this.cursor = next;
    this.hasMore = !!next;
    this.postSessions();
  }

  /** Appends the next page without discarding the ones already loaded. */
  async loadMore(): Promise<void> {
    const client = this.client();
    const directory = this.directory();
    if (!client || !directory || !this.cursor || this.loadingMore) return;
    this.loadingMore = true;
    const token = this.generation.current();
    try {
      const { items, next } = await client.listSessionsPage(directory, this.pageSize(), this.cursor);
      const known = new Set(this.items.map((s) => s.id));
      const fresh: SessionInfo[] = [];
      for (const raw of items) {
        const s = normalizeSessionInfo(raw) ?? raw;
        if (s.parentID || s.time.archived || known.has(s.id)) continue;
        known.add(s.id);
        fresh.push(s);
      }
      const summaries = await this.toSummaries(fresh);
      if (!this.generation.is(token)) return;
      this.items.push(...summaries);
      this.cursor = next;
      this.hasMore = !!next;
      this.postSessions();
    } catch (err) {
      this.log(`[chat] failed to load more sessions: ${String(err)}`);
    } finally {
      this.loadingMore = false;
    }
  }

  /** Explicit user search over titles and message bodies, bounded to the first pages. */
  async search(query: string, maxSessions = 200): Promise<SessionSearchResult[]> {
    const client = this.client();
    const directory = this.directory();
    const needle = query.trim().toLowerCase();
    if (!client || !directory || !needle) return [];
    const results: SessionSearchResult[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    while (seen.size < maxSessions) {
      if (cursor && cursors.has(cursor)) break;
      if (cursor) cursors.add(cursor);
      const page = await client.listSessionsPage(directory, 100, cursor).catch(() => ({ items: [] as SessionInfo[], next: undefined as string | undefined }));
      for (const raw of page.items) {
        const info = normalizeSessionInfo(raw) ?? raw;
        if (info.parentID || info.time.archived || seen.has(info.id)) continue;
        seen.add(info.id);
        const title = info.title ?? "";
        if (title.toLowerCase().includes(needle)) {
          results.push({ sessionId: info.id, title: title || "(untitled)", snippet: "Title match", updated: info.time.updated });
          continue;
        }
        const messages = await client.messages(info.id, 200).catch(() => [] as SessionMessage[]);
        const match = messages.find((m) => searchableText(m).toLowerCase().includes(needle));
        if (!match) continue;
        const text = searchableText(match);
        const at = text.toLowerCase().indexOf(needle);
        results.push({
          sessionId: info.id,
          title: title || "(untitled)",
          snippet: text.slice(Math.max(0, at - 40), at + needle.length + 60).trim(),
          messageId: match.id,
          updated: info.time.updated,
        });
      }
      if (!page.next || page.items.length === 0) break;
      cursor = page.next;
    }
    return results.sort((a, b) => b.updated - a.updated);
  }
}
