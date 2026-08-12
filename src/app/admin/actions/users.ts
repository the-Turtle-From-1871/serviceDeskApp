"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin, denyReadOnly } from "@/lib/authz";
import { createUser, setUserActive, setUserRole } from "@/modules/users/users.service";
import { newUserSchema } from "@/modules/users/users.schema";

export async function createUserAction(_prev: unknown, formData: FormData) {
  const actor = await requireAdmin();
  const denied = denyReadOnly(actor);
  if (denied) return denied;
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
  const admin = await requireAdmin();
  // void return: nowhere to render the refusal — the read-only
  // banner in the admin layout is what stops this reading as a bug.
  if (denyReadOnly(admin)) return;
  const id = String(formData.get("id"));
  const active = formData.get("active") === "true";
  // Guard against self-lockout: deactivating yourself now takes effect
  // immediately (JWT re-reads isActive), which would sign you out mid-action.
  if (id === admin.id && !active) return;
  await setUserActive(id, active);
  revalidatePath("/admin/users");
}

export async function setUserRoleAction(formData: FormData) {
  const admin = await requireAdmin();
  // void return: nowhere to render the refusal — the read-only
  // banner in the admin layout is what stops this reading as a bug.
  if (denyReadOnly(admin)) return;
  const id = String(formData.get("id"));
  const role = formData.get("role") === "ADMIN" ? "ADMIN" : "USER";
  // Guard against self-demotion: role changes are now live, so demoting
  // yourself would revoke your own admin access on the next request.
  if (id === admin.id && role !== "ADMIN") return;
  await setUserRole(id, role);
  revalidatePath("/admin/users");
}
