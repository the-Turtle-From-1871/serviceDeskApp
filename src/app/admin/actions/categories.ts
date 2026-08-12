"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireCapability, denyReadOnly } from "@/lib/authz";
import { createCategory, deleteCategory, MAX_CATEGORY_NAME } from "@/modules/items/categories.service";
import { ItemError } from "@/modules/items/items.errors";

/* Managing the device-category vocabulary requires MANAGE_ITEMS, enforced here
   on the server. requireCapability re-reads role, isActive and the capability
   grants from the DB per request, so a demoted or deactivated account — or one
   whose grant was revoked — loses it immediately. */

const nameSchema = z.object({
  name: z.string().trim().min(1, "Enter a category name.").max(MAX_CATEGORY_NAME),
});

export async function createCategoryAction(_prev: unknown, formData: FormData) {
  const admin = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(admin);
  if (denied) return denied;

  const parsed = nameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const { name } = await createCategory(parsed.data.name, admin.id);
    revalidatePath("/admin/categories");
    revalidatePath("/admin/analytics");
    return { ok: true, message: `Added "${name}".` };
  } catch (e) {
    // ItemError messages here are written for the user (a duplicate name, a
    // too-long name) and are safe to show. Anything else is logged server-side
    // and reported generically.
    if (e instanceof ItemError) return { error: e.message };
    console.error("[createCategoryAction] unexpected error:", e);
    return { error: "Something went wrong adding that category. Please try again." };
  }
}

export async function deleteCategoryAction(_prev: unknown, formData: FormData) {
  const actor = await requireCapability("MANAGE_ITEMS");
  const denied = denyReadOnly(actor);
  if (denied) return denied;

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Invalid input" };

  try {
    const { name } = await deleteCategory(id);
    revalidatePath("/admin/categories");
    revalidatePath("/admin/analytics");
    return { ok: true, message: `Removed "${name}".` };
  } catch (e) {
    if (e instanceof ItemError) return { error: e.message };
    console.error("[deleteCategoryAction] unexpected error:", e);
    return { error: "Something went wrong removing that category. Please try again." };
  }
}
