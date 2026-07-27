"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import {
  createItem,
  updateItemFields,
  setItemStatus,
  analyzeImport,
  commitImport,
  bulkUpdateReadiness,
  MAX_BULK_ITEMS,
} from "@/modules/items/items.service";
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
  const item = await createItem(parsed.data, admin.id, admin.name);
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

// Bulk readiness update from the /items table.
//
// ADMIN-ONLY, enforced here on the server — the UI hides the controls from a
// standard USER, but hiding is not a guard. requireAdmin() re-reads role +
// isActive from the DB per request, so a demoted account loses this
// immediately. Note this is deliberately NOT part of updateItemDetailsAction's
// role-picked schema: readiness is an admin capability, and routing it through
// its own action keeps the USER-editable field set exactly as narrow as it was.
const bulkReadinessSchema = z
  .object({
    itemIds: z.array(z.string().min(1)).min(1, "Select at least one item."),
    // Three-way: a concrete status, or "UNTRIAGED" to clear it back to null.
    deployableStatus: z.enum(["DEPLOYED", "READY_TO_DEPLOY", "IN_REPAIR", "RETIRED", "UNTRIAGED"]).optional(),
    isAccountedFor: z.enum(["true", "false"]).optional(),
  })
  .refine((v) => v.deployableStatus !== undefined || v.isAccountedFor !== undefined, {
    message: "Choose a change to apply.",
  });

export async function bulkUpdateReadinessAction(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = bulkReadinessSchema.safeParse({
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
    deployableStatus: formData.get("deployableStatus") || undefined,
    isAccountedFor: formData.get("isAccountedFor") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { itemIds, deployableStatus, isAccountedFor } = parsed.data;

  try {
    const { updated } = await bulkUpdateReadiness(
      itemIds,
      {
        // "UNTRIAGED" is the sentinel for clearing the column, which is a
        // meaningful state (never triaged) and distinct from "not submitted".
        ...(deployableStatus !== undefined
          ? { deployableStatus: deployableStatus === "UNTRIAGED" ? null : deployableStatus }
          : {}),
        ...(isAccountedFor !== undefined ? { isAccountedFor: isAccountedFor === "true" } : {}),
      },
      { id: admin.id, name: admin.name },
    );
    revalidatePath("/items");
    revalidatePath("/admin/analytics");
    return { ok: true, updated };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[bulkUpdateReadinessAction] unexpected error:", e);
    return { error: "Something went wrong updating those items. Please try again." };
  }
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
): Promise<{ counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number; autoDetected: number }; skipped: SkippedRow[]; unresolved: UnresolvedRow[]; mismatches: { serialNumber: string }[] } | { error: string }> {
  await requireAdmin();
  const f = readCsvFile(formData);
  if ("error" in f) return f;
  try {
    const text = await f.file.text();
    const res = await analyzeImport(text);
    if (res.error) return { error: res.error };
    return { counts: res.counts, skipped: res.skipped, unresolved: res.unresolved, mismatches: res.mismatches };
  } catch (e) {
    console.error("[analyzeImportAction] unexpected error:", e);
    return { error: "Something went wrong reading the file. Please try again." };
  }
}

export async function commitImportAction(
  formData: FormData
): Promise<{ added: number; updated: number; skipped: SkippedRow[]; unchanged: number; detected: number; mismatches: { serialNumber: string }[] } | { error: string }> {
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
    const res = await commitImport(text, f.file.name, resolutions, { id: admin.id, name: admin.name });
    if (res.error) return { error: res.error };
    revalidatePath("/items");
    revalidatePath("/admin/audit");
    return { added: res.added, updated: res.updated, skipped: res.skipped, unchanged: res.unchanged, detected: res.detected, mismatches: res.mismatches };
  } catch (e) {
    console.error("[commitImportAction] unexpected error:", e);
    return { error: "Something went wrong importing the file. Please try again." };
  }
}
