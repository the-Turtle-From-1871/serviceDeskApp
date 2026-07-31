"use server";
import { searchItemsBySerial } from "@/modules/items/items.service";
import { searchReceiptsByNumber } from "@/modules/transfers/transfers.service";
import { publicAccessAllowed } from "@/lib/public-access-guard";

export type ItemResult = { id: string; make: string; model: string; serialNumber: string; status: string };
export type ReceiptHit = { receiptNumber: string; itemSummary: string };
export type LiveSearchResult = { items?: ItemResult[]; receipts?: ReceiptHit[]; locked?: true };

// PUBLIC BY DESIGN (reviewed exception to the "auth-first" guardrail): the home
// receipt/item search is intentionally unauthenticated. Read-only, capped at 50
// rows, and returns only the same non-signature summary the public pages show.
// Live type-ahead: returns results only (never redirects). Blank query → empty.
//
// "Unauthenticated" is not "ungated": when PUBLIC_ACCESS_PIN_ENABLED is on this
// action enforces the shared-PIN gate ITSELF, and that check is load-bearing
// rather than defence in depth. A Server Action POSTs to the path of the page
// hosting it, so while `/` was PIN-gated in the proxy this action was gated for
// free. `/` is now public — it has to be, it is the page that explains what this
// app is — and `publicAccessAllowed()` is what replaced that cover. Removing it
// re-opens the whole item and receipt catalog to anyone who can POST, which is
// exactly what the PIN gate exists to prevent.
export async function liveSearchAction(mode: string, query: string): Promise<LiveSearchResult> {
  // Gate BEFORE the query, not after: a refusal must not cost a database round
  // trip, and must not be distinguishable by timing from an empty result set.
  if (!(await publicAccessAllowed())) return { locked: true };

  const q = query.trim();
  if (!q) return { items: [] };

  try {
    if (mode === "receipt") {
      const rows = await searchReceiptsByNumber(q);
      return { receipts: rows.map((r) => ({ receiptNumber: r.receiptNumber, itemSummary: r.itemSummary })) };
    }

    const items = await searchItemsBySerial(q);
    return { items: items.map((i) => ({ id: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber, status: i.status })) };
  } catch (e) {
    // Log server-side; return an empty (generic) result rather than a 500.
    console.error("[liveSearchAction] search failed:", e);
    return mode === "receipt" ? { receipts: [] } : { items: [] };
  }
}
