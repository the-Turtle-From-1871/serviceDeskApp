"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createItem, updateItem, setItemStatus } from "@/modules/items/items.service";
import { newItemSchema } from "@/modules/items/items.schema";
import { assignInitialHolder } from "@/modules/transfers/transfers.service";

export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const item = await createItem(parsed.data, admin.id);

  // Optional "Key Flow 1": record an initial holder as a completed assignment.
  const initialHolderId = String(formData.get("initialHolderId") ?? "");
  if (initialHolderId) {
    await assignInitialHolder({ itemId: item.id, toUserId: initialHolderId });
  }
  return { itemId: item.id };
}

export async function updateItemAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const parsed = newItemSchema.partial().safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  await updateItem(id, parsed.data);
  revalidatePath(`/i/${id}`);
  revalidatePath("/admin/items");
  return { ok: true };
}

export async function toggleItemStatusAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const next = formData.get("status") === "RETIRED" ? "RETIRED" : "ACTIVE";
  await setItemStatus(id, next);
  revalidatePath(`/i/${id}`);
  revalidatePath("/admin/items");
}
