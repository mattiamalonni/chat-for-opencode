import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { makeTranslator, STRINGS, type StringKey, type Strings } from "../shared/strings";

export const StringsContext = createContext<Strings>({ ...STRINGS });

export function useT(): (key: StringKey, ...args: (string | number)[]) => string {
  const strings = useContext(StringsContext);
  return makeTranslator(strings);
}
