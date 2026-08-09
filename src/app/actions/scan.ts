"use server";
import { requireUser, AuthError } from "@/lib/authz";
import { getItem, getItemBySerialForScan } from "@/modules/items/items.service";
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

export type SerialResolution =
  | { ok: true; itemId: string }
  | { ok: false; code: "NOT_FOUND" | "UNAUTHORIZED" | "FAILED" };

/** Resolve a scanned serial, trying the raw value first and the alternate
 *  (a converted Dell Express Service Code) only if it misses. At most two
 *  queries, the second only on a miss — see scan-code.ts for why the order
 *  matters. Returns null when neither names an item. */
async function findBySerial(serial: string, altSerial?: string) {
  const first = await getItemBySerialForScan(serial);
  if (first) return first;
  const alt = altSerial?.trim();
  if (!alt || alt === serial) return null;
  return getItemBySerialForScan(alt);
}

/**
 * Resolves a scanned manufacturer serial for the hand-receipt builder — the
 * serial-shaped twin of lookupScannedItem, and it keeps that function's rules:
 * any ACTIVE authenticated user may look one up (inventory is shared org-wide),
 * a non-ACTIVE item is refused, and the return is an explicit field subset
 * rather than the Prisma row.
 */
export async function lookupScannedSerial(serial: string, altSerial?: string): Promise<ScanLookup> {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, code: "UNAUTHORIZED" };
    console.error("[lookupScannedSerial] auth check failed:", e);
    return { ok: false, code: "FAILED" };
  }

  const sn = serial.trim();
  if (!sn) return { ok: false, code: "NOT_FOUND" };

  try {
    const item = await findBySerial(sn, altSerial);
    if (!item) return { ok: false, code: "NOT_FOUND" };
    if (item.status !== "ACTIVE") return { ok: false, code: "RETIRED" };

    const holder = await getLastReceiver(item.id);
    return {
      ok: true,
      item: { id: item.id, make: item.make, model: item.model, serialNumber: item.serialNumber },
      holderName: holder?.name ?? null,
    };
  } catch (e) {
    console.error("[lookupScannedSerial] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}

/**
 * Resolves a scanned serial to an item id for the /items list.
 *
 * Deliberately does NOT apply the ACTIVE filter lookupScannedSerial does: that
 * rule exists because the builder is about to put the item on a hand receipt,
 * and this surface only opens a page. A retired device is exactly the kind of
 * thing someone scans to ask "what is this and why is it on the shelf".
 *
 * Returns an id and nothing else — the item page does its own gated fetch.
 */
export async function resolveScannedSerial(serial: string, altSerial?: string): Promise<SerialResolution> {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, code: "UNAUTHORIZED" };
    console.error("[resolveScannedSerial] auth check failed:", e);
    return { ok: false, code: "FAILED" };
  }

  const sn = serial.trim();
  if (!sn) return { ok: false, code: "NOT_FOUND" };

  try {
    const item = await findBySerial(sn, altSerial);
    return item ? { ok: true, itemId: item.id } : { ok: false, code: "NOT_FOUND" };
  } catch (e) {
    console.error("[resolveScannedSerial] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}
