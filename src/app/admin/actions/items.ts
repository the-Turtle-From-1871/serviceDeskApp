"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createItem, updateItem, setItemStatus, importItems } from "@/modules/items/items.service";
import { newItemSchema } from "@/modules/items/items.schema";
import type { SkippedRow } from "@/modules/items/import";

export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const item = await createItem(parsed.data, admin.id);
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
  revalidatePath("/items");
  return { ok: true };
}

export async function toggleItemStatusAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const next = formData.get("status") === "RETIRED" ? "RETIRED" : "ACTIVE";
  await setItemStatus(id, next);
  revalidatePath("/items");
}

export async function importItemsAction(
  _prev: unknown,
  formData: FormData
): Promise<{ added: number; skipped: SkippedRow[] } | { error: string }> {
  const admin = await requireAdmin();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to import." };
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "The file must be a .csv file." };
  try {
    const text = await file.text();
    const res = await importItems(text, file.name, admin.id);
    if (res.error) return { error: res.error };
    revalidatePath("/items");
    revalidatePath("/admin/audit");
    return { added: res.added, skipped: res.skipped };
  } catch (e) {
    console.error("[importItemsAction] unexpected error:", e);
    return { error: "Something went wrong importing the file. Please try again." };
  }
}
