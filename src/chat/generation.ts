/**
 * Monotonic token for invalidating in-flight async work. Every stale check in the controller used
 * to be a hand-managed number; centralising it makes the intent explicit and keeps callers from
 * comparing two different counters by accident.
 */
export class Generation {
  private value = 0;

  /** Invalidates all previously issued tokens and returns the new one. */
  bump(): number {
    return ++this.value;
  }

  current(): number {
    return this.value;
  }

  is(token: number): boolean {
    return token === this.value;
  }
}
