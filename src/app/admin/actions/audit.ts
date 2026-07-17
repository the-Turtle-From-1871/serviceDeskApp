"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { getOwnedSignature } from "@/modules/signatures/signatures.service";
import { recordAudit } from "@/modules/audit/audit.service";

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
