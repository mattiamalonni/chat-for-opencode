/**
 * Compact rendering for synthetic messages OpenCode injects into a session (goal/watch wake-ups,
 * plan reminders, injected instructions, plain notices). They used to be dropped live and dumped as
 * raw XML on resync. The full text stays available behind a details expander.
 */

export interface SyntheticNotice {
  /** One-line, readable summary. */
  text: string;
  /** Full text when it differs from the summary; undefined means nothing is hidden. */
  detail?: string;
  /** Whether this synthetic makes the agent continue without a user prompt. */
  autoResume: boolean;
}

const MAX_TEXT = 180;

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function oneLine(value: string): string {
  return decode(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function syntheticNotice(text: string | undefined, description?: string, metadata?: Record<string, unknown>): SyntheticNotice {
  const full = text ?? "";
  const source = description && description.length <= MAX_TEXT ? description : full;
  const compact = oneLine(source);
  const shown = compact.length > MAX_TEXT ? `${compact.slice(0, MAX_TEXT - 1)}…` : compact;
  return {
    text: shown || "OpenCode notice",
    detail: full && full !== shown ? full : undefined,
    autoResume: metadata?.resume === true,
  };
}
