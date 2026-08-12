"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin, denyReadOnly } from "@/lib/authz";
import { createContact, updateContact, deleteContact } from "@/modules/contacts/contacts.service";
import { newContactSchema, updateContactSchema } from "@/modules/contacts/contacts.schema";
import { ContactError } from "@/modules/contacts/contacts.errors";

// Mirrors admin/actions/users.ts: requireAdmin first, zod-parse the form, return
// a generic message to the client and log the detail server-side.
//
// Only /admin/users is revalidated. /receipts/new reads the book too, but it is
// dynamically rendered (it awaits auth() and searchParams), so it re-queries on
// every request and has no cache entry to bust.

const DUPLICATE = "A contact with that email already exists.";
const GENERIC = "Something went wrong.";

export async function createContactAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const denied = denyReadOnly(admin);
  if (denied) return denied;
  const parsed = newContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    // createdById comes from the verified session — never from the form.
    await createContact(parsed.data, admin.id);
  } catch (e) {
    if (e instanceof ContactError && e.code === "DUPLICATE_EMAIL") return { error: DUPLICATE };
    console.error("[createContactAction] failed:", e);
    return { error: GENERIC };
  }
  revalidatePath("/admin/users");
  return { ok: true as const };
}

export async function updateContactAction(_prev: unknown, formData: FormData) {
  const actor = await requireAdmin();
  const denied = denyReadOnly(actor);
  if (denied) return denied;
  const parsed = updateContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await updateContact(parsed.data);
  } catch (e) {
    if (e instanceof ContactError && e.code === "DUPLICATE_EMAIL") return { error: DUPLICATE };
    if (e instanceof ContactError && e.code === "NOT_FOUND") return { error: "That contact no longer exists." };
    console.error("[updateContactAction] failed:", e);
    return { error: GENERIC };
  }
  revalidatePath("/admin/users");
  return { ok: true as const };
}

export async function deleteContactAction(formData: FormData) {
  const actor = await requireAdmin();
  // void return: nowhere to render the refusal — the read-only
  // banner in the admin layout is what stops this reading as a bug.
  if (denyReadOnly(actor)) return;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  try {
    await deleteContact(id);
  } catch (e) {
    // Already gone (e.g. a double-submit or two admins deleting at once) is the
    // outcome the user wanted — don't turn it into a 500.
    if (!(e instanceof ContactError && e.code === "NOT_FOUND")) {
      console.error("[deleteContactAction] failed:", e);
      // Never rethrow the original error: Next.js only redacts thrown Server
      // Action errors to a generic digest in production — in dev it serializes
      // the real message to the client. Throw a new, generic one instead.
      throw new Error(GENERIC);
    }
  }
  revalidatePath("/admin/users");
}
