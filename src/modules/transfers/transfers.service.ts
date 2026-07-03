import type { Item, Transfer } from "@prisma/client";
import prisma from "@/lib/prisma";
import { TransferError } from "./transfers.errors";
import type { PartyInput, TransferInput } from "./transfers.schema";

type WithItem = Transfer & { item: Item };

function itemSummary(i: { make: string; model: string; serialNumber: string }): string {
  return `${i.make} ${i.model} (SN ${i.serialNumber})`;
}

export async function createTransfer(
  input: TransferInput & { createdByUserId?: string }
): Promise<Transfer> {
  const { itemId, sender, receiver, receiverSignature, createdByUserId } = input;
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    if (!item) throw new TransferError("ITEM_NOT_FOUND");
    if (item.status === "RETIRED") throw new TransferError("ITEM_RETIRED");
    // Sequential, gap-tolerant receipt number. nextval is atomic across
    // concurrent transactions, so no collision handling is needed. pg may
    // return the value as bigint or string; String() handles both.
    const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('receipt_number_seq') AS n`;
    const receiptNumber = `HR-${String(rows[0].n).padStart(6, "0")}`;
    return tx.transfer.create({
      data: {
        receiptNumber,
        itemId,
        itemSummary: itemSummary(item),
        senderIsDcsim: sender.isDcsim,
        senderName: sender.name,
        senderRank: sender.rank ?? null,
        senderUnit: sender.unit ?? null,
        senderContact: sender.contact ?? null,
        senderEmail: sender.email ?? null,
        receiverIsDcsim: receiver.isDcsim,
        receiverName: receiver.name,
        receiverRank: receiver.rank ?? null,
        receiverUnit: receiver.unit ?? null,
        receiverContact: receiver.contact ?? null,
        receiverEmail: receiver.email ?? null,
        receiverSignature,
        createdByUserId: createdByUserId ?? null,
        status: "COMPLETED",
      },
    });
  });
}

export function getTransferByReceiptNumber(receiptNumber: string): Promise<WithItem | null> {
  return prisma.transfer.findUnique({
    where: { receiptNumber: receiptNumber.toUpperCase() },
    include: { item: true },
  }) as Promise<WithItem | null>;
}

export function listReceiptsForItem(itemId: string): Promise<Transfer[]> {
  return prisma.transfer.findMany({ where: { itemId }, orderBy: { createdAt: "desc" } });
}

export async function getLastReceiver(itemId: string): Promise<PartyInput | null> {
  const last = await prisma.transfer.findFirst({
    where: { itemId, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  if (!last) return null;
  return {
    isDcsim: last.receiverIsDcsim,
    name: last.receiverName,
    rank: last.receiverRank ?? undefined,
    unit: last.receiverUnit ?? undefined,
    contact: last.receiverContact ?? undefined,
    email: last.receiverEmail ?? undefined,
  };
}
