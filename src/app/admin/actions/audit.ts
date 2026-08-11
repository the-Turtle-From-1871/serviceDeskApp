"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { getOwnedSignature } from "@/modules/signatures/signatures.service";
import { recordAudit, recordAudits } from "@/modules/audit/audit.service";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
import { ItemError } from "@/modules/items/items.errors";

const schema = z.object({
  itemId: z.string().min(1),
  signatureId: z.string().min(1),
});

// Mark an item as audited from the item detail page. Admin-only. The client posts
// only `signatureId`; the signer name + image are re-read server-side scoped to the
// acting admin, so a client cannot forge a signer or use another admin's signature.
export async function markAuditedAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  const user = await requireAdmin();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid input." };
  const { itemId, signatureId } = parsed.data;
  try {
    const item = await getItem(itemId);
    if (!item) return { error: "Item not found." };
    // Backend validation matching the hidden UI: retired items are out of service.
    if (item.status === "RETIRED") return { error: "Retired items cannot be audited." };
    const sig = await getOwnedSignature(signatureId, user.id);
    if (!sig) return { error: "Select a valid signature." };
    await recordAudit({
      itemId,
      auditedById: user.id,
      auditedByName: user.name,
      signerName: sig.name,
      signatureImage: sig.image,
    });
  } catch (e) {
    console.error("[markAuditedAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath(`/i/${itemId}`);
  revalidatePath("/items");
  return { ok: true };
}

const bulkAuditSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one item.")
    .max(MAX_BULK_ITEMS, `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.`),
  signatureId: z.string().min(1, "Select a signature."),
});

type BulkAuditResult =
  | { error: string }
  | { ok: true; updated: number; skipped: number };

/**
 * Audit every selected item under ONE signature — the /items selection-bar
 * twin of markAuditedAction, for a scanned shelf sweep.
 *
 * The client posts only ids and a signatureId. The signer name and image are
 * re-read server-side scoped to the acting admin, so a client can neither forge
 * a signer nor use another admin's ink. The batch is client-supplied ids, so
 * this guard is the entire boundary.
 */
export async function recordAuditsAction(formData: FormData): Promise<BulkAuditResult> {
  const user = await requireAdmin();

  const parsed = bulkAuditSchema.safeParse({
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
    signatureId: String(formData.get("signatureId") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const sig = await getOwnedSignature(parsed.data.signatureId, user.id);
    if (!sig) return { error: "Select a valid signature." };

    const { updated, skipped } = await recordAudits({
      itemIds: parsed.data.itemIds,
      auditedById: user.id,
      auditedByName: user.name,
      signerName: sig.name,
      signatureImage: sig.image,
    });

    revalidatePath("/items");
    // Audit recency drives the dashboard's accountability donut.
    revalidatePath("/admin/analytics");
    return { ok: true, updated, skipped };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[recordAuditsAction] unexpected error:", e);
    return { error: "Something went wrong recording those audits. Please try again." };
  }
}
