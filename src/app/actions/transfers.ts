"use server";
import { requireUser } from "@/lib/authz";
import { createItem } from "@/modules/items/items.service";
import { newItemSchema } from "@/modules/items/items.schema";
import { createTransfer, getLastReceiver } from "@/modules/transfers/transfers.service";
import { transferSchema } from "@/modules/transfers/transfers.schema";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { sendReceiptEmails } from "@/modules/receipts/send-receipt-email";
import { receiptUrl } from "@/modules/items/qr";
import { parseTransferForm } from "./transfers.parse";

export async function createTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = parseTransferForm(formData);

  // Validate party/signature/both-DCSIM rules FIRST, before touching the
  // database. A placeholder itemId (real id for "existing" mode, a non-empty
  // sentinel for "new" mode) satisfies the `.min(1)` check without requiring
  // an Item to exist yet — this way a rejected transfer never leaves an
  // orphan Item behind.
  const itemIdPlaceholder = raw.itemMode === "new" ? "pending" : raw.itemId ?? "";
  const parsed = transferSchema.safeParse({
    itemId: itemIdPlaceholder,
    sender: raw.sender,
    receiver: raw.receiver,
    receiverSignature: raw.receiverSignature,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  // Only now — once the transfer payload is known valid — resolve the item,
  // creating it when in "new" mode.
  let itemId = parsed.data.itemId;
  if (raw.itemMode === "new") {
    const parsedItem = newItemSchema.safeParse(raw.newItem);
    if (!parsedItem.success) return { error: parsedItem.error.issues[0]?.message ?? "Invalid item" };
    const item = await createItem(parsedItem.data, user.id);
    itemId = item.id;
  }

  let receiptNumber: string;
  let t: Awaited<ReturnType<typeof createTransfer>>;
  try {
    t = await createTransfer({ ...parsed.data, itemId, createdByUserId: user.id });
    receiptNumber = t.receiptNumber;
  } catch (e) {
    if (e instanceof TransferError) {
      const map: Record<string, string> = {
        ITEM_NOT_FOUND: "That item no longer exists.",
        ITEM_RETIRED: "That item is retired and cannot be transferred.",
        RECEIPT_COLLISION: "Could not allocate a receipt number — please retry.",
      };
      return { error: map[e.code] ?? "Could not create the receipt." };
    }
    throw e;
  }

  try {
    await sendReceiptEmails({
      sender: parsed.data.sender,
      receiver: parsed.data.receiver,
      receiptNumber: t.receiptNumber,
      receiptUrl: receiptUrl(t.receiptNumber),
      itemSummary: t.itemSummary,
    });
  } catch (err) {
    console.error("[createTransferAction] receipt email failed:", err);
  }

  return { receiptNumber };
}

// Imperatively invoked by the /new form when an existing item is selected, to
// pre-fill the sender from the item's last-known holder. Auth-gated.
export async function lookupLastHolderAction(itemId: string) {
  await requireUser();
  if (!itemId) return null;
  return getLastReceiver(itemId);
}
