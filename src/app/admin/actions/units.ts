"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/authz";
import { ItemError } from "@/modules/items/items.errors";
import { learnUnits, renameUnit, deleteUnit, resolutionSchema } from "@/modules/items/units.service";
import { parseUnitBlock } from "@/modules/items/units.parse";

/* Managing the unit vocabulary is an ADMIN capability, enforced here on the
   server. requireAdmin() re-reads role + isActive from the DB per request, so
   a demoted or deactivated account loses it immediately. */

const idSchema = z.string().min(1, "Missing unit.");

export async function createUnitAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const parsed = resolutionSchema.safeParse({
    abbreviation: String(formData.get("abbreviation") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await learnUnits([parsed.data]);
  } catch (e) {
    console.error("[createUnitAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath("/admin/units");
  return { ok: true as const };
}

export async function renameUnitAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const id = idSchema.safeParse(String(formData.get("id") ?? ""));
  if (!id.success) return { error: "Missing unit." };
  const fullName = String(formData.get("fullName") ?? "").trim();
  if (!fullName) return { error: "Enter a unit name." };

  try {
    const res = await renameUnit(id.data, fullName, { id: admin.id, name: admin.name });
    revalidatePath("/admin/units");
    // Item.homeUnit values change on a rename, and /items filters/displays them.
    revalidatePath("/items");
    return { ok: true as const, itemsUpdated: res.itemsUpdated };
  } catch (e) {
    // ItemError messages here are written for the user (a missing unit, a
    // blank name) and are safe to show directly.
    if (e instanceof ItemError) return { error: e.message };
    console.error("[renameUnitAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
}

export async function deleteUnitAction(formData: FormData) {
  await requireAdmin();
  const id = idSchema.safeParse(String(formData.get("id") ?? ""));
  if (!id.success) return { error: "Missing unit." };

  try {
    await deleteUnit(id.data);
  } catch (e) {
    if (e instanceof ItemError) return { error: e.message };
    console.error("[deleteUnitAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath("/admin/units");
  return { ok: true as const };
}

export async function bulkLearnUnitsAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const { units, errors } = parseUnitBlock(String(formData.get("block") ?? ""));
  if (errors.length > 0) return { error: errors.slice(0, 5).join(" ") };
  if (units.length === 0) return { error: "Nothing to add." };

  try {
    // learnUnits surfaces real created/updated counts (see units.service.ts) —
    // reporting units.length as "created" would be dishonest for any line that
    // re-teaches an existing abbreviation with a new name.
    const { created, updated } = await learnUnits(units);
    revalidatePath("/admin/units");
    return { ok: true as const, created, updated };
  } catch (e) {
    console.error("[bulkLearnUnitsAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
}
