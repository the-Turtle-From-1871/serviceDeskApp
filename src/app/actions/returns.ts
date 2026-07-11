"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin, AuthError } from "@/lib/authz";
import { processReturn } from "@/modules/returns/returns.service";
import { sendReturnEmail } from "@/modules/returns/send-return-email";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { renderReceiptPdf } from "@/modules/receipts/render";
import { receiptUrl } from "@/modules/items/qr";
import type { ReturnPlan } from "@/modules/returns/plan";
import { updateUserSignature } from "@/modules/users/users.service";
import { signatureError } from "@/lib/signature";

type Result = { ok: true; plan: ReturnPlan; receiptNumber: string; closed: boolean } | { error: string };

export async function processReturnAction(_prev: unknown, formData: FormData): Promise<Result> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) return { error: "You are not authorized to process returns." };
    throw e;
  }

  const receiptNumber = String(formData.get("receiptNumber") ?? "");
  const verified = formData.get("verified") === "on";
  if (!verified) return { error: "You must confirm you physically verified the serial numbers before submitting." };

  const selectedItemIds = formData.getAll("itemId").map(String).filter(Boolean);
  if (selectedItemIds.length === 0) return { error: "Select at least one serial number to return." };

  const signature = String(formData.get("signature") ?? "");
  const sigErr = signatureError(signature);
  if (sigErr) return { error: sigErr };
  const saveSignature = formData.get("saveSignature") === "on";

  try {
    const res = await processReturn({
      receiptNumber,
      selectedItemIds,
      signature,
      processedBy: { id: admin.id, name: admin.name, email: admin.email },
    });
    if ("error" in res) return { error: res.error };

    if (saveSignature) {
      try { await updateUserSignature(admin.id, signature); }
      catch (err) { console.error("[processReturnAction] save signature failed:", err); }
    }

    revalidatePath(`/receipts/${res.receiptNumber}`);
    revalidatePath("/admin/audit");

    try {
      let pdf: Uint8Array | undefined;
      try { pdf = (await renderReceiptPdf(res.receiptNumber)) ?? undefined; }
      catch (err) { console.error("[processReturnAction] pdf render for email failed:", err); }
      const returned = res.plan.returned.map((r) => ({ make: r.make, model: r.model, serialNumber: r.serialNumber }));
      const remaining = res.plan.remaining.map((r) => ({ make: r.make, model: r.model, serialNumber: r.serialNumber }));
      // A full return closes the receipt; list every item on it. Only load that
      // when needed (the partial "UPDATED" body uses returned + remaining).
      let allItems: { make: string; model: string; serialNumber: string }[] = [];
      if (res.plan.kind === "FULL") {
        const full = await getTransferByReceiptNumber(res.receiptNumber);
        allItems = (full?.lines ?? []).flatMap((ln) => ln.items.map((it) => ({ make: ln.make, model: ln.model, serialNumber: it.serialNumber })));
      }
      await sendReturnEmail({
        receiver: res.receiver,
        receiptNumber: res.receiptNumber,
        receiptUrl: receiptUrl(res.receiptNumber),
        kind: res.plan.kind,
        returned,
        remaining,
        allItems,
        pdf,
      });
    } catch (err) {
      console.error("[processReturnAction] return email failed:", err);
    }

    return { ok: true, plan: res.plan, receiptNumber: res.receiptNumber, closed: res.plan.kind === "FULL" };
  } catch (e) {
    console.error("[processReturnAction] unexpected error:", e);
    return { error: "Something went wrong processing the return. Please try again." };
  }
}
