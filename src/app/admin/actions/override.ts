"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { overrideAssign } from "@/modules/transfers/transfers.service";
import { TransferError } from "@/modules/transfers/transfers.errors";

export async function overrideAssignAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const itemId = String(formData.get("itemId"));
  const toUserId = String(formData.get("toUserId"));
  try {
    await overrideAssign({ itemId, toUserId, actingAdminId: admin.id });
    revalidatePath(`/i/${itemId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TransferError) return { error: "Could not reassign this item." };
    throw e;
  }
}
