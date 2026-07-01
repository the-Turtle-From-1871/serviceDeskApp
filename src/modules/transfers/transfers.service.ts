import type { Transfer } from "@prisma/client";
import prisma from "@/lib/prisma";
import { TransferError } from "./transfers.errors";

export async function initiateTransfer(args: {
  itemId: string;
  fromUserId: string;
  toUserId: string;
}): Promise<Transfer> {
  const { itemId, fromUserId, toUserId } = args;
  if (fromUserId === toUserId) throw new TransferError("SAME_USER");

  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    if (!item) throw new TransferError("NOT_HOLDER");
    if (item.currentHolderId !== fromUserId) throw new TransferError("NOT_HOLDER");
    if (item.status === "RETIRED") throw new TransferError("ITEM_RETIRED");

    const recipient = await tx.user.findUnique({ where: { id: toUserId } });
    if (!recipient || !recipient.isActive) throw new TransferError("RECIPIENT_INVALID");

    const pending = await tx.transfer.findFirst({
      where: { itemId, status: "PENDING" },
    });
    if (pending) throw new TransferError("ALREADY_PENDING");

    const holder = await tx.user.findUnique({ where: { id: fromUserId } });
    return tx.transfer.create({
      data: {
        itemId,
        fromUserId,
        toUserId,
        status: "PENDING",
        fromUserName: holder?.name ?? null,
        toUserName: recipient.name,
        itemSummary: `${item.make} ${item.model} (SN ${item.serialNumber})`,
      },
    });
  });
}
