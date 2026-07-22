"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyPin } from "@/lib/public-access";
import {
  signUnlockValue,
  unlockCookieName,
  sanitizeNext,
  UNLOCK_MAX_AGE_SECONDS,
  UNLOCK_TTL_MS,
} from "@/lib/public-access-cookie";

// PUBLIC BY DESIGN: this is the one server action with no requireUser — it gates
// on the PIN itself. Verifies the 8-digit PIN against the bcrypt hash, then mints
// a 7-day HMAC-signed unlock cookie the edge proxy can self-verify.
const schema = z.object({ pin: z.string().regex(/^\d{8}$/), next: z.string().optional() });

export async function unlockAction(_prev: unknown, formData: FormData) {
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter the 8-digit PIN." };

  let ok = false;
  try {
    ok = await verifyPin(parsed.data.pin);
  } catch (e) {
    console.error("[unlockAction] verifyPin failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  if (!ok) {
    // Slow down online guessing; also masks "no PIN set" vs "wrong PIN".
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Incorrect PIN." };
  }

  const secret = process.env.AUTH_SECRET ?? "";
  const secure = process.env.NODE_ENV === "production";
  const value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, secret);
  const store = await cookies();
  store.set(unlockCookieName(secure), value, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: UNLOCK_MAX_AGE_SECONDS,
  });

  redirect(sanitizeNext(parsed.data.next));
}
