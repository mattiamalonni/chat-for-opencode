import type { OpenCodeClient } from "../client/http";
import type { SessionInfo } from "../shared/api";

/**
 * Maps session ids to the workspace directory that owns them.
 *
 * The extension shares one OpenCode endpoint across windows, so the event stream carries sessions
 * from every project. Each chat must process only the sessions of its own workspace: without this
 * gate, a permission asked in another window is rendered as an approval card here as well.
 */
const MAX_SESSIONS = 1000;
const PRIME_TTL_MS = 5000;

interface SessionLike {
  id?: string;
  sessionID?: string;
  parentID?: string;
  directory?: string;
  location?: { directory?: string };
}

function asSessionLike(raw: unknown): SessionLike | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as SessionLike) : undefined;
}

export class SessionOwnershipService {
  private readonly dirById = new Map<string, string>();
  private readonly resolving = new Set<string>();
  private lastPrime = 0;
  private priming: Promise<void> | undefined;

  constructor(
    private readonly client: () => OpenCodeClient | undefined,
    private readonly directory: () => string | undefined,
    private readonly sessionId: () => string | undefined,
    private readonly log: (line: string) => void,
  ) {}

  private normalize(dir: string): string {
    const trimmed = dir.replace(/\/+$/, "");
    return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
  }

  /**
   * Learn a session's directory. A child inherits it from its parent (including the open session,
   * whose directory is the current folder), so `session.created` events register children before
   * their first permission request arrives.
   */
  learn(raw: unknown): void {
    const o = asSessionLike(raw);
    if (!o) return;
    const id = typeof o.id === "string" ? o.id : typeof o.sessionID === "string" ? o.sessionID : undefined;
    if (!id) return;
    const directory =
      typeof o.directory === "string" ? o.directory : typeof o.location?.directory === "string" ? o.location.directory : undefined;
    const parentID = typeof o.parentID === "string" ? o.parentID : undefined;
    const inherited = parentID === this.sessionId() ? this.directory() : parentID ? this.dirById.get(parentID) : undefined;
    const dir = directory ?? inherited ?? (id === this.sessionId() ? this.directory() : undefined);
    if (!dir) return;
    this.dirById.set(id, this.normalize(dir));
    if (this.dirById.size > MAX_SESSIONS) this.dirById.delete(this.dirById.keys().next().value as string);
  }

  forget(id: string): void {
    this.dirById.delete(id);
  }

  reset(): void {
    this.dirById.clear();
    this.resolving.clear();
    this.lastPrime = 0;
  }

  /** Whether an event for `id` belongs to this workspace. Unknown ids are resolved asynchronously. */
  owns(id: string): boolean {
    if (id === this.sessionId()) return true;
    const current = this.directory();
    // No folder means no workspace-scoped server; keep the previous pass-through behaviour.
    if (!current) return true;
    const known = this.dirById.get(id);
    if (known !== undefined) return known === this.normalize(current);
    this.resolve(id);
    return false;
  }

  private resolve(id: string): void {
    if (this.resolving.has(id)) return;
    const client = this.client();
    if (!client) return;
    this.resolving.add(id);
    void client
      .getSession(id)
      .then((info) => this.learn(info))
      .catch((err: unknown) => this.log(`[chat] session ownership lookup failed for ${id}: ${String(err)}`))
      .finally(() => this.resolving.delete(id));
  }

  /**
   * Learn every session the server knows, including sessions of other workspaces: those must be
   * recognised as foreign before their first event is routed.
   */
  async prime(): Promise<void> {
    const now = Date.now();
    if (this.priming) return this.priming;
    if (now - this.lastPrime < PRIME_TTL_MS) return;
    const client = this.client();
    if (!client) return;
    this.lastPrime = now;
    const task = (async () => {
      const sessions = await client.listSessions(undefined, 100).catch(() => [] as SessionInfo[]);
      for (const info of sessions) this.learn(info);
    })();
    this.priming = task;
    try {
      await task;
    } finally {
      this.priming = undefined;
    }
  }
}
