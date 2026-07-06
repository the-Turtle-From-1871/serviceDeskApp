"use server";
import { AuthError } from "next-auth";
import { Prisma } from "@prisma/client";
import { signIn, signOut } from "@/auth";
import { registerUser } from "@/modules/users/users.service";
import { registerSchema } from "@/modules/users/users.schema";

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
