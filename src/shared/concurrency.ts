/**
 * Run async work over a list with a bounded number of concurrent workers.
 *
 * The session picker used to fire `Promise.all` over every session and up to three requests each on
 * every event burst. With dozens of busy sessions that is hundreds of parallel HTTP requests. A
 * small pool keeps the same result order and keeps the server (and the extension host) responsive.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
