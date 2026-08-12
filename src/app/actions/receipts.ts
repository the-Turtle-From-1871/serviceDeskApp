"use server";
import { Prisma } from "@prisma/client";
import { requireUser, denyReadOnly, AuthError } from "@/lib/authz";
import { createTransfer, getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { receiptSchema } from "@/modules/transfers/transfers.schema";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { isTransferClosed } from "@/modules/transfers/lifecycle";
import { sendReceiptEmails } from "@/modules/receipts/send-receipt-email";
import { sendPickupEmail, customerParty, pickupItems } from "@/modules/receipts/send-pickup-email";
import { renderReceiptPdf } from "@/modules/receipts/render";
import { receiptLinkUrl } from "@/modules/items/qr";
import { upsertServiceRequest } from "@/modules/service-queue/service-queue.service";
import { parseServiceMap } from "@/modules/service-queue/service-form";
import { parseReceiptForm } from "./receipts.parse";
import { getOwnedSignature } from "@/modules/signatures/signatures.service";
import { upsertContactFromParty } from "@/modules/contacts/contacts.service";
import { computeDueAt } from "@/modules/timers/due";
import { deleteDraft } from "@/modules/receipts/drafts.service";

export async function createReceiptAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const denied = denyReadOnly(user);
  if (denied) return denied;
  const raw = parseReceiptForm(formData);

  // A picked saved signature posts ONLY its id. Resolve the signer's name and
  // image from the DB, scoped to the acting user, and overwrite whatever the
  // client posted for them — so a crafted POST can forge neither the name
  // printed on the DA 2062 nor the ink under it, and cannot borrow another
  // user's signature. Runs BEFORE safeParse so receiptSchema still sees a
  // normal name + PNG data URL and needs no change.
  const signatureId = String(formData.get("signatureId") ?? "").trim();
  if (signatureId) {
    // ADMIN-only, checked on the ROLE rather than relying on getOwnedSignature
    // finding nothing. A demoted admin keeps their Signature rows, so an
    // ownership-only check would let them keep using a capability that was
    // revoked. Roles are re-read from the DB per request, so this takes effect
    // immediately on demotion.
    if (user.role !== "ADMIN") {
      console.warn(`[createReceiptAction] rejected signatureId from non-admin ${user.id}`);
      return { error: "A saved signature can only be used when the recipient is DCSIM." };
    }
    // DCSIM-only, enforced here and not merely hidden in the UI: a saved
    // signature must never land on an outside recipient, who has to sign in
    // person. Mirrors notifyPickupAction's guard below.
    if (!raw.receiver.isDcsim) {
      console.warn("[createReceiptAction] rejected signatureId on a non-DCSIM recipient");
      return { error: "A saved signature can only be used when the recipient is DCSIM." };
    }
    const owned = await getOwnedSignature(signatureId, user.id);
    if (!owned) return { error: "That signature is no longer available. Pick another or draw one." };
    raw.receiver.name = owned.name;
    raw.receiverSignature = owned.image;
  }

  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  // [Service Queue] Parse per-item "Needs service?" selections and constrain
  // them to items actually on this receipt (ignore any stray itemIds that
  // showed up in the service[...] form keys but weren't submitted as items).
  //
  // Gated on a DCSIM recipient: "Needs service?" is only offered on the builder
  // when the recipient is DCSIM (the queue is for kit coming in to the desk).
  // The UI hides it for a non-DCSIM recipient; dropping the selections here too
  // means a crafted POST can't enqueue service against an outside recipient.
  const receiptItemIds = new Set(parsed.data.itemIds);
  const serviceMap = new Map(
    (parsed.data.receiver.isDcsim ? [...parseServiceMap(formData)] : [])
      .filter(([itemId]) => receiptItemIds.has(itemId)),
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
    const dueAt = parsed.data.returnDays ? computeDueAt(new Date(), parsed.data.returnDays) : null;
    const t = await createTransfer({ ...parsed.data, createdByUserId: user.id, dueAt });
    receiptNumber = t.receiptNumber;

    // The receipt is filed, so its draft has served its purpose. Best-effort
    // in the same style as the email block below: the receipt already exists
    // and is authoritative, so a failed cleanup is logged, never surfaced as a
    // failed receipt. A stale draft is harmless; a receipt that reports failure
    // after being filed is not.
    const draftId = String(formData.get("draftId") ?? "").trim();
    if (draftId) {
      try {
        await deleteDraft(draftId, user.id);
      } catch (err) {
        console.error(`[createReceiptAction] draft cleanup failed for ${draftId}:`, err);
      }
    }

    // Save each OUTSIDE party into the shared contact book, so the next receipt
    // for this person autofills from the ContactCombobox instead of being
    // re-typed. Both sides are considered, not just the receiver: either party
    // can be an outside person — a recipient being issued kit, or a sender
    // handing it back — which is the same `!isDcsim` gate the combobox uses to
    // decide whether to offer the book at all. A DCSIM party is one of our own
    // technicians, who has an account and is not in the book.
    //
    // Best-effort, in the same style as the blocks around it: the receipt is
    // filed and authoritative, so a book hiccup is logged and never surfaced as
    // a failed receipt. The role — not the email — goes in the log line, so
    // party PII stays out of the server logs.
    // The SENDER is create-only. Its four fields are seeded on load from
    // `senderPrefill` (receipts/new/page.tsx), which is `getLastReceiver` — the
    // FROZEN party snapshot on the item's open receipt, which can be months
    // old. On a turn-in the operator usually leaves them untouched, so treating
    // them as "the most recent thing we know" is backwards: refreshing from
    // them would revert an admin's correction to that contact's unit or phone
    // number using data older than the correction. Creating from them is still
    // right — an outside person handing kit back who is not in the book yet is
    // exactly who the book is missing. The RECEIVER is typed (or picked) fresh
    // for this receipt, so that side refreshes.
    for (const [role, party] of [["sender", parsed.data.sender], ["receiver", parsed.data.receiver]] as const) {
      if (party.isDcsim) continue;
      try {
        await upsertContactFromParty(party, user.id, { refreshExisting: role === "receiver" });
      } catch (err) {
        // Scrubbed: `err` itself must not be serialized here. A Prisma
        // validation error embeds the offending arguments in its message, which
        // on this path are the party's name, unit, phone and email — so logging
        // the raw error would put party PII in the server logs and quietly
        // break the claim in docs/SECURITY.md §2. Name and Prisma code are
        // enough to tell a constraint violation from an outage.
        const code = err instanceof Prisma.PrismaClientKnownRequestError ? ` (${err.code})` : "";
        const name = err instanceof Error ? err.name : typeof err;
        console.error(`[createReceiptAction] contact save failed for the ${role}: ${name}${code}`);
      }
    }

    // [Service Queue] For each item flagged "Needs service?" on the form, create
    // an item-level service request tied to this receipt. Best-effort ONLY for
    // genuine DB/write hiccups — selection validity was already checked above,
    // so a queue hiccup here must not fail the already-created receipt.
    for (const [itemId, sel] of serviceMap) {
      try {
        await upsertServiceRequest({ itemId, serviceType: sel.serviceType, note: sel.note, overrideDays: sel.overrideDays, transferId: t.id });
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
        receiptNumber: t.receiptNumber, receiptUrl: await receiptLinkUrl(t.receiptNumber), items,
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
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { error: "You are not authorized to send notifications." };
    throw e;
  }
  // Sending the pickup email also stamps the receipt, and it puts real mail in
  // a real person's inbox — not something a demo should be able to do.
  const denied = denyReadOnly(user);
  if (denied) return denied;

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
      receiptUrl: await receiptLinkUrl(t.receiptNumber),
      items,
    });
  } catch (e) {
    console.error("[notifyPickupAction] pickup email failed:", e);
    return { error: "Could not send the notification. Please try again." };
  }
  return { ok: true as const };
}
