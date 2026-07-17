"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import {
  upsertServiceRequest,
  clearServiceRequest,
  completeServiceItem,
  reopenServiceItem,
} from "@/modules/service-queue/service-queue.service";
import { getCurrentOpenTransferId } from "@/modules/transfers/transfers.service";
import { ServiceQueueError } from "@/modules/service-queue/service-queue.errors";

// A blank/absent override means "use the type default" (undefined), not 0 —
// z.coerce.number() would otherwise turn "" into 0 and fail .positive().
const overrideDaysField = z
  .preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().max(3650).optional())
  .optional();

const idSchema = z.object({ id: z.string().min(1) });
const setSchema = z.object({
  itemId: z.string().min(1),
  serviceType: z.enum(["REIMAGE", "REPAIR", "OTHER"]),
  note: z.string().optional(),
  overrideDays: overrideDaysField,
});
const reopenSchema = z.object({ id: z.string().min(1), overrideDays: overrideDaysField });

function revalidateItem(itemId: string) {
  revalidatePath("/admin/queue");
  revalidatePath(`/i/${itemId}`);
}

// Flag/update an item's service request from the item detail page. Ties it to the
// item's current open receipt (if any). Returns a generic error string to the UI.
export async function setServiceAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  await requireAdmin();
  const parsed = setSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const transferId = await getCurrentOpenTransferId(parsed.data.itemId);
    await upsertServiceRequest({ ...parsed.data, transferId });
  } catch (e) {
    if (e instanceof ServiceQueueError && e.code === "NOTE_REQUIRED") {
      return { error: "Describe the service needed for 'Other'." };
    }
    console.error("[setServiceAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidateItem(parsed.data.itemId);
  return { ok: true };
}

// Unflag an item (remove its service request).
export async function clearServiceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  try {
    await clearServiceRequest(itemId);
  } catch (e) {
    console.error("[clearServiceAction] unexpected error:", e);
  }
  revalidateItem(itemId);
}

// Mark a queue item completed (from the queue or the item page).
export async function completeServiceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = idSchema.safeParse({ id: String(formData.get("id") ?? "") });
  if (!parsed.success) return;
  const itemId = String(formData.get("itemId") ?? "");
  try {
    await completeServiceItem(parsed.data.id);
  } catch (e) {
    if (!(e instanceof ServiceQueueError)) console.error("[completeServiceAction] unexpected error:", e);
  }
  revalidatePath("/admin/queue");
  if (itemId) revalidatePath(`/i/${itemId}`);
}

// Reopen a completed item back into the queue (from the item page). Restarts the
// SLA clock; an optional override days sets a custom new deadline.
export async function reopenServiceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = reopenSchema.safeParse({
    id: String(formData.get("id") ?? ""),
    overrideDays: String(formData.get("overrideDays") ?? ""),
  });
  if (!parsed.success) return;
  const itemId = String(formData.get("itemId") ?? "");
  try {
    await reopenServiceItem(parsed.data.id, parsed.data.overrideDays);
  } catch (e) {
    if (!(e instanceof ServiceQueueError)) console.error("[reopenServiceAction] unexpected error:", e);
  }
  revalidatePath("/admin/queue");
  if (itemId) revalidatePath(`/i/${itemId}`);
}
