"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createItem, updateItemFields, setItemStatus, analyzeImport, commitImport } from "@/modules/items/items.service";
import { ItemError } from "@/modules/items/items.errors";
import { newItemSchema } from "@/modules/items/items.schema";
import { z } from "zod";
import { resolutionSchema, type UnitResolution } from "@/modules/items/units.service";
import type { SkippedRow, UnresolvedRow } from "@/modules/items/import";

export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const item = await createItem(parsed.data, admin.id);
  return { itemId: item.id };
}

// Admin edit of an item's identity fields. Routes through the SAME
// updateItemFields as the user-level action so admin changes land in the same
// ItemEdit history rather than bypassing it.
export async function updateItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id"));
  const parsed = newItemSchema.partial().safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await updateItemFields(id, parsed.data, { id: admin.id, name: admin.name });
  } catch (e) {
    if (e instanceof ItemError && e.code === "NOT_FOUND") {
      return { error: "That item no longer exists." };
    }
    console.error("[updateItemAction] unexpected error:", e);
    return { error: "Something went wrong saving your changes. Please try again." };
  }
  revalidatePath("/items");
  revalidatePath(`/i/${id}`);
  return { ok: true };
}

export async function toggleItemStatusAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const next = formData.get("status") === "RETIRED" ? "RETIRED" : "ACTIVE";
  await setItemStatus(id, next);
  revalidatePath("/items");
}

function readCsvFile(formData: FormData): { file: File } | { error: string } {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to import." };
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "The file must be a .csv file." };
  return { file };
}

export async function analyzeImportAction(
  formData: FormData
): Promise<{ counts: { toImport: number; skipped: number; autoDetected: number }; skipped: SkippedRow[]; unresolved: UnresolvedRow[] } | { error: string }> {
  await requireAdmin();
  const f = readCsvFile(formData);
  if ("error" in f) return f;
  try {
    const text = await f.file.text();
    const res = await analyzeImport(text);
    if (res.error) return { error: res.error };
    return { counts: res.counts, skipped: res.skipped, unresolved: res.unresolved };
  } catch (e) {
    console.error("[analyzeImportAction] unexpected error:", e);
    return { error: "Something went wrong reading the file. Please try again." };
  }
}

export async function commitImportAction(
  formData: FormData
): Promise<{ added: number; skipped: SkippedRow[]; detected: number } | { error: string }> {
  const admin = await requireAdmin();
  const f = readCsvFile(formData);
  if ("error" in f) return f;

  let resolutions: UnitResolution[];
  try {
    const raw = JSON.parse(String(formData.get("resolutions") ?? "[]"));
    resolutions = z.array(resolutionSchema).parse(raw);
  } catch {
    return { error: "The unit assignments were invalid. Please re-check them and try again." };
  }

  try {
    const text = await f.file.text();
    const res = await commitImport(text, f.file.name, resolutions, admin.id);
    if (res.error) return { error: res.error };
    revalidatePath("/items");
    revalidatePath("/admin/audit");
    return { added: res.added, skipped: res.skipped, detected: res.detected };
  } catch (e) {
    console.error("[commitImportAction] unexpected error:", e);
    return { error: "Something went wrong importing the file. Please try again." };
  }
}
