"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/authz";
import { saveDraft, deleteDraft, MAX_DRAFTS_PER_USER } from "@/modules/receipts/drafts.service";
import { DraftError } from "@/modules/receipts/drafts.errors";
import { receiptDraftSchema } from "@/modules/receipts/drafts.schema";
import { draftPayloadFromForm } from "@/modules/receipts/drafts.form";

export async function saveDraftAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();

  const parsed = receiptDraftSchema.safeParse(draftPayloadFromForm(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "That draft could not be saved." };
  }

  // Blank on a fresh builder; present once this form has been saved at least
  // once, so a second save updates rather than creating a duplicate.
  const draftId = String(formData.get("draftId") ?? "").trim() || undefined;

  try {
    const saved = await saveDraft(user.id, parsed.data, draftId);
    revalidatePath("/account");
    return { draftId: saved.id, savedAt: saved.updatedAt.getTime() };
  } catch (e) {
    if (e instanceof DraftError && e.code === "TOO_MANY") {
      return { error: `You have ${MAX_DRAFTS_PER_USER} saved drafts — delete one before saving another.` };
    }
    console.error("[saveDraftAction] unexpected error:", e);
    return { error: "Something went wrong saving the draft. Please try again." };
  }
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await deleteDraft(id, user.id);
  revalidatePath("/account");
}
