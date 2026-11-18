/**
 * Rough token cost of an inline `data:` attachment, using ~4 characters per token. Only the
 * base64 payload is counted; it is an estimate, shown with a "~" in the context meter.
 */
export function estimateDataUrlTokens(uri: string | undefined): number {
  if (!uri?.startsWith("data:")) return 0;
  const comma = uri.indexOf(",");
  if (comma < 0) return 0;
  // base64 length * 3/4 = decoded bytes; /4 = tokens.
  return Math.ceil((uri.length - comma - 1) * 0.1875);
}

/** Compact token count: 950, 8.5K, 128K, 1M, 1.5M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const [value, unit] = n >= 999_500 ? [n / 1_000_000, "M"] : [n / 1000, "K"];
  const text = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  return text + unit;
}
