"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, denyReadOnly } from "@/lib/authz";
import { saveDraft, deleteDraft, MAX_DRAFTS_PER_USER } from "@/modules/receipts/drafts.service";
import { DraftError } from "@/modules/receipts/drafts.errors";
import { receiptDraftSchema } from "@/modules/receipts/drafts.schema";
import { draftPayloadFromForm } from "@/modules/receipts/drafts.form";

export async function saveDraftAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const denied = denyReadOnly(user);
  if (denied) return denied;

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
  // Returns void, so there is nowhere to render the refusal — the read-only
  // banner in the admin layout is what keeps this from looking like a bug.
  if (denyReadOnly(user)) return;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  try {
    await deleteDraft(id, user.id);
  } catch (e) {
    // A DB blip must not throw unhandled out of a plain form action — that
    // takes out /account via the error boundary for what is, worst case, a
    // draft that stays around to be deleted again. Same best-effort shape as
    // deleteSignatureAction (signatures.ts).
    console.error("[deleteDraftAction] unexpected error:", e);
  }
  revalidatePath("/account");
}

// Same delete, but for the /receipts/new TERMINAL cards (corrupt, all-items-
// gone, zero-items) rather than the /account list. Those cards render on a
// draft that can no longer be resumed, so after a successful delete the page
// would just re-run and hit `notFound()` (or, for the corrupt card, re-render
// the same "delete this" card) — the operator acted and landed on a 404,
// which reads as "the button did nothing". Redirecting to /account gives them
// a real place to land.
//
// Deliberately a SEPARATE action from `deleteDraftAction` rather than adding
// an unconditional redirect there: that action is shared with DraftList.tsx's
// own Delete button on /account itself, and its existing tests (and the
// account page's delete flow) assume a plain resolving Promise, not a thrown
// NEXT_REDIRECT. A redirect to /account FROM /account would be harmless, but
// it is an unrelated behavior change to a working, tested shared action for a
// bug that only exists on the terminal-card path — so it is scoped here
// instead.
export async function deleteDraftAndReturnToAccountAction(formData: FormData): Promise<never> {
  await deleteDraftAction(formData);
  redirect("/account");
}
