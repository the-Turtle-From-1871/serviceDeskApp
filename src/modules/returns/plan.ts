export type HeldItem = {
  transferItemId: string;
  serialNumber: string;
  make: string;
  model: string;
  lineNo: number;
};

export type ReturnLineBalance = {
  lineNo: number;
  make: string;
  model: string;
  heldBefore: number;
  returnedNow: number;
  heldAfter: number;
};

export type ReturnPlan = {
  kind: "PARTIAL" | "FULL";
  returned: HeldItem[];
  remaining: HeldItem[];
  byLine: ReturnLineBalance[];
};

// Pure: decide which held items are returned vs remain, classify the return as
// PARTIAL or FULL, and compute per-line before/after balances for the redline
// UI and the email. No DB access; `selectedItemIds` are TransferItem ids.
export function planReturn(
  held: HeldItem[],
  selectedItemIds: string[]
): { plan?: ReturnPlan; error?: string } {
  const selected = new Set(selectedItemIds.filter(Boolean));
  if (selected.size === 0) return { error: "Select at least one serial number to return." };

  const heldById = new Map(held.map((h) => [h.transferItemId, h]));
  for (const id of selected) {
    if (!heldById.has(id)) return { error: "A selected item is not currently held on this receipt." };
  }

  const returned = held.filter((h) => selected.has(h.transferItemId));
  const remaining = held.filter((h) => !selected.has(h.transferItemId));
  const kind = remaining.length === 0 ? "FULL" : "PARTIAL";

  const byLine: ReturnLineBalance[] = [];
  const seen = new Map<number, ReturnLineBalance>();
  for (const h of held) {
    let b = seen.get(h.lineNo);
    if (!b) {
      b = { lineNo: h.lineNo, make: h.make, model: h.model, heldBefore: 0, returnedNow: 0, heldAfter: 0 };
      seen.set(h.lineNo, b);
      byLine.push(b);
    }
    b.heldBefore += 1;
    if (selected.has(h.transferItemId)) b.returnedNow += 1;
    else b.heldAfter += 1;
  }
  byLine.sort((x, y) => x.lineNo - y.lineNo);

  return { plan: { kind, returned, remaining, byLine } };
}
