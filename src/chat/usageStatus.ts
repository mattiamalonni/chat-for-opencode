import type { TokenUsage } from "../shared/api";
import { contextTokensOf } from "../shared/chatReducer";
import { formatTokens } from "../shared/format";
import type { HostMessage } from "../shared/protocol";

export interface SessionUsage {
  cost: number;
  tokens: TokenUsage;
}

/** Resyncs can omit usage; that must not blank a bar that was already showing a number. */
export type UsageUpdate = { kind: "set"; usage: SessionUsage } | { kind: "clear" } | { kind: "keep" };

export function usageUpdateFromMessage(msg: HostMessage): UsageUpdate {
  if (msg.type === "session") {
    if (!msg.session) return { kind: "clear" };
    return msg.session.usage ? { kind: "set", usage: msg.session.usage } : { kind: "keep" };
  }
  if (msg.type === "sessionDelta") {
    return msg.delta.usage ? { kind: "set", usage: msg.delta.usage } : { kind: "keep" };
  }
  return { kind: "keep" };
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) return "$0";
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** Compact version for the bar itself; the tooltip carries the breakdown. */
export function usageLabel(usage: SessionUsage): string {
  const tokens = contextTokensOf(usage.tokens);
  const parts: string[] = [];
  if (tokens !== undefined) parts.push(formatTokens(tokens));
  if (usage.cost > 0 || tokens === undefined) parts.push(formatCost(usage.cost));
  return `$(graph) ${parts.join(" · ")}`;
}

export function usageTooltip(usage: SessionUsage, t: (message: string) => string): string {
  const { tokens, cost } = usage;
  const count = (value: number): string => value.toLocaleString("en-US");
  return [
    `${t("Session cost")}: ${formatCost(cost)}`,
    `${t("Tokens in context (estimate)")}: ${contextTokensOf(tokens) === undefined ? "?" : count(contextTokensOf(tokens)!)}`,
    `${t("Input")}: ${count(tokens.input)} · ${t("Output")}: ${count(tokens.output)} · ${t("Reasoning")}: ${count(tokens.reasoning)}`,
    `${t("Cache read")}: ${count(tokens.cache.read)} · ${t("Cache write")}: ${count(tokens.cache.write)}`,
    t("Click to open the chat"),
  ].join("\n");
}
