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
export function groupItemsIntoLines(items: LineItem[]): ReceiptLine[] {
  const byKey = new Map<string, ReceiptLine>();
  for (const it of items) {
    const key = keyOf(it);
    let line = byKey.get(key);
    if (!line) {
      line = { lineNo: byKey.size + 1, make: it.make, model: it.model, unitOfIssue: "EA", serials: [], itemIds: [], defaultQty: 0 };
      byKey.set(key, line);
    }
    line.serials.push(it.serialNumber);
    line.itemIds.push(it.itemId);
    line.defaultQty = line.serials.length;
  }
  return [...byKey.values()];
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
