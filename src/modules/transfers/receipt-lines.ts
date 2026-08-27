export const MAX_RECEIPT_ROWS = 18;
export const MAX_ITEMS_PER_ROW = 10;

export type LineItem = { itemId: string; make: string; model: string; serialNumber: string };

export type ReceiptLine = {
  lineNo: number;
  make: string;
  model: string;
  unitOfIssue: string;
  serials: string[];
  itemIds: string[];
  defaultQty: number;
};

const keyOf = (i: { make: string; model: string }) => `${i.make} ${i.model}`;

// Group by exact make+model, preserving first-seen order for stable line numbers.
//
// A group larger than MAX_ITEMS_PER_ROW is SPLIT across consecutive rows rather
// than refused. Every serial on a row is printed into that row's single DA 2062
// "ITEM DESCRIPTION" cell and the PDF shrinks the font to fit, so past ~10 serials
// the row stops being legible — which is what the cap protects.
//
// The split is BALANCED, not fill-first: 11 items become 6+5, not 10+1, and 21
// become 7+7+7. Row count is ceil(n / MAX_ITEMS_PER_ROW) — the fewest rows that
// respect the cap — and the items spread evenly across them, remainder to the
// earlier rows. Even rows keep the font size consistent down the form instead of
// one dense row followed by a nearly empty one.
//
// Consequence worth knowing: two rows can now share the same make+model, so
// make+model is NO LONGER a unique key over the returned lines. createTransfer
// depends on that (see its rowsPerKey note); anything else keying on
// `make model` must count rows first.
export function groupItemsIntoLines(items: LineItem[]): ReceiptLine[] {
  const byKey = new Map<string, LineItem[]>();
  for (const it of items) {
    const group = byKey.get(keyOf(it));
    if (group) group.push(it);
    else byKey.set(keyOf(it), [it]);
  }

  const lines: ReceiptLine[] = [];
  for (const group of byKey.values()) {
    const rowCount = Math.ceil(group.length / MAX_ITEMS_PER_ROW);
    const base = Math.floor(group.length / rowCount);
    // The first `extra` rows carry one more than the rest.
    const extra = group.length % rowCount;
    let taken = 0;
    for (let row = 0; row < rowCount; row++) {
      const size = base + (row < extra ? 1 : 0);
      const chunk = group.slice(taken, taken + size);
      taken += size;
      lines.push({
        // Sequential across the WHOLE receipt, so line numbers stay 1..N even
        // when one model occupies several rows.
        lineNo: lines.length + 1,
        make: chunk[0].make,
        model: chunk[0].model,
        unitOfIssue: "EA",
        serials: chunk.map((c) => c.serialNumber),
        itemIds: chunk.map((c) => c.itemId),
        defaultQty: chunk.length,
      });
    }
  }
  return lines;
}

// Short human summary for search results and receipt emails.
export function buildItemSummary(lines: { make: string; model: string; serials: string[] }[]): string {
  if (lines.length === 0) return "";
  const first = lines[0];
  const head = `${first.make} ${first.model} (SN ${first.serials[0]})`;
  const total = lines.reduce((n, l) => n + l.serials.length, 0);
  const extra = total - 1;
  return extra > 0 ? `${head} +${extra} more` : head;
}
