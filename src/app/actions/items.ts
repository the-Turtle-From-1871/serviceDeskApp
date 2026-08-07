"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/authz";
import { updateItemFields } from "@/modules/items/items.service";
import { itemDetailsSchema, userItemDetailsSchema } from "@/modules/items/items.schema";
import { learnCategories, normalizeCategoryName } from "@/modules/items/categories.service";
import { ItemError } from "@/modules/items/items.errors";
import type { ItemLoggedFields } from "@/modules/items/item-diff";

// Inventory is shared org-wide, so there is deliberately no per-user ownership
// filter — access is gated on ROLE. An ADMIN may edit all eight editable item
// fields; a standard USER may change only the current holder email and current
// position. The role picks the schema, and z.object() strips the rest, so a
// USER's crafted POST cannot alter deviceName/homeUnit/deviceUIC/notes/
// deviceCategory/storageLocation even though the form hides those inputs.
// Every change is recorded as an ItemEdit by updateItemFields.
export async function updateItemDetailsAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Missing item." };

  const schema = user.role === "ADMIN" ? itemDetailsSchema : userItemDetailsSchema;
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Categories are stored on the item in the SAME canonical form the managed
  // vocabulary uses, or the two drift and the in-use count silently misses
  // (which would let an admin delete a category that is still assigned). Same
  // treatment as updateItemAction — a USER's submission has no deviceCategory
  // key at all, so this is skipped for them.
  const data: Partial<ItemLoggedFields> = { ...parsed.data };
  const category = data.deviceCategory == null ? undefined : normalizeCategoryName(data.deviceCategory);
  if (category !== undefined) data.deviceCategory = category;

  try {
    await updateItemFields(id, data, { id: user.id, name: user.name });
  } catch (e) {
    if (e instanceof ItemError && e.code === "NOT_FOUND") {
      return { error: "That item no longer exists." };
    }
    console.error("[updateItemDetailsAction] unexpected error:", e);
    return { error: "Something went wrong saving your changes. Please try again." };
  }

  // A category typed straight into the card joins the vocabulary, so the managed
  // list keeps reflecting what is actually in the fleet.
  //
  // DELIBERATELY outside the try above, and swallowing its own failure. This is
  // a SEPARATE transaction from the item write, which has already committed by
  // the time it runs. Reporting its failure as "Something went wrong saving your
  // changes" would tell the admin their edit did not land when it did — and they
  // would re-submit a save that already happened. The worst case here is a
  // category missing from the picker until the next write or import teaches it,
  // which `learnCategories` is built to do idempotently.
  if (category) {
    try {
      await learnCategories([category]);
    } catch (e) {
      console.error("[updateItemDetailsAction] learnCategories failed (item edit already saved):", e);
    }
  }

  revalidatePath(`/i/${id}`);
  revalidatePath("/items");
  return { ok: true as const };
}
