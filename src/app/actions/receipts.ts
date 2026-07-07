"use server";
import { requireUser } from "@/lib/authz";
import { createTransfer } from "@/modules/transfers/transfers.service";
import { receiptSchema } from "@/modules/transfers/transfers.schema";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { sendReceiptEmails } from "@/modules/receipts/send-receipt-email";
import { receiptUrl } from "@/modules/items/qr";
import { parseReceiptForm } from "./receipts.parse";

export async function createReceiptAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = parseReceiptForm(formData);
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  let receiptNumber: string;
  try {
    const t = await createTransfer({ ...parsed.data, createdByUserId: user.id });
    receiptNumber = t.receiptNumber;
    try {
      await sendReceiptEmails({
        sender: parsed.data.sender, receiver: parsed.data.receiver,
        receiptNumber: t.receiptNumber, receiptUrl: receiptUrl(t.receiptNumber), itemSummary: t.itemSummary,
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
