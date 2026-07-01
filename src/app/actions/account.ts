"use server";
import { z } from "zod";
import { requireUser } from "@/lib/authz";
import { changeUserPassword } from "@/modules/users/users.service";
import { PasswordChangeError } from "@/modules/users/users.errors";

const schema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
  confirmPassword: z.string(),
});

export async function changePasswordAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const { currentPassword, newPassword, confirmPassword } = parsed.data;
  if (newPassword !== confirmPassword) return { error: "New passwords do not match." };
  if (newPassword === currentPassword) {
    return { error: "New password must be different from your current one." };
  }

  try {
    await changeUserPassword(user.id, currentPassword, newPassword);
  } catch (e) {
    if (e instanceof PasswordChangeError) return { error: "Your current password is incorrect." };
    throw e;
  }
  return { ok: true };
}
