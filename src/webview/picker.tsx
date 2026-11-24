import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { isolateKeys } from "./env";
import { IconCheck, IconChevron } from "./icons";

export interface PickerItem {
  value: string;
  label: string;
  description?: string;
  group?: string;
  /** Short right-aligned detail, e.g. the context window size. */
  meta?: string;
  metaLabel?: string;
}

export interface PickerProps {
  /** Accessible name of the trigger (e.g. "Model"). */
  label: string;
  items: PickerItem[];
  value?: string;
  onChange: (value: string) => void;
  /** Shown in the trigger; defaults to the selected item's label. */
  display?: ComponentChildren;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  icon?: ComponentChildren;
  class?: string;
  /** Opens above the trigger (composer toolbar) or below (header). */
  placement?: "top" | "bottom";
  /** Bumping this opens the popup; used by the Cmd/Ctrl+M shortcut for the model picker. */
  openToken?: number;
  /** Keep the trigger in the DOM for focus/keyboard handling, but hide it (chord-opened pickers). */
  hideTrigger?: boolean;
  /** Called after a selection, so the host view can move focus somewhere else than the trigger. */
  onSelected?: () => void;
}

let uid = 0;

/** Custom dropdown (button + popup listbox) themed with VS Code variables, replacing native <select>. */
export function Picker(props: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [shift, setShift] = useState(0);
  const id = useMemo(() => `picker-${++uid}`, []);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.items;
    return props.items.filter((i) => `${i.label} ${i.value} ${i.group ?? ""} ${i.description ?? ""}`.toLowerCase().includes(q));
  }, [props.items, query]);

  const selected = props.items.find((i) => i.value === props.value);

  const close = (focusTrigger = true) => {
    setOpen(false);
    setQuery("");
    if (focusTrigger) trigger.current?.focus();
  };

  const openPopup = () => {
    setOpen(true);
    setQuery("");
    const idx = props.items.findIndex((i) => i.value === props.value);
    setActive(idx >= 0 ? idx : 0);
  };

  const choose = (item: PickerItem | undefined) => {
    if (!item) return;
    if (item.value !== props.value) props.onChange(item.value);
    close();
    // After `close` focused the trigger: a caller can move focus to the composer instead.
    props.onSelected?.();
  };

  // Keep the popup inside the (narrow) webview horizontally.
  useLayoutEffect(() => {
    if (!open || !popup.current) return;
    popup.current.style.marginLeft = "";
    const rect = popup.current.getBoundingClientRect();
    const overflow = rect.right - (document.documentElement.clientWidth - 6);
    setShift(overflow > 0 ? -Math.min(overflow, rect.left - 6) : 0);
  }, [open, filtered.length]);

  useLayoutEffect(() => {
    if (open) (props.searchable ? search.current : list.current)?.focus();
  }, [open]);

  const lastOpenToken = useRef(props.openToken ?? 0);
  useLayoutEffect(() => {
    const token = props.openToken ?? 0;
    if (token === lastOpenToken.current) return;
    lastOpenToken.current = token;
    if (token === 0) return;
    if (open) (props.searchable ? search.current : list.current)?.focus();
    else openPopup();
  }, [props.openToken]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKeyDown = (e: KeyboardEvent) => {
    isolateKeys(e);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => Math.min(filtered.length - 1, a + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case "Home":
        if (!props.searchable) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (!props.searchable) {
          e.preventDefault();
          setActive(filtered.length - 1);
        }
        break;
      case "Enter":
        e.preventDefault();
        choose(filtered[active]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  let lastGroup: string | undefined;
  const listId = `${id}-list`;

  return (
    <div class={`picker ${props.class ?? ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        class={`picker-trigger${open ? " open" : ""}${props.hideTrigger ? " hidden-trigger" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${props.label}: ${selected?.label ?? props.placeholder ?? ""}`}
        title={selected ? `${props.label}: ${selected.description ?? selected.label}` : props.label}
        onClick={() => (open ? close() : openPopup())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openPopup();
          }
        }}
      >
        {props.icon}
        <span class="picker-value">{props.display ?? selected?.label ?? props.placeholder}</span>
        <IconChevron class="picker-chevron" />
      </button>
      {open && (
        <div
          ref={popup}
          class={`picker-popup ${props.placement === "bottom" ? "below" : "above"}`}
          style={shift ? { marginLeft: `${shift}px` } : undefined}
          onKeyDown={onKeyDown}
        >
          {props.searchable && (
            <input
              ref={search}
              class="picker-search"
              type="text"
              role="combobox"
              aria-label={props.searchPlaceholder ?? props.label}
              aria-controls={listId}
              aria-expanded="true"
              aria-activedescendant={filtered.length ? `${id}-opt-${active}` : undefined}
              placeholder={props.searchPlaceholder}
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
          )}
          <ul
            ref={list}
            id={listId}
            class="picker-list"
            role="listbox"
            aria-label={props.label}
            tabIndex={props.searchable ? -1 : 0}
            aria-activedescendant={!props.searchable && filtered.length ? `${id}-opt-${active}` : undefined}
          >
            {filtered.length === 0 && <li class="picker-empty">{props.emptyText ?? "—"}</li>}
            {filtered.map((item, i) => {
              const header = item.group && item.group !== lastGroup ? item.group : undefined;
              lastGroup = item.group;
              const isSelected = item.value === props.value;
              return (
                <Fragment key={item.value}>
                  {header && (
                    <li class="picker-group" role="presentation">
                      {header}
                    </li>
                  )}
                  <li
                    id={`${id}-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    class={`picker-option${i === active ? " active" : ""}${isSelected ? " selected" : ""}`}
                    onMouseMove={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(item);
                    }}
                  >
                    <span class="picker-check">{isSelected && <IconCheck />}</span>
                    <span class="picker-text">
                      <span class="picker-label">{item.label}</span>
                      {item.description && <span class="picker-desc">{item.description}</span>}
                    </span>
                    {item.meta && (
                      <span class="picker-meta" title={item.metaLabel}>
                        <span aria-hidden="true">{item.meta}</span>
                        {item.metaLabel && <span class="sr-only">{item.metaLabel}</span>}
                      </span>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
