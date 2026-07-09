"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin, AuthError } from "@/lib/authz";
import { processReturn } from "@/modules/returns/returns.service";
import { sendReturnEmail } from "@/modules/returns/send-return-email";
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
      await sendReturnEmail({
        receiver: res.receiver,
        receiptNumber: res.receiptNumber,
        receiptUrl: receiptUrl(res.receiptNumber),
        kind: res.plan.kind,
        returned: res.plan.returned.map((r) => ({ serialNumber: r.serialNumber, make: r.make, model: r.model })),
        byLine: res.plan.byLine,
        processedByName: admin.name,
        processedByEmail: admin.email,
        processedAt: new Date(),
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
