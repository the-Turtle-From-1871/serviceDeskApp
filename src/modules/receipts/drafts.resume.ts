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

// A dropped item is NAMEABLE only when the id still resolved to a row (it was
// fetched, just not ACTIVE — the only other ItemStatus is RETIRED, so this is
// always a retirement) — the caller has a serial and a make/model to print.
// An id that resolved to nothing was deleted from inventory outright: there is
// no identifier to show, and inventing one (a bare id, "unknown device") would
// be worse than the spec's whole point of never losing track of equipment. Kept
// as a discriminated union (presence of `serialNumber`) rather than a nullable
// field, so a caller can't accidentally destructure a name that isn't there.
export type DroppedDraftItem =
  | { id: string; serialNumber: string; make: string; model: string }
  | { id: string };

function isNameable(d: DroppedDraftItem): d is { id: string; serialNumber: string; make: string; model: string } {
  return "serialNumber" in d;
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// Names what it can and still ACCOUNTS FOR what it can't, per the approved
// design spec (§4): "show a banner naming them ('SN ABC123 was retired and has
// been removed')". Renders "" for an empty list so a caller can gate a single
// `role="alert"` element on truthiness without a separate count check.
export function formatDroppedItemsNotice(dropped: DroppedDraftItem[]): string {
  if (dropped.length === 0) return "";
  const named = dropped.filter(isNameable);
  const unnamedCount = dropped.length - named.length;

  if (named.length === 0) {
    // No serial to print for any of them — still say how many and what
    // happened, rather than silently omitting the warning entirely.
    const s = unnamedCount === 1 ? "" : "s";
    const be = unnamedCount === 1 ? "is" : "are";
    const have = unnamedCount === 1 ? "has" : "have";
    return `${unnamedCount} device${s} from this draft ${be} no longer in inventory and ${have} been removed.`;
  }

  const list = joinWithAnd(named.map((n) => `SN ${n.serialNumber} (${n.make} ${n.model})`));
  const was = named.length === 1 ? "was" : "were";
  const has = named.length === 1 ? "has" : "have";
  let sentence = `${list} ${was} retired and ${has} been removed from this draft`;
  if (unnamedCount > 0) {
    sentence += `, and ${unnamedCount} device${unnamedCount === 1 ? "" : "s"} no longer in inventory`;
  }
  return `${sentence}.`;
}
