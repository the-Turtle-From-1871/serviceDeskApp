"use client";
import { useId, useMemo, useRef, useState } from "react";
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
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => matchContacts(contacts, value), [contacts, value]);
  const show = open && matches.length > 0;
  // Clamp: `matches` can shrink under a stale `active` between renders.
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));

  const pick = (c: ContactOption) => {
    onPick(c);
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (Math.min(i, matches.length - 1) + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (Math.min(i, matches.length - 1) - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      // Only swallow Enter while a suggestion is highlighted, so Enter otherwise
      // still submits the form as usual.
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
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        // Deferred: a click on an option fires after blur, so closing
        // immediately would unmount the option before it registers.
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
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
          // Cancel the deferred close: mousedown beats blur, so the click lands.
          onMouseDown={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
          }}
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
