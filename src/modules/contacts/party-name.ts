// Pure: no Prisma, no React, no I/O. Splits the hand-receipt builder's single
// free-text party name into the `firstName` / `lastName` pair a Contact needs,
// so the auto-save on `createReceiptAction` can file an outside party into the
// shared contact book. Kept as its own leaf module (like contact-match.ts and
// recipient-search.ts) because the RULE is the interesting part and it must be
// unit-testable without a DB client.
//
// prisma/schema.prisma says a Contact stores the two halves separately
// precisely BECAUSE "parsing a surname out of one column misfiles 'Van Der
// Berg' and 'Doe Jr.'". That warning still stands — this parser is a
// best-effort convenience on a field that accepts free text, not a claim to
// have solved the problem. Every guess it makes is editable on /admin/users,
// and anything it cannot split confidently is skipped rather than misfiled.

export type ParsedPartyName = { firstName: string; lastName: string };

const collapse = (s: string): string => s.trim().replace(/\s+/g, " ");

/**
 * Splits a party name into given name + surname, or returns `null` when it
 * cannot be split confidently (the caller then saves nothing).
 *
 * - A COMMA is the reliable signal, and the builder's label asks for it
 *   ("Name (Last, First)"). The FIRST comma splits: everything left of it is
 *   the surname, everything right is the given name. That is what makes
 *   "Doe Jr., Jane" file correctly — the suffix stays attached to the surname
 *   where it belongs. Any further commas in the given-name half collapse to
 *   spaces; either half being empty means the name was "Doe," or ", Jane" and
 *   is refused.
 * - With NO comma, the FIRST token is the given name and everything after it
 *   is the surname. This is the deliberate trade: it keeps compound surnames
 *   ("Van Der Berg", "De La Cruz") intact at the cost of misfiling someone who
 *   types two given names ("Maria Jose Cruz" files as Maria / "Jose Cruz").
 *   Compound surnames are the commoner case in this fleet.
 * - A single word cannot produce the two non-empty columns a Contact requires,
 *   so it yields `null`.
 */
export function parsePartyName(name: string): ParsedPartyName | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const comma = trimmed.indexOf(",");
  if (comma !== -1) {
    const lastName = collapse(trimmed.slice(0, comma));
    const firstName = collapse(trimmed.slice(comma + 1).replace(/,/g, " "));
    if (!lastName || !firstName) return null;
    return { firstName, lastName };
  }

  const tokens = collapse(trimmed).split(" ");
  if (tokens.length < 2) return null;
  return { firstName: tokens[0], lastName: tokens.slice(1).join(" ") };
}
