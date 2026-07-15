"use client";
import { useState } from "react";
import { formatPhone } from "@/lib/phone";

// Phone input that auto-formats to (xxx)-xxx-xxxx as the user types.
//
// Uncontrolled by default: state is seeded once from `defaultValue`, which is
// what the register and new-user forms want. Passing `value` opts into
// controlled mode — the receipt builder needs that so picking a contact can set
// the number from outside, which a defaultValue-seeded useState cannot do.
//
// Two rules for controlled mode, neither of which React will warn you about
// here (`shown` is always a defined string, so the underlying input is always
// controlled as far as React can tell — its native warning never fires):
//   1. Pass `onChange` with `value`, or the field silently ignores typing.
//   2. Pick a mode per instance and keep it. Flipping a mounted instance
//      between passing and omitting `value` snaps the field to `inner`, which
//      is frozen at mount-time `defaultValue` — a silent wrong value, not an error.
export function PhoneInput({
  name,
  id,
  defaultValue,
  value,
  onChange,
  required,
  placeholder = "(123)-456-7890",
}: {
  name: string;
  id?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const [inner, setInner] = useState(() => formatPhone(defaultValue ?? ""));
  const controlled = value !== undefined;
  const shown = controlled ? formatPhone(value) : inner;

  return (
    <input
      id={id}
      name={name}
      className="input"
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      placeholder={placeholder}
      value={shown}
      onChange={(e) => {
        const next = formatPhone(e.target.value);
        if (controlled) onChange?.(next);
        else setInner(next);
      }}
      required={required}
    />
  );
}
