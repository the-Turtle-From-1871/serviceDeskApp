"use server";
import { searchItemsBySerial } from "@/modules/items/items.service";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";

export type ItemResult = { id: string; make: string; model: string; serialNumber: string; status: string };
export type ReceiptHit = { receiptNumber: string; itemSummary: string };
export type LiveSearchResult = { items?: ItemResult[]; receipt?: ReceiptHit | null };

// Live type-ahead: returns results only (never redirects). Blank query → empty.
export async function liveSearchAction(mode: string, query: string): Promise<LiveSearchResult> {
  const q = query.trim();
  if (!q) return { items: [] };

  if (mode === "receipt") {
    const t = await getTransferByReceiptNumber(q);
    return { receipt: t ? { receiptNumber: t.receiptNumber, itemSummary: t.itemSummary } : null };
  }

  const items = await searchItemsBySerial(q);
  return { items: items.map((i) => ({ id: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber, status: i.status })) };
}
