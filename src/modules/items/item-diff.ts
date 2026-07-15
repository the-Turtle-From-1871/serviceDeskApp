// Pure diff logic for item edits. No Prisma runtime import, so this is
// unit-testable without a database.

// Every field whose changes are recorded in ItemEdit. Callers pass any subset:
// the user-facing card edits four of them, the admin form edits six.
export type ItemLoggedFields = {
  homeUnit: string | null;
  deviceName: string | null;
  currentUser: string | null;
  currentPosition: string | null;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  notes: string | null;
};

export type FieldChange = {
  field: keyof ItemLoggedFields;
  from: string | null;
  to: string | null;
};

// Canonical stored form: trimmed, with blank/whitespace collapsed to null.
function norm(v: string | null | undefined): string | null {
  const trimmed = (v ?? "").trim();
  return trimmed || null;
}

/** Changes between `before` and the caller-supplied `after` subset.
 *  Keys absent from `after` (or explicitly undefined) are left alone — that is a
 *  "not submitted", never a clear-to-null. Returns only fields whose normalized
 *  value actually differs, so a no-op save produces an empty array. */
export function diffItemFields(
  before: Partial<ItemLoggedFields>,
  after: Partial<ItemLoggedFields>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of Object.keys(after) as (keyof ItemLoggedFields)[]) {
    if (after[field] === undefined) continue;
    const from = norm(before[field]);
    const to = norm(after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}
