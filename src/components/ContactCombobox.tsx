"use client";
import { useEffect, useId, useRef, useState } from "react";
import { searchContactsAction } from "@/app/actions/contacts";
import type { ContactOption } from "@/modules/contacts/contact-match";

// A type-ahead over the contact book that also IS the name field — the posted
// `name` input is the combobox input itself, so a receipt can still be filled by
// typing a recipient who isn't in the book.
//
// Matches are fetched server-side (searchContactsAction) as the user types, so
// the whole book (PII) never ships to the client. That means a debounce + a
// request race guard (ignore out-of-order responses), mirroring HomeSearch.
export function ContactCombobox({
  id,
  name,
  value,
  onValueChange,
  onPick,
}: {
  id?: string;
  name: string;
  value: string;
  onValueChange: (v: string) => void;
  onPick: (c: ContactOption) => void;
}) {
  const [open, setOpen] = useState(false);
  // `null` means "not navigated": the user hasn't pressed ArrowUp/ArrowDown or
  // hovered an option yet. Distinct from index 0, so a first Enter press while
  // merely typing doesn't get mistaken for "a suggestion is highlighted".
  const [active, setActive] = useState<number | null>(null);
  // Results are stored WITH the query that produced them. Storing a bare array
  // and asking "is the box non-empty?" is not enough: after clearing the field
  // and typing something new, the previous query's results are still in state
  // and would be listed against the new text for the whole debounce plus the
  // round-trip. Comparing the stored query to the current one means a result
  // can only ever be shown for the exact text that fetched it — which also
  // makes a response that lands after the user moved on inert, with no
  // synchronous clear (and its extra render) inside the effect.
  const [matches, setMatches] = useState<{ q: string; items: ContactOption[] }>({
    q: "",
    items: [],
  });
  const reqId = useRef(0);
  const listId = useId();
  const q = value.trim();
  const options = q && matches.q === q ? matches.items : [];

  // Debounced server search. Keyed on the trimmed query; a race guard drops
  // out-of-order responses so an earlier query can't overwrite a later one.
  useEffect(() => {
    // Bump BEFORE the empty-query bail-out, so clearing the box orphans any
    // response still in flight instead of letting it resolve and write a set of
    // contacts nobody asked for back into state.
    const id = ++reqId.current;
    if (!q) return;
    const timer = setTimeout(async () => {
      try {
        const res = await searchContactsAction(q);
        if (id === reqId.current) setMatches({ q, items: res });
      } catch {
        if (id === reqId.current) setMatches({ q, items: [] });
      }
    }, 200);
    return () => clearTimeout(timer);
    // Keyed on the TRIMMED query ONLY. `open` deliberately is NOT a dependency:
    // gating the fetch on the list being visible looks like it saves the
    // redundant search after a pick, but it re-runs the effect on every focus
    // change, so a query is re-fetched once per focus cycle rather than once
    // ever — and worse, blurring inside the 200ms debounce cancels the timer
    // without scheduling a replacement, so typing a name and tabbing straight
    // out searches for nothing at all. One redundant request per pick is the
    // cheaper trade.
  }, [q]);

  const show = open && options.length > 0;
  // Clamp: `options` can shrink under a stale `active` between renders.
  const activeIndex = active === null ? null : Math.min(active, Math.max(options.length - 1, 0));

  const pick = (c: ContactOption) => {
    onPick(c);
    setOpen(false);
    setActive(null);
    // NOTE: deliberately does NOT clear `matches` to purge the contact book.
    // That was tried and the privacy claim was false: the real consumer's
    // onPick rewrites the field to the chosen name (ReceiptBuilderForm), so the
    // query changes, the effect re-runs, and 200ms later the search puts the
    // contacts straight back. Clearing also broke the case where onPick leaves
    // the text alone — state emptied, effect not re-keyed, so the list could
    // never reopen for that text. Purging properly means suppressing the
    // post-pick refetch, which is a real change, not a one-liner here.
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i === null ? 0 : (Math.min(i, options.length - 1) + 1) % options.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        i === null
          ? options.length - 1
          : (Math.min(i, options.length - 1) - 1 + options.length) % options.length
      );
    } else if (e.key === "Enter") {
      // Only swallow Enter while a suggestion is genuinely highlighted (the user
      // navigated with ArrowUp/ArrowDown or hovered an option). Otherwise let the
      // keypress fall through so the form submits normally with whatever the user
      // typed — a recipient not in the contact book must stay fully submittable.
      if (activeIndex === null) return;
      e.preventDefault();
      pick(options[activeIndex]);
    } else if (e.key === "Escape") {
      // Clearing `active` is load-bearing, not hygiene. Escape only closes the
      // list, and onFocus reopens it — so without this, focusing away and back
      // WITHOUT retyping (nothing else resets `active`) reopens the list with the
      // dismissed suggestion still highlighted, and the next Enter silently picks
      // it instead of submitting what was typed. Escape means "I don't want this
      // suggestion", so it must drop the highlight, not just hide it.
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
          {options.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              style={{
                padding: "6px 8px", cursor: "pointer", borderRadius: "var(--ledger-radius-sm)",
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
        {show ? `${options.length} contact${options.length === 1 ? "" : "s"} available.` : ""}
      </div>
    </div>
  );
}
