"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { setTransferDueAt } from "@/modules/transfers/transfers.service";
import { assertTransferOpen } from "@/modules/transfers/lifecycle";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { computeDueAt } from "@/modules/timers/due";

const schema = z.object({
  receiptNumber: z.string().min(1),
  // Blank clears the timer; otherwise a positive whole number of days from now.
  returnDays: z.string().optional(),
});

export async function setReceiptDueAtAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  await requireAdmin();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid input." };

  const raw = (parsed.data.returnDays ?? "").trim();
  let dueAt: Date | null = null;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0 || n > 3650) return { error: "Enter a whole number of days between 1 and 3650." };
    dueAt = computeDueAt(new Date(), n);
  }

  try {
    const t = await prisma.transfer.findUnique({
      where: { receiptNumber: parsed.data.receiptNumber.toUpperCase() },
      select: { id: true, status: true, closedAt: true },
    });
    if (!t) return { error: "Receipt not found." };
    assertTransferOpen(t); // throws TransferError("CLOSED") on a closed receipt
    await setTransferDueAt(t.id, dueAt);
  } catch (e) {
    if (e instanceof TransferError && e.code === "CLOSED") return { error: "This receipt is closed and cannot be changed." };
    console.error("[setReceiptDueAtAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath(`/receipts/${parsed.data.receiptNumber}`);
  return { ok: true };
}
