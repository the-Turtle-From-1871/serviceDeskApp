import { Prisma } from "@prisma/client";
import type { Item, Transfer } from "@prisma/client";
import prisma from "@/lib/prisma";
import { generateReceiptNumber } from "./receipt-number";
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
  // Retry once on the (astronomically unlikely) receipt-number collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id: itemId } });
        if (!item) throw new TransferError("ITEM_NOT_FOUND");
        if (item.status === "RETIRED") throw new TransferError("ITEM_RETIRED");
        return tx.transfer.create({
          data: {
            receiptNumber: generateReceiptNumber(),
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
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        if (attempt < 2) continue; // duplicate receiptNumber — regenerate
        throw new TransferError("RECEIPT_COLLISION"); // exhausted retries
      }
      throw e;
    }
  }
  // Unreachable: every loop iteration above either returns or throws.
  throw new TransferError("RECEIPT_COLLISION");
}

export function getTransferByReceiptNumber(receiptNumber: string): Promise<WithItem | null> {
  return prisma.transfer.findUnique({
    where: { receiptNumber: receiptNumber.toUpperCase() },
    include: { item: true },
  }) as Promise<WithItem | null>;
}

export function searchReceipts(query: string): Promise<WithItem[]> {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return prisma.transfer.findMany({
    where: {
      OR: [
        { receiptNumber: { equals: q.toUpperCase() } },
        { item: { is: { serialNumber: { equals: q, mode: "insensitive" } } } },
      ],
    },
    include: { item: true },
    orderBy: { createdAt: "desc" },
  }) as Promise<WithItem[]>;
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

export function getItemHistory(itemId: string): Promise<Transfer[]> {
  return prisma.transfer.findMany({ where: { itemId }, orderBy: { createdAt: "desc" } });
}
