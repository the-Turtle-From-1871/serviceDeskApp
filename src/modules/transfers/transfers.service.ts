import type { Item, Transfer } from "@prisma/client";
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

export async function acceptTransfer(args: {
  transferId: string;
  toUserId: string;
  signatureImage: string;
}): Promise<Transfer> {
  const { transferId, toUserId, signatureImage } = args;
  if (!signatureImage || !signatureImage.startsWith("data:image/")) {
    throw new TransferError("SIGNATURE_REQUIRED");
  }
  return prisma.$transaction(async (tx) => {
    const t = await tx.transfer.findUnique({ where: { id: transferId } });
    if (!t) throw new TransferError("NOT_PENDING");
    if (t.status !== "PENDING") throw new TransferError("NOT_PENDING");
    if (t.toUserId !== toUserId) throw new TransferError("NOT_RECIPIENT");

    await tx.item.update({ where: { id: t.itemId }, data: { currentHolderId: toUserId } });
    return tx.transfer.update({
      where: { id: transferId },
      data: { status: "COMPLETED", signatureImage, signedAt: new Date() },
    });
  });
}

export async function cancelTransfer(args: {
  transferId: string;
  actingUserId: string;
  isAdmin: boolean;
}): Promise<Transfer> {
  const { transferId, actingUserId, isAdmin } = args;
  return prisma.$transaction(async (tx) => {
    const t = await tx.transfer.findUnique({ where: { id: transferId } });
    if (!t) throw new TransferError("NOT_PENDING");
    if (t.status !== "PENDING") throw new TransferError("NOT_PENDING");
    if (!isAdmin && t.fromUserId !== actingUserId) throw new TransferError("NOT_HOLDER");
    return tx.transfer.update({
      where: { id: transferId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
  });
}

export async function overrideAssign(args: {
  itemId: string;
  toUserId: string;
  actingAdminId: string;
}): Promise<Transfer> {
  const { itemId, toUserId, actingAdminId } = args;
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    if (!item) throw new TransferError("NOT_HOLDER");
    const recipient = await tx.user.findUnique({ where: { id: toUserId } });
    if (!recipient || !recipient.isActive) throw new TransferError("RECIPIENT_INVALID");

    await tx.transfer.updateMany({
      where: { itemId, status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await tx.item.update({ where: { id: itemId }, data: { currentHolderId: toUserId } });

    const fromUser = item.currentHolderId
      ? await tx.user.findUnique({ where: { id: item.currentHolderId } })
      : null;
    return tx.transfer.create({
      data: {
        itemId,
        fromUserId: item.currentHolderId,
        toUserId,
        status: "COMPLETED",
        isOverride: true,
        actingAdminId,
        signedAt: new Date(),
        fromUserName: fromUser?.name ?? null,
        toUserName: recipient.name,
        itemSummary: `${item.make} ${item.model} (SN ${item.serialNumber})`,
      },
    });
  });
}

export function getItemHistory(itemId: string): Promise<Transfer[]> {
  return prisma.transfer.findMany({ where: { itemId }, orderBy: { initiatedAt: "desc" } });
}

export async function getPendingForUser(userId: string) {
  const [incoming, outgoing] = await Promise.all([
    prisma.transfer.findMany({
      where: { toUserId: userId, status: "PENDING" },
      orderBy: { initiatedAt: "desc" },
    }),
    prisma.transfer.findMany({
      where: { fromUserId: userId, status: "PENDING" },
      orderBy: { initiatedAt: "desc" },
    }),
  ]);
  return { incoming, outgoing };
}

export function getHeldItems(userId: string): Promise<Item[]> {
  return prisma.item.findMany({
    where: { currentHolderId: userId },
    orderBy: { updatedAt: "desc" },
  });
}
