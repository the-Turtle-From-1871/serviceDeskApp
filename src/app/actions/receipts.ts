"use server";
import { requireUser, AuthError } from "@/lib/authz";
import { createTransfer, getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { receiptSchema } from "@/modules/transfers/transfers.schema";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { isTransferClosed } from "@/modules/transfers/lifecycle";
import { sendReceiptEmails } from "@/modules/receipts/send-receipt-email";
import { sendPickupEmail, customerParty, pickupItems } from "@/modules/receipts/send-pickup-email";
import { renderReceiptPdf } from "@/modules/receipts/render";
import { receiptUrl } from "@/modules/items/qr";
import { upsertServiceRequest } from "@/modules/service-queue/service-queue.service";
import { parseServiceMap } from "@/modules/service-queue/service-form";
import { parseReceiptForm } from "./receipts.parse";

export async function createReceiptAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = parseReceiptForm(formData);
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  // [Service Queue] Parse per-item "Needs service?" selections and constrain
  // them to items actually on this receipt (ignore any stray itemIds that
  // showed up in the service[...] form keys but weren't submitted as items).
  const receiptItemIds = new Set(parsed.data.itemIds);
  const serviceMap = new Map(
    [...parseServiceMap(formData)].filter(([itemId]) => receiptItemIds.has(itemId)),
  );

  // Validate up front — OTHER requires a non-empty note — so a bad selection
  // fails fast and loudly before anything is created. (HTML5 `required` can be
  // bypassed with JS off or a crafted POST; upsertServiceRequest would throw
  // ServiceQueueError("NOTE_REQUIRED") for it, but by then the per-item write
  // is best-effort and would silently swallow the failure.)
  for (const [, sel] of serviceMap) {
    if (sel.serviceType === "OTHER" && !sel.note) {
      return { error: "Please describe the service needed for items marked “Other”." };
    }
  }

  let receiptNumber: string;
  try {
    const t = await createTransfer({ ...parsed.data, createdByUserId: user.id });
    receiptNumber = t.receiptNumber;

    // [Service Queue] For each item flagged "Needs service?" on the form, create
    // an item-level service request tied to this receipt. Best-effort ONLY for
    // genuine DB/write hiccups — selection validity was already checked above,
    // so a queue hiccup here must not fail the already-created receipt.
    for (const [itemId, sel] of serviceMap) {
      try {
        await upsertServiceRequest({ itemId, serviceType: sel.serviceType, note: sel.note, transferId: t.id });
      } catch (err) {
        console.error(`[createReceiptAction] service enqueue failed for item ${itemId}:`, err);
      }
    }

    try {
      let pdf: Uint8Array | undefined;
      try { pdf = (await renderReceiptPdf(t.receiptNumber)) ?? undefined; }
      catch (err) { console.error("[createReceiptAction] pdf render for email failed:", err); }
      const full = await getTransferByReceiptNumber(t.receiptNumber);
      const items = (full?.lines ?? []).flatMap((ln) => ln.items.map((it) => ({ make: ln.make, model: ln.model, serialNumber: it.serialNumber })));
      await sendReceiptEmails({
        sender: parsed.data.sender, receiver: parsed.data.receiver,
        receiptNumber: t.receiptNumber, receiptUrl: receiptUrl(t.receiptNumber), items,
        pdf,
      });
    } catch (err) { console.error("[createReceiptAction] receipt email failed:", err); }
  } catch (e) {
    if (e instanceof TransferError) {
      const map: Record<string, string> = {
        ITEM_NOT_FOUND: "One of the selected items no longer exists.",
        ITEM_RETIRED: "One of the selected items is retired and cannot be transferred.",
        TOO_MANY_LINES: "Too many item types for one receipt — split into two receipts.",
        TOO_MANY_PER_ROW: "Too many of one item on a single row — max 10 per make+model. Split into two receipts.",
      };
      return { error: map[e.code] ?? "Could not create the receipt." };
    }
    console.error("[createReceiptAction] unexpected error:", e);
    return { error: "Something went wrong creating the receipt. Please try again." };
  }
  return { receiptNumber };
}

// Staff-initiated: email the customer (non-DCSIM party) that the items on this
// hand receipt are ready for pickup. Returns { ok } or { error } for the UI.
export async function notifyPickupAction(_prev: unknown, formData: FormData) {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { error: "You are not authorized to send notifications." };
    throw e;
  }

  const receiptNumber = String(formData.get("receiptNumber") ?? "").trim();
  if (!receiptNumber) return { error: "Missing receipt." };

  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) return { error: "Receipt not found." };
  if (isTransferClosed(t)) return { error: "This receipt is closed — nothing to pick up." };

  // Pickup notifications are DCSIM-only: reject the event unless the recipient
  // (the receiver) is DCSIM. Mirrors the UI, which hides the button otherwise —
  // this backend check is the authoritative guard against a forged submission.
  if (!t.receiverIsDcsim) {
    console.warn(`[notifyPickupAction] rejected non-DCSIM pickup notify for ${t.receiptNumber}`);
    return { error: "Pickup notifications are not available for this receipt." };
  }

  const customer = customerParty(t);
  if (!customer?.email) return { error: "No email on file for the customer." };

  const items = pickupItems(t);
  if (items.length === 0) return { error: "No items are awaiting pickup on this receipt." };

  try {
    await sendPickupEmail({
      customerName: customer.name,
      customerEmail: customer.email,
      receiptNumber: t.receiptNumber,
      receiptUrl: receiptUrl(t.receiptNumber),
      items,
    });
  } catch (e) {
    console.error("[notifyPickupAction] pickup email failed:", e);
    return { error: "Could not send the notification. Please try again." };
  }
  return { ok: true as const };
}
