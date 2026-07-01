"use server";
import { requireAdmin } from "@/lib/authz";
import { createItem } from "@/modules/items/items.service";
import { newItemSchema } from "@/modules/items/items.schema";

export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const item = await createItem(parsed.data, admin.id);
  return { itemId: item.id };
}
