"use client";
import { useMemo, useRef, useState } from "react";

type Option = { id: string; label: string };

// A simple searchable user picker: type to filter by rank/name, click to select.
// The chosen id is submitted via a hidden input named `name`; scales far better
// than a long <select> once many users are registered.
export function UserCombobox({
  name,
  users,
  placeholder = "Search by rank or name…",
  required = false,
}: {
  name: string;
  users: Option[];
  placeholder?: string;
  required?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? users.filter((u) => u.label.toLowerCase().includes(q)) : users;
    return list.slice(0, 50);
  }, [query, users]);

  function choose(u: Option) {
    setSelectedId(u.id);
    setQuery(u.label);
    setOpen(false);
  }

  return (
    <div className="combo">
      <input
        className="input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedId(""); // typing clears any prior selection
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
      />
      <input type="hidden" name={name} value={selectedId} required={required} />
      {open && (
        <div className="combo__menu" onMouseDown={(e) => e.preventDefault()}>
          {matches.length === 0 ? (
            <div className="combo__empty">No matches</div>
          ) : (
            matches.map((u) => (
              <div
                key={u.id}
                role="option"
                aria-selected={u.id === selectedId}
                className="combo__option"
                onClick={() => choose(u)}
              >
                {u.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
