// Progressively format a phone number as (xxx)-xxx-xxxx from whatever the user
// typed. Non-digits are stripped and the value is capped at 10 digits. The
// closing paren only appears once a 4th digit exists, so backspacing back
// through the area code doesn't get stuck on a re-added ")".
export function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)})-${d.slice(3)}`;
  return `(${d.slice(0, 3)})-${d.slice(3, 6)}-${d.slice(6)}`;
}
