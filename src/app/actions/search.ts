"use server";
import { searchItemsBySerial } from "@/modules/items/items.service";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";

export type ItemResult = { id: string; make: string; model: string; serialNumber: string; status: string };
export type ReceiptHit = { receiptNumber: string; itemSummary: string };
export type LiveSearchResult = { items?: ItemResult[]; receipt?: ReceiptHit | null };

// PUBLIC BY DESIGN (reviewed exception to the "auth-first" guardrail): the home
// receipt/item search is intentionally unauthenticated. Read-only, capped at 50
// rows, and returns only the same non-signature summary the public pages show.
// Live type-ahead: returns results only (never redirects). Blank query → empty.
export async function liveSearchAction(mode: string, query: string): Promise<LiveSearchResult> {
  const q = query.trim();
  if (!q) return { items: [] };

  try {
    if (mode === "receipt") {
      const t = await getTransferByReceiptNumber(q);
      return { receipt: t ? { receiptNumber: t.receiptNumber, itemSummary: t.itemSummary } : null };
    }

    const items = await searchItemsBySerial(q);
    return { items: items.map((i) => ({ id: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber, status: i.status })) };
  } catch (e) {
    // Log server-side; return an empty (generic) result rather than a 500.
    console.error("[liveSearchAction] search failed:", e);
    return mode === "receipt" ? { receipt: null } : { items: [] };
  }
}
