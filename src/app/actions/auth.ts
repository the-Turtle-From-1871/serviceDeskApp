"use server";
import { AuthError } from "next-auth";
import { Prisma } from "@prisma/client";
import { signIn, signOut } from "@/auth";
import prisma from "@/lib/prisma";
import { registerUser } from "@/modules/users/users.service";
import { registerSchema } from "@/modules/users/users.schema";
import { createPasswordResetToken, resetPasswordWithToken } from "@/lib/password-reset";
import { sendPasswordResetEmail } from "@/modules/auth/send-password-reset-email";

function appBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const v = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return v ? `https://${v}` : "";
}

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

export async function registerAction(_prev: unknown, formData: FormData) {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await registerUser(parsed.data);
  } catch (err) {
    // Only a duplicate email (unique-constraint violation) gets the "already
    // registered" message; anything else is an unexpected failure — log it so
    // a real outage is visible rather than mislabeled as a duplicate email.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "That email is already registered." };
    }
    console.error("[registerAction] registerUser failed:", err);
    return { error: "Could not create your account — please try again." };
  }
  try {
    await signIn("credentials", { email: parsed.data.email, password: parsed.data.password, redirectTo: "/items" });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Account created — please sign in." };
    throw error; // re-throw Next.js redirect
  }
}

// Emails a reset link to the account (if one exists). Always returns a generic
// success so it never reveals whether an email is registered.
export async function requestPasswordResetAction(_prev: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { error: "Enter a valid email address." };
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.isActive) {
      const raw = await createPasswordResetToken(user.id);
      try {
        await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl: `${appBaseUrl()}/reset-password?token=${raw}` });
      } catch (e) {
        console.error("[requestPasswordResetAction] email send failed:", e);
      }
    }
  } catch (e) {
    console.error("[requestPasswordResetAction] error:", e);
  }
  return { ok: true as const };
}

// Sets a new password from a valid reset token.
export async function resetPasswordAction(_prev: unknown, formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
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
