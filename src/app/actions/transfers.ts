"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { initiateTransfer, acceptTransfer, cancelTransfer } from "@/modules/transfers/transfers.service";
import { TransferError } from "@/modules/transfers/transfers.errors";

export async function initiateTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const itemId = String(formData.get("itemId"));
  const toUserId = String(formData.get("toUserId"));
  try {
    await initiateTransfer({ itemId, fromUserId: user.id, toUserId });
    revalidatePath(`/i/${itemId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TransferError) return { error: humanize(e.code) };
    throw e;
  }
}

function humanize(code: string): string {
  const map: Record<string, string> = {
    NOT_HOLDER: "You are not the current holder of this item.",
    ALREADY_PENDING: "This item already has a pending transfer.",
    ITEM_RETIRED: "This item is retired and cannot be transferred.",
    RECIPIENT_INVALID: "That recipient is not available.",
    SAME_USER: "You cannot transfer an item to yourself.",
  };
  return map[code] ?? "Could not start the transfer.";
}

export async function acceptTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const transferId = String(formData.get("transferId"));
  const signatureImage = String(formData.get("signature"));
  try {
    await acceptTransfer({ transferId, toUserId: user.id, signatureImage });
  } catch (e) {
    if (e instanceof TransferError) {
      return { error: e.code === "SIGNATURE_REQUIRED" ? "Please sign before accepting." : "Could not accept this transfer." };
    }
    throw e;
  }
  redirect("/dashboard");
}

export async function cancelTransferAction(formData: FormData) {
  const user = await requireUser();
  const transferId = String(formData.get("transferId"));
  await cancelTransfer({ transferId, actingUserId: user.id, isAdmin: user.role === "ADMIN" });
  redirect("/dashboard");
}
