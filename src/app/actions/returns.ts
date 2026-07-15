"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin, AuthError } from "@/lib/authz";
import { processReturn } from "@/modules/returns/returns.service";
import { sendReturnEmail } from "@/modules/returns/send-return-email";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { renderReceiptPdf } from "@/modules/receipts/render";
import { receiptUrl } from "@/modules/items/qr";
import type { ReturnPlan } from "@/modules/returns/plan";
import { signatureError } from "@/lib/signature";
import { getOwnedSignature } from "@/modules/signatures/signatures.service";

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

  // A saved pick arrives as an id only: re-read the name AND image from the DB,
  // scoped to this admin, so the signer identity cannot be forged from the
  // client. An ad-hoc drawn signature is recorded under the admin's own name.
  const signatureId = String(formData.get("signatureId") ?? "").trim();
  let signature: string;
  let signerName = admin.name;
  if (signatureId) {
    const owned = await getOwnedSignature(signatureId, admin.id);
    if (!owned) return { error: "That signature is no longer available. Pick another or draw one." };
    signature = owned.image;
    signerName = owned.name;
  } else {
    signature = String(formData.get("signature") ?? "");
    const sigErr = signatureError(signature);
    if (sigErr) return { error: sigErr };
  }

  try {
    const res = await processReturn({
      receiptNumber,
      selectedItemIds,
      signature,
      // `id` stays the real acting admin (accountability); `name` is whoever
      // actually signed, which is what the DA 2062 prints.
      processedBy: { id: admin.id, name: signerName, email: admin.email },
    });
    if ("error" in res) return { error: res.error };

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
