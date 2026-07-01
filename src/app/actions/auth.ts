"use server";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { registerUser } from "@/modules/users/users.service";
import { registerSchema } from "@/modules/users/users.schema";

export async function registerAction(_prev: unknown, formData: FormData) {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await registerUser(parsed.data);
  } catch {
    return { error: "Could not create account — that email may already be registered." };
  }
  // Sign the new account in and send them to their dashboard.
  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/dashboard",
    });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Account created — please sign in." };
    throw error; // re-throw Next.js redirect
  }
}

export async function loginAction(_prev: unknown, formData: FormData) {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Invalid email or password." };
    throw error; // re-throw Next.js redirect
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
