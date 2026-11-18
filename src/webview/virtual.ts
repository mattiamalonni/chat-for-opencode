/**
 * A conservative, dependency-free window over a long list. `end` is exclusive.
 *
 * The webview uses an estimated row height because message heights are only known after layout:
 * the caller reserves the space before/after the window so the scrollbar stays roughly stable.
 * This function is pure so it can be tested without a browser.
 */
export interface VisibleRange {
  start: number;
  end: number;
}

export function visibleRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  estimatedRowHeight: number,
  overscan: number,
): VisibleRange {
  if (count <= 0) return { start: 0, end: 0 };
  const row = Math.max(1, estimatedRowHeight);
  const pad = Math.max(0, Math.floor(overscan));
  const first = Math.floor(Math.max(0, scrollTop) / row) - pad;
  const start = Math.max(0, Math.min(count - 1, first));
  const visible = Math.ceil(Math.max(0, viewportHeight) / row) + pad * 2;
  const end = Math.min(count, start + Math.max(1, visible));
  return { start, end };
}
