import { formatTokens } from "../shared/format";
import { useT } from "./i18n";

const R = 7;
const C = 2 * Math.PI * R;

/** Ring showing how much of the selected model's context window the conversation uses. */
export function ContextMeter({ used, limit, cost }: { used?: number; limit: number; cost?: number }) {
  const t = useT();
  const known = used !== undefined;
  const ratio = known ? Math.min(1, used / limit) : 0;
  const percent = known ? Math.round((used / limit) * 100) : 0;
  const level = !known ? "unknown" : ratio >= 0.9 ? "critical" : ratio >= 0.75 ? "high" : "normal";
  const usage = known
    ? t("contextUsage", formatTokens(used), formatTokens(limit), percent)
    : t("contextUsageUnknown", formatTokens(limit));
  const label = cost === undefined ? usage : `${usage} · ${t("sessionCost", `$${cost.toFixed(2)}`)}`;
  return (
    <span class={`context-meter ${level} tooltip-host tooltip-above`} role="img" aria-label={label} data-tooltip={label}>
      <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
        <circle class="track" cx="9" cy="9" r={R} />
        <circle
          class="fill"
          cx="9"
          cy="9"
          r={R}
          stroke-dasharray={`${C * ratio} ${C}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      {known && <span class="context-percent" aria-hidden="true">{percent}%</span>}
    </span>
  );
}
