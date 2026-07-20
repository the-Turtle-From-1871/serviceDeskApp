"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/authz";
import { updateItemFields } from "@/modules/items/items.service";
import { itemDetailsSchema, userItemDetailsSchema } from "@/modules/items/items.schema";
import { ItemError } from "@/modules/items/items.errors";

// Inventory is shared org-wide, so there is deliberately no per-user ownership
// filter — access is gated on ROLE. An ADMIN may edit every item field; a
// standard USER may change only the current holder email and current position.
// The role picks the schema, and z.object() strips the rest, so a USER's crafted
// POST cannot alter deviceName/homeUnit even though the form hides those inputs.
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

  try {
    await updateItemFields(id, parsed.data, { id: user.id, name: user.name });
  } catch (e) {
    if (e instanceof ItemError && e.code === "NOT_FOUND") {
      return { error: "That item no longer exists." };
    }
    console.error("[updateItemDetailsAction] unexpected error:", e);
    return { error: "Something went wrong saving your changes. Please try again." };
  }

  revalidatePath(`/i/${id}`);
  revalidatePath("/items");
  return { ok: true as const };
}
