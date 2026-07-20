"use server";
import { AuthError } from "next-auth";
import { after } from "next/server";
import { signIn, signOut } from "@/auth";
import prisma from "@/lib/prisma";
import { emailField, passwordField } from "@/modules/users/users.schema";
import { createPasswordResetToken, resetPasswordWithToken } from "@/lib/password-reset";
import { sendPasswordResetEmail } from "@/modules/auth/send-password-reset-email";
import { defaultBaseUrl } from "@/lib/base-url";

// Minimum interval between reset emails for a single account (per-account
// cooldown) — throttles email-bombing of a known address.
const RESET_COOLDOWN_MS = 60_000;

// PUBLIC BY DESIGN: login/register are the unauthenticated entry to the auth
// flow — they cannot require a session (reviewed exception to "auth-first").
export async function loginAction(_prev: unknown, formData: FormData) {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/items",
    });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Invalid email or password." };
    throw error; // re-throw Next.js redirect
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/" });
}

// Emails a reset link to the account (if one exists). Always returns a generic
// success so it never reveals whether an email is registered.
export async function requestPasswordResetAction(_prev: unknown, formData: FormData) {
  // FIX #12: validate/normalize the email through the shared Zod field
  // (trims + lowercases + verifies it is a real email) instead of a hand-rolled
  // `.includes("@")` check.
  const parsed = emailField.safeParse(String(formData.get("email") ?? ""));
  if (!parsed.success) return { error: "Enter a valid email address." };
  const email = parsed.data;

  // FIX #2 (timing side-channel): schedule the account lookup + token creation +
  // email send to run AFTER the response is sent, then return the generic success
  // immediately. This makes the action return in ~constant time regardless of
  // whether the account exists, defeating enumeration via response timing.
  after(async () => {
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      // Silently no-op for unknown/inactive accounts (anti-enumeration).
      if (!user || !user.isActive) return;

      // FIX #1 (per-account cooldown): if a still-usable reset was created for
      // this account within the cooldown window, skip sending another one.
      const recent = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id, usedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (recent && Date.now() - recent.createdAt.getTime() < RESET_COOLDOWN_MS) return;

      // FIX #3 (base-url guard): never send a broken relative link. If no origin
      // is configured, log server-side and skip the send.
      const base = defaultBaseUrl().replace(/\/$/, "");
      if (!base) {
        console.error("[requestPasswordResetAction] no base URL configured (set APP_URL); skipping reset email");
        return;
      }

      const raw = await createPasswordResetToken(user.id);
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl: `${base}/reset-password?token=${raw}`,
      });
    } catch (e) {
      // Server-side-only logging; the client already received generic success.
      console.error("[requestPasswordResetAction] deferred work failed:", e);
    }
  });

  return { ok: true as const };
}

// Sets a new password from a valid reset token.
export async function resetPasswordAction(_prev: unknown, formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  // FIX #9: validate the password through the shared Zod field instead of a
  // manual length check.
  const parsed = passwordField.safeParse(password);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Password must be at least 8 characters." };
  if (password !== confirm) return { error: "Passwords do not match." };
  if (!token) return { error: "This reset link is invalid or has expired." };
  try {
    const ok = await resetPasswordWithToken(token, password);
    if (!ok) return { error: "This reset link is invalid or has expired." };
  } catch (e) {
    console.error("[resetPasswordAction] error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  return { ok: true as const };
}
