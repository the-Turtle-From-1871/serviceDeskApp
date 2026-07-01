"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createUser, setUserActive } from "@/modules/users/users.service";
import { newUserSchema } from "@/modules/users/users.schema";

export async function createUserAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const parsed = newUserSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await createUser(parsed.data);
  } catch {
    return { error: "Could not create user (email may already exist)." };
  }
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function toggleUserActiveAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const active = formData.get("active") === "true";
  await setUserActive(id, active);
  revalidatePath("/admin/users");
}
