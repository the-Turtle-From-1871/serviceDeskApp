"use server";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";

export async function loginAction(_prev: unknown, formData: FormData) {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/new",
    });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Invalid email or password." };
    throw error; // re-throw Next.js redirect
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
