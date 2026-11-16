/** Compact token count: 950, 8.5K, 128K, 1M, 1.5M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const [value, unit] = n >= 999_500 ? [n / 1_000_000, "M"] : [n / 1000, "K"];
  const text = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  return text + unit;
}
