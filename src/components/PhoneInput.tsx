"use client";
import { useState } from "react";
import { formatPhone } from "@/lib/phone";

// Controlled phone input that auto-formats to (xxx)-xxx-xxxx as the user types.
export function PhoneInput({
  name,
  id,
  defaultValue,
  required,
  placeholder = "(123)-456-7890",
}: {
  name: string;
  id?: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState(() => formatPhone(defaultValue ?? ""));
  return (
    <input
      id={id}
      name={name}
      className="input"
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(formatPhone(e.target.value))}
      required={required}
    />
  );
}
