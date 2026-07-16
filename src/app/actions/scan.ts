"use server";
import { requireUser, AuthError } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { getLastReceiver } from "@/modules/transfers/transfers.service";

export type ScanLookup =
  | { ok: true; item: { id: string; make: string; model: string; serialNumber: string }; holderName: string | null }
  | { ok: false; code: "NOT_FOUND" | "RETIRED" | "UNAUTHORIZED" | "FAILED" };

// Resolves a scanned item id for the hand-receipt builder. Any ACTIVE
// authenticated user may look one up — inventory is shared org-wide, matching
// updateItemDetailsAction's reasoning (app/actions/items.ts:8-10).
export async function lookupScannedItem(itemId: string): Promise<ScanLookup> {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, code: "UNAUTHORIZED" };
    console.error("[lookupScannedItem] auth check failed:", e);
    return { ok: false, code: "FAILED" };
  }

  const id = itemId.trim();
  if (!id) return { ok: false, code: "NOT_FOUND" };

  try {
    const item = await getItem(id);
    if (!item) return { ok: false, code: "NOT_FOUND" };
    // Mirrors receipts/new/page.tsx:17. A scan must not be a backdoor around
    // the ACTIVE filter the builder applies on load.
    if (item.status !== "ACTIVE") return { ok: false, code: "RETIRED" };

    const holder = await getLastReceiver(item.id);

    // An explicit subset, NOT the Prisma row. This value becomes a client
    // component's state, so it is serialized into the RSC payload and reaches
    // the browser whatever the UI renders — `item.notes` is admin-only and
    // gated server-side for exactly that reason (i/[itemId]/page.tsx:59-65).
    return {
      ok: true,
      item: { id: item.id, make: item.make, model: item.model, serialNumber: item.serialNumber },
      holderName: holder?.name ?? null,
    };
  } catch (e) {
    console.error("[lookupScannedItem] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}
