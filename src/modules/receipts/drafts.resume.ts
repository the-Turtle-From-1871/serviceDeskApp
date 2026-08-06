// Pure, so it can be unit-tested without a database and reused if another
// surface ever resumes a draft. The page does the loading; this decides what
// survived.
//
// Order comes from the DRAFT, not from the load: the operator scanned these in
// a particular order and the restored table should match what they left.
export function splitDraftItems(
  draftItemIds: string[],
  loaded: { id: string }[],
): { keptIds: string[]; droppedIds: string[] } {
  const available = new Set(loaded.map((i) => i.id));
  const keptIds: string[] = [];
  const droppedIds: string[] = [];
  for (const id of draftItemIds) (available.has(id) ? keptIds : droppedIds).push(id);
  return { keptIds, droppedIds };
}
