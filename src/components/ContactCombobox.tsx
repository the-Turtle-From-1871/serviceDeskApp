"use client";
import { useId, useMemo, useState } from "react";
import { matchContacts, type ContactOption } from "@/modules/contacts/contact-match";

// A type-ahead over the contact book that also IS the name field — the posted
// `name` input is the combobox input itself, so a receipt can still be filled by
// typing a recipient who isn't in the book.
//
// The whole book arrives with the page (see receipts/new/page.tsx), so filtering
// is synchronous and local: no fetch per keystroke, and therefore no debounce,
// no request race guard, and no stale-response handling to get wrong.
export function ContactCombobox({
  id,
  name,
  contacts,
  value,
  onValueChange,
  onPick,
}: {
  id?: string;
  name: string;
  contacts: ContactOption[];
  value: string;
  onValueChange: (v: string) => void;
  onPick: (c: ContactOption) => void;
}) {
  const [open, setOpen] = useState(false);
  // `null` means "not navigated": the user hasn't pressed ArrowUp/ArrowDown or
  // hovered an option yet. Distinct from index 0, so a first Enter press while
  // merely typing doesn't get mistaken for "a suggestion is highlighted".
  const [active, setActive] = useState<number | null>(null);
  const listId = useId();

  const matches = useMemo(() => matchContacts(contacts, value), [contacts, value]);
  const show = open && matches.length > 0;
  // Clamp: `matches` can shrink under a stale `active` between renders.
  const activeIndex = active === null ? null : Math.min(active, Math.max(matches.length - 1, 0));

  const pick = (c: ContactOption) => {
    onPick(c);
    setOpen(false);
    setActive(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i === null ? 0 : (Math.min(i, matches.length - 1) + 1) % matches.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        i === null
          ? matches.length - 1
          : (Math.min(i, matches.length - 1) - 1 + matches.length) % matches.length
      );
    } else if (e.key === "Enter") {
      // Only swallow Enter while a suggestion is genuinely highlighted (the user
      // navigated with ArrowUp/ArrowDown or hovered an option). Otherwise let the
      // keypress fall through so the form submits normally with whatever the user
      // typed — a recipient not in the contact book must stay fully submittable.
      if (activeIndex === null) return;
      e.preventDefault();
      pick(matches[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
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
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActive(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        required
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
          // stops the blur (and thus the close) from happening at all — the
          // click then lands on the option with focus still on the input.
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              style={{
                padding: "6px 8px", cursor: "pointer", borderRadius: "var(--radius-sm)",
                background: i === activeIndex ? "var(--surface-2)" : undefined,
              }}
            >
              <div>
                <strong>{c.lastName}, {c.firstName}</strong>
                {c.rank ? <span className="subtle"> · {c.rank}</span> : null}
              </div>
              <div className="subtle">{c.email}{c.unit ? ` · ${c.unit}` : ""}</div>
            </li>
          ))}
        </ul>
      )}

      {/* The list is visible, so this is for screen readers only. Mirrors the
          aria-live idiom in HomeSearch.tsx. */}
      <div aria-live="polite" role="status" className="sr-only">
        {show ? `${matches.length} contact${matches.length === 1 ? "" : "s"} available.` : ""}
      </div>
    </div>
  );
}
