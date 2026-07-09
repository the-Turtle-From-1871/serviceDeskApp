import prisma from "@/lib/prisma";
import { planReturn, type HeldItem, type ReturnPlan } from "./plan";
import { ReturnError } from "./returns.errors";

export type ProcessReturnInput = {
  receiptNumber: string;
  selectedItemIds: string[];
  processedBy: { id: string; name: string; email: string };
};

export type ProcessReturnResult =
  | { plan: ReturnPlan; receiptNumber: string; receiver: { isDcsim: boolean; name: string; email: string | null } }
  | { error: string };

// Everything runs inside one transaction so the receipt is read, validated, and
// mutated atomically, avoiding a race on the OPEN->CLOSED transition. Postgres/
// Prisma default to READ COMMITTED, so the transaction alone does not stop two
// concurrent calls from reading the same "held" snapshot — the compare-and-swap
// below (updateMany scoped to returnedAt: null, then asserting the affected
// count) is what actually prevents a double-return of the same item.
export async function processReturn(input: ProcessReturnInput): Promise<ProcessReturnResult> {
  const { receiptNumber, selectedItemIds, processedBy } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      const receipt = await tx.transfer.findUnique({
        where: { receiptNumber: receiptNumber.toUpperCase() },
        include: { lines: { orderBy: { lineNo: "asc" }, include: { items: true } } },
      });
      if (!receipt) throw new ReturnError("NOT_FOUND", "Receipt not found.");
      if (receipt.status !== "OPEN") throw new ReturnError("CLOSED", "This receipt is already closed.");

      const held: HeldItem[] = receipt.lines.flatMap((l) =>
        l.items
          .filter((it) => it.returnedAt === null)
          .map((it) => ({ transferItemId: it.id, serialNumber: it.serialNumber, make: l.make, model: l.model, lineNo: l.lineNo }))
      );

      const { plan, error } = planReturn(held, selectedItemIds);
      if (error || !plan) throw new ReturnError("INVALID", error ?? "Invalid return.");

      const returnedIds = plan.returned.map((r) => r.transferItemId);
      const result = await tx.transferItem.updateMany({
        where: { id: { in: returnedIds }, returnedAt: null },
        data: { returnedAt: new Date() },
      });
      if (result.count !== returnedIds.length) {
        throw new ReturnError("INVALID", "One or more items were already returned by a concurrent transaction. Please retry.");
      }

      if (plan.kind === "FULL") {
        await tx.transfer.update({ where: { id: receipt.id }, data: { status: "CLOSED" } });
      }

      await tx.returnTransaction.create({
        data: {
          transferId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          kind: plan.kind,
          processedByUserId: processedBy.id,
          processedByName: processedBy.name,
          processedByEmail: processedBy.email,
          returned: plan.returned.map((r) => ({ serialNumber: r.serialNumber, make: r.make, model: r.model })),
          returnedCount: plan.returned.length,
          remainingCount: plan.remaining.length,
        },
      });

      return {
        plan,
        receiptNumber: receipt.receiptNumber,
        receiver: { isDcsim: receipt.receiverIsDcsim, name: receipt.receiverName, email: receipt.receiverEmail },
      };
    });
  } catch (e) {
    if (e instanceof ReturnError) return { error: e.message };
    throw e;
  }
}

export function listReturnsForReceipt(transferId: string) {
  return prisma.returnTransaction.findMany({ where: { transferId }, orderBy: { createdAt: "asc" } });
}
