"use server";
import { z } from "zod";
import { signOut } from "@/auth";
import { requireUser } from "@/lib/authz";
import { changeUserPassword, updateUserSignature } from "@/modules/users/users.service";
import { PasswordChangeError } from "@/modules/users/users.errors";
import { signatureError } from "@/lib/signature";

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
    // Unexpected failure: log the detail server-side, return a generic message.
    console.error("[changePasswordAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }

  // changeUserPassword stamps passwordChangedAt, which revokes every JWT issued
  // before this instant — including the one this request arrived on. Sign the
  // caller out explicitly so they land on /login with an explanation, rather
  // than getting silently bounced on whatever they clicked next.
  //
  // Deliberately OUTSIDE the try above: signOut redirects by throwing
  // NEXT_REDIRECT, and that catch would swallow it into a generic error toast
  // while the password had in fact already changed.
  await signOut({ redirectTo: "/login?passwordChanged=1" });
  // Unreachable — signOut always throws to redirect. Kept so the action's
  // return type stays honest for useActionState.
  return { ok: true };
}

export async function saveSignatureAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = String(formData.get("signature") ?? "");
  const clear = formData.get("clear") === "1";

  if (clear) {
    try {
      await updateUserSignature(user.id, null);
    } catch (e) {
      console.error("[saveSignatureAction] clear failed:", e);
      return { error: "Something went wrong. Please try again." };
    }
    return { ok: true as const };
  }

  const err = signatureError(raw);
  if (err) return { error: err };
  try {
    await updateUserSignature(user.id, raw);
  } catch (e) {
    console.error("[saveSignatureAction] save failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  return { ok: true as const };
}
