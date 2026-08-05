"use client";
import { useId, useMemo, useState } from "react";

/**
 * A type-ahead over a small, already-loaded vocabulary that also IS the field —
 * the posted input is the combobox input itself, so a value absent from the
 * list stays fully submittable.
 *
 * WHY NOT <datalist>: it does not render on mobile browsers, and these forms are
 * used from phones. This is the same control in markup we own.
 *
 * WHY NOT ContactCombobox: that one searches server-side because the contact
 * book is PII and unbounded. These are five short public catalogue vocabularies
 * (~170 strings in total), so the options arrive as a prop and filtering is
 * local — no debounce, no request-race guard, no round trip, and suggestions
 * appear on the first keystroke. The markup, ARIA and keyboard handling are
 * deliberately identical so the two controls feel like one idea.
 *
 * Uncontrolled from the parent's point of view: it owns its text state and
 * posts through `name`, so a form does not have to become controlled to use it.
 */
export function SuggestCombobox({
  id,
  name,
  options,
  defaultValue = "",
  required = false,
  placeholder,
  inputMode,
  maxVisible = 8,
}: {
  id?: string;
  name: string;
  options: string[];
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  inputMode?: "email" | "text";
  maxVisible?: number;
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  // `null` means "not navigated" — distinct from index 0, so a first Enter while
  // merely typing submits the form instead of picking the top suggestion.
  const [active, setActive] = useState<number | null>(null);
  const listId = useId();

  const q = value.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? options.filter((o) => o.toLowerCase().includes(q)) : options).slice(0, maxVisible),
    [options, q, maxVisible]
  );

  // An empty query lists the first `maxVisible` options on focus. That is what
  // makes the control useful to someone who does not yet know what the
  // vocabulary contains — the actual problem on a field like Category.
  const show = open && shown.length > 0;
  // Clamp: `shown` can shrink under a stale `active` between renders.
  const activeIndex = active === null ? null : Math.min(active, Math.max(shown.length - 1, 0));

  const pick = (v: string) => {
    setValue(v);
    setOpen(false);
    setActive(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i === null ? 0 : (Math.min(i, shown.length - 1) + 1) % shown.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        i === null ? shown.length - 1 : (Math.min(i, shown.length - 1) - 1 + shown.length) % shown.length
      );
    } else if (e.key === "Enter") {
      // Only swallow Enter while a suggestion is genuinely highlighted. Otherwise
      // let it through so the form submits whatever was typed.
      if (activeIndex === null) return;
      e.preventDefault();
      pick(shown[activeIndex]);
    } else if (e.key === "Escape") {
      // Clearing `active` is load-bearing: onFocus reopens the list, so a
      // surviving highlight would let the next Enter pick a dismissed option.
      setOpen(false);
      setActive(null);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        className="input"
        name={name}
        role="combobox"
        aria-expanded={show}
        aria-controls={show ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={show && activeIndex !== null ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        inputMode={inputMode}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />

      {show && (
        <ul
          id={listId}
          role="listbox"
          className="card"
          style={{
            position: "absolute", zIndex: 20, insetInlineStart: 0, insetInlineEnd: 0,
            marginBlockStart: 4, maxHeight: 260, overflowY: "auto", padding: 4, listStyle: "none",
          }}
          // mousedown fires before the input's blur, so preventing default here
          // stops the blur (and the close) — the click then lands on the option.
          onMouseDown={(e) => e.preventDefault()}
        >
          {shown.map((o, i) => (
            <li
              key={o}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}
              style={{
                // min-height, not padding alone: a 6px-padded row is a ~22px tap
                // target on a phone, under this app's documented 44px floor.
                minHeight: "var(--tap)", display: "flex", alignItems: "center",
                padding: "6px 8px", cursor: "pointer", borderRadius: "var(--ledger-radius-sm)",
                background: i === activeIndex ? "var(--surface-2)" : undefined,
              }}
            >
              {o}
            </li>
          ))}
        </ul>
      )}

      <div aria-live="polite" role="status" className="sr-only">
        {show ? `${shown.length} suggestion${shown.length === 1 ? "" : "s"} available.` : ""}
      </div>
    </div>
  );
}
