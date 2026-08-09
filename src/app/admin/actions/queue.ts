"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/authz";
import {
  upsertServiceRequest,
  clearServiceRequest,
  completeServiceItem,
  reopenServiceItem,
  setServiceDeadline,
} from "@/modules/service-queue/service-queue.service";
import { getCurrentOpenTransferId } from "@/modules/transfers/transfers.service";
import { ServiceQueueError } from "@/modules/service-queue/service-queue.errors";
import { parseOverrideDays } from "@/modules/service-queue/service-form";

const idSchema = z.object({ id: z.string().min(1) });
const setSchema = z.object({
  itemId: z.string().min(1),
  serviceType: z.enum(["REIMAGE", "REPAIR", "OTHER"]),
  note: z.string().optional(),
});

function revalidateItem(itemId: string) {
  revalidatePath("/admin/queue");
  revalidatePath(`/i/${itemId}`);
}

// Flag/update an item's service request from the item detail page. Ties it to the
// item's current open receipt (if any).
//
// `overrideDays` is only ever posted when the item is NOT yet flagged — the flag
// form drops the field once a request exists, and the deadline moves to its own
// control (setServiceDeadlineAction). So on a new flag a blank field means no
// deadline (dueAt null, never a default), and updating an existing request sends
// nothing about the deadline and therefore cannot move it. Returns a generic
// error string to the UI.
export async function setServiceAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  await requireCapability("MANAGE_QUEUE");
  const parsed = setSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const transferId = await getCurrentOpenTransferId(parsed.data.itemId);
    const overrideDays = parseOverrideDays(formData.get("overrideDays"));
    await upsertServiceRequest({ ...parsed.data, overrideDays, transferId });
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

// Set or clear an already-flagged item's completion deadline, from its own
// single-purpose form on the item page. This is the ONLY write that can remove a
// deadline — the whole point of separating it (see setServiceDeadline).
//
// Validation deliberately mirrors setReceiptDueAtAction rather than the graceful
// collapse the other service entry points use: blank clears, but a non-blank
// value that is not a whole 1–3650 is REJECTED with a message instead of being
// treated as blank. This control is destructive, so "3650000" must not read as
// "wipe it". parseOverrideDays keeps doing the range check; only the blank case
// is distinguished before calling it, and the non-destructive surfaces (receipt
// builder, flag, reopen) keep its never-throw/never-block behavior untouched.
export async function setServiceDeadlineAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  await requireCapability("MANAGE_QUEUE");
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return { error: "Invalid input." };
  const raw = String(formData.get("overrideDays") ?? "").trim();
  let days: number | null = null;
  if (raw) {
    const parsed = parseOverrideDays(raw);
    if (parsed === undefined) return { error: "Enter a whole number of days between 1 and 3650." };
    days = parsed;
  }
  try {
    await setServiceDeadline(itemId, days);
  } catch (e) {
    if (e instanceof ServiceQueueError && e.code === "NOT_FOUND") {
      return { error: "This item is not flagged for service." };
    }
    console.error("[setServiceDeadlineAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidateItem(itemId);
  return { ok: true };
}

// Unflag an item (remove its service request).
export async function clearServiceAction(formData: FormData): Promise<void> {
  await requireCapability("MANAGE_QUEUE");
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
  await requireCapability("MANAGE_QUEUE");
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

// Reopen a completed item back into the queue (from the item page). Reopening
// starts a NEW ROUND of service, so the deadline is always written fresh: a days
// value sets now + days, and a blank or malformed one reopens with NO deadline.
// It deliberately does not carry the finished round's date over — that inherited
// a lapsed deadline (the reopened item read "Overdue Nd" immediately) and, since
// the alert stamp is cleared here, re-sent an overdue email for a deadline that
// had already alerted. Either way the reopen always proceeds — it never silently
// no-ops on a bad days value.
export async function reopenServiceAction(formData: FormData): Promise<void> {
  await requireCapability("MANAGE_QUEUE");
  const parsed = idSchema.safeParse({ id: String(formData.get("id") ?? "") });
  if (!parsed.success) return;
  const itemId = String(formData.get("itemId") ?? "");
  const overrideDays = parseOverrideDays(formData.get("overrideDays"));
  try {
    await reopenServiceItem(parsed.data.id, overrideDays);
  } catch (e) {
    if (!(e instanceof ServiceQueueError)) console.error("[reopenServiceAction] unexpected error:", e);
  }
  revalidatePath("/admin/queue");
  if (itemId) revalidatePath(`/i/${itemId}`);
}
