import type { FormField, FormValue } from "./api";

/**
 * True when every `when` rule of a form field holds for the current answers, i.e. the field should
 * be shown and answered. A field without rules always applies. Missing answers compare as "".
 * Shared by the chat's question cards and the Connect panel so both read OpenCode forms the same way.
 */
export function fieldApplies(field: FormField, values: Readonly<Record<string, FormValue | undefined>>): boolean {
  return (field.when ?? []).every((rule) => {
    const actual = values[rule.key] ?? "";
    return rule.op === "eq" ? actual === rule.value : actual !== rule.value;
  });
}
