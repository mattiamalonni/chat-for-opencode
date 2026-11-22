/** A FIFO-bounded Set. Used for caches whose entries are never revisited after a long session. */
export class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly limit: number) {}

  has(value: T): boolean {
    return this.items.has(value);
  }

  add(value: T): void {
    if (this.items.has(value)) return;
    if (this.items.size >= this.limit) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.add(value);
  }

  delete(value: T): boolean {
    return this.items.delete(value);
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}
