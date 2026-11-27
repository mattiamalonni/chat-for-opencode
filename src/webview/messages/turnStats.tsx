import type { ModelInfo } from "../../shared/api";
import { type TurnStats } from "../../shared/chatReducer";
import { formatTokens } from "../../shared/format";

import { useT } from "../i18n";

import { post } from "../vscode";

let clockFormatter: Intl.DateTimeFormat | undefined;
let clockFormatterLang: string | undefined;
/** HH:mm in the webview locale; the host passes VS Code's language as `document.documentElement.lang`. */
function formatClock(ts: number): string {
  const lang = document.documentElement.lang || undefined;
  if (!clockFormatter || clockFormatterLang !== lang) {
    clockFormatter = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clockFormatterLang = lang;
  }
  return clockFormatter.format(new Date(ts));
}

/** Wall-clock time and total usage for a whole user turn, from input to the last step. */
export function TurnStatsRow({ stats, models }: { stats: TurnStats; models: ModelInfo[] }) {
  if (stats.ended === undefined) return null;
  return <StatsRow stats={stats} ended={stats.ended} models={models} />;
}

/** Has to be a component: `useT` is a hook. The guard above keeps unfinished turns invisible. */
function StatsRow({ stats, ended, models }: { stats: TurnStats; ended: number; models: ModelInfo[] }) {
  const t = useT();
  const total =
    stats.tokens && stats.tokens.input + stats.tokens.output + stats.tokens.reasoning + stats.tokens.cache.read + stats.tokens.cache.write;
  const elapsed = Math.max(0, ended - stats.started);

  let duration: string;
  const seconds = Math.round(elapsed / 100) / 10;
  if (seconds < 60) duration = t("turnDuration", seconds.toFixed(1));
  else {
    let minutes = Math.floor(seconds / 60);
    let rest = Math.round(seconds - minutes * 60);
    if (rest === 60) {
      minutes += 1;
      rest = 0;
    }
    duration = t("turnDurationMinutes", minutes, rest);
  }
  const startedAt = formatClock(stats.started);
  const endedAt = formatClock(ended);
  const usedModel = stats.model;
  const modelName =
    usedModel && usedModel.id && usedModel.providerID
      ? (models.find((m) => m.id === usedModel.id && m.providerID === usedModel.providerID)?.name ??
        `${usedModel.providerID}/${usedModel.id}`)
      : undefined;
  const steps = stats.steps && stats.steps > 0 ? (stats.steps === 1 ? t("stepCountOne") : t("stepCount", stats.steps)) : undefined;
  const tokens = total && total > 0 ? t("tokens", formatTokens(total)) : undefined;
  const cost = stats.cost !== undefined && stats.cost > 0 ? `$${stats.cost.toFixed(stats.cost < 0.01 ? 4 : 2)}` : undefined;
  const shown = [steps, duration, tokens, cost].filter((x): x is string => x !== undefined);
  const additions = stats.additions ?? 0;
  const deletions = stats.deletions ?? 0;
  const hasChanges = additions > 0 || deletions > 0;
  const openable = (stats.files ?? []).filter((f) => f.patch);
  // No visual tooltip on this bar; the label is only for screen readers.
  const summaryLabel = [
    t("turnStatsStarted", startedAt),
    t("turnStatsEnded", endedAt),
    modelName ? t("turnStatsModel", modelName) : undefined,
    t("turnStatsTooltip", duration, tokens ?? t("turnStatsUnknown"), cost ?? t("turnStatsUnknown"), steps ?? t("turnStatsUnknown")),
    hasChanges ? t("turnStatsChanges", additions, deletions) : undefined,
    openable.length > 0 ? t("turnStatsOpenDiff") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const counts = (
    <>
      {additions > 0 && <span class="adds">+{additions}</span>}
      {additions > 0 && deletions > 0 ? " " : ""}
      {deletions > 0 && <span class="dels">-{deletions}</span>}
    </>
  );
  return (
    <div class="turn-stats" role="group" aria-label={summaryLabel}>
      <span class="turn-stats-time" aria-hidden="true">
        {startedAt}
      </span>
      <span class="turn-stats-line" aria-hidden="true" />
      <span class="turn-stats-text">
        {modelName !== undefined && (
          <>
            <span class="turn-stats-model" title={modelName}>
              {modelName}
            </span>
            {shown.length > 0 ? " · " : ""}
          </>
        )}
        {shown.join(" · ")}
        {hasChanges && (
          <>
            {shown.length > 0 || modelName !== undefined ? " · " : ""}
            {openable.length > 0 ? (
              <button
                type="button"
                class="change-counts"
                aria-label={t("openDiff")}
                onClick={() => post({ type: "openDiffs", files: openable.map((f) => ({ file: f.file, patch: f.patch })) })}
              >
                {counts}
              </button>
            ) : (
              counts
            )}
          </>
        )}
      </span>
      <span class="turn-stats-line" aria-hidden="true" />
      <span class="turn-stats-time" aria-hidden="true">
        {endedAt}
      </span>
    </div>
  );
}
