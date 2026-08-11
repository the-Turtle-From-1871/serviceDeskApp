"use server";
import { revalidatePath } from "next/cache";
import { requireCapability, AuthError } from "@/lib/authz";
import { createScannedItems, MAX_BULK_ITEMS } from "@/modules/items/items.service";
import { ItemError } from "@/modules/items/items.errors";
import { scannedItemSchema, type ScannedItemInput } from "@/modules/items/items.schema";
import type { SelectedItem } from "@/components/items-view";
import { z } from "zod";

// No `.max()` here — the batch-size cap is the SERVICE's guard
// (createScannedItems throws ItemError("TOO_MANY") above MAX_BULK_ITEMS), and
// this action catches it below, exactly the pattern markItemsReadyAction and
// its siblings in admin/actions/items.ts already use. That keeps one cap
// definition instead of a schema-level restatement that could drift from it.
const batchSchema = z.array(scannedItemSchema).min(1, "Scan at least one item.");

export type CreateScannedResult =
  | { ok: true; items: SelectedItem[]; created: number; existed: number }
  | { error: string };

/**
 * Create the unknown serials from one scan session.
 *
 * MANAGE_ITEMS, not ADMINISTER: this is item vocabulary, and a USER granted
 * MANAGE_ITEMS individually is entitled to it. The whole batch is validated
 * before anything is written, so a bad row cannot leave a half-created batch.
 */
export async function createScannedItemsAction(rows: ScannedItemInput[]): Promise<CreateScannedResult> {
  let user;
  try {
    user = await requireCapability("MANAGE_ITEMS");
  } catch (e) {
    if (e instanceof AuthError) return { error: "You do not have permission to create items." };
    console.error("[createScannedItemsAction] auth check failed:", e);
    return { error: "Something went wrong. Please try again." };
  }

  const parsed = batchSchema.safeParse(rows);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const res = await createScannedItems(parsed.data, user.id);
    revalidatePath("/items");
    revalidatePath("/admin/analytics");
    return { ok: true, ...res };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items scanned. The limit is ${MAX_BULK_ITEMS} per batch.` };
    }
    console.error("[createScannedItemsAction] unexpected error:", e);
    return { error: "Something went wrong creating those items. Please try again." };
  }
}
