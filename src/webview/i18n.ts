import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { STRINGS, format, type StringKey, type Strings } from "../shared/strings";

export const StringsContext = createContext<Strings>({ ...STRINGS });

export function useT(): (key: StringKey, ...args: (string | number)[]) => string {
  const strings = useContext(StringsContext);
  return (key, ...args) => format(strings[key] ?? STRINGS[key], ...args);
}
