"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createSignature, deleteSignature } from "@/modules/signatures/signatures.service";
import { newSignatureSchema } from "@/modules/signatures/signatures.schema";
import { SignatureError } from "@/modules/signatures/signatures.errors";

// Named signatures are an ADMIN capability: the only place a saved signature is
// used is the return flow, which is itself admin-only. The owner is always the
// authenticated admin — a userId is never accepted from the client.
export async function createSignatureAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newSignatureSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    image: String(formData.get("image") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await createSignature(admin.id, parsed.data);
  } catch (e) {
    if (e instanceof SignatureError && e.code === "DUPLICATE_NAME") {
      return { error: "You already have a signature saved under that name." };
    }
    console.error("[createSignatureAction] unexpected error:", e);
    return { error: "Something went wrong saving the signature. Please try again." };
  }
  revalidatePath("/account");
  return { ok: true as const };
}

export async function deleteSignatureAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  try {
    await deleteSignature(id, admin.id);
  } catch (e) {
    // A missing/foreign id is an expected no-op (double submit, stale page).
    if (!(e instanceof SignatureError)) {
      console.error("[deleteSignatureAction] unexpected error:", e);
    }
  }
  revalidatePath("/account");
}
