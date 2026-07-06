"use server";
import { requireUser } from "@/lib/authz";
import { createTransfer } from "@/modules/transfers/transfers.service";
import { transferSchema } from "@/modules/transfers/transfers.schema";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { sendReceiptEmails } from "@/modules/receipts/send-receipt-email";
import { receiptUrl } from "@/modules/items/qr";
import { parseTransferForm } from "./transfers.parse";

export async function createTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = parseTransferForm(formData);

  const parsed = transferSchema.safeParse({
    itemId: raw.itemId,
    sender: raw.sender,
    receiver: raw.receiver,
    receiverSignature: raw.receiverSignature,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  let receiptNumber: string;
  let t: Awaited<ReturnType<typeof createTransfer>>;
  try {
    t = await createTransfer({ ...parsed.data, createdByUserId: user.id });
    receiptNumber = t.receiptNumber;
  } catch (e) {
    if (e instanceof TransferError) {
      const map: Record<string, string> = {
        ITEM_NOT_FOUND: "That item no longer exists.",
        ITEM_RETIRED: "That item is retired and cannot be transferred.",
      };
      return { error: map[e.code] ?? "Could not create the receipt." };
    }
    // Unexpected failure: log the detail server-side, return a generic message.
    console.error("[createTransferAction] unexpected error:", e);
    return { error: "Something went wrong creating the receipt. Please try again." };
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
