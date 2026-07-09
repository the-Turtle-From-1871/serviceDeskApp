import type { Transfer, TransferLine, TransferItem } from "@prisma/client";
import prisma from "@/lib/prisma";
import { TransferError } from "./transfers.errors";
import type { PartyInput, LineQtyInput } from "./transfers.schema";
import { groupItemsIntoLines, buildItemSummary, MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "./receipt-lines";

export type ReceiptWithLines = Transfer & { lines: (TransferLine & { items: TransferItem[] })[] };

type CreateInput = {
  itemIds: string[];
  lines: LineQtyInput[];
  sender: PartyInput;
  receiver: PartyInput;
  receiverSignature: string;
  createdByUserId?: string;
};

const qtyKey = (l: { make: string; model: string }) => `${l.make} ${l.model}`;

export async function createTransfer(input: CreateInput): Promise<Transfer> {
  const { itemIds, lines: lineQtys, sender, receiver, receiverSignature, createdByUserId } = input;
  return prisma.$transaction(async (tx) => {
    const items = await tx.item.findMany({ where: { id: { in: itemIds } } });
    if (items.length !== new Set(itemIds).size) throw new TransferError("ITEM_NOT_FOUND");
    if (items.some((i) => i.status === "RETIRED")) throw new TransferError("ITEM_RETIRED");

    // Authoritative server-side grouping — never trust client line composition.
    // Dedupe first so a repeated itemId can't produce two TransferItem rows for
    // one physical item (nothing in the schema blocks that at the DB level).
    const byId = new Map(items.map((i) => [i.id, i]));
    const uniqueIds = [...new Set(itemIds)];
    const grouped = groupItemsIntoLines(uniqueIds.map((id) => {
      const i = byId.get(id)!;
      return { itemId: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber };
    }));
    if (grouped.length > MAX_RECEIPT_ROWS) throw new TransferError("TOO_MANY_LINES");
    if (grouped.some((g) => g.serials.length > MAX_ITEMS_PER_ROW)) throw new TransferError("TOO_MANY_PER_ROW");

    // Match submitted qtyAuth/qtyIssued to each server group by make+model.
    const qtyByKey = new Map(lineQtys.map((l) => [qtyKey(l), l]));

    const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('receipt_number_seq') AS n`;
    const receiptNumber = `HR-${String(rows[0].n).padStart(6, "0")}`;

    return tx.transfer.create({
      data: {
        receiptNumber,
        itemSummary: buildItemSummary(grouped),
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
        status: "OPEN",
        lines: {
          create: grouped.map((g) => {
            const q = qtyByKey.get(qtyKey(g));
            return {
              lineNo: g.lineNo,
              make: g.make,
              model: g.model,
              unitOfIssue: g.unitOfIssue,
              qtyAuth: q?.qtyAuth ?? g.defaultQty,
              qtyIssued: q?.qtyIssued ?? g.defaultQty,
              items: { create: g.itemIds.map((itemId, idx) => ({ itemId, serialNumber: g.serials[idx] })) },
            };
          }),
        },
      },
    });
  });
}

export function getTransferByReceiptNumber(receiptNumber: string): Promise<ReceiptWithLines | null> {
  return prisma.transfer.findUnique({
    where: { receiptNumber: receiptNumber.toUpperCase() },
    include: { lines: { orderBy: { lineNo: "asc" }, include: { items: true } } },
  }) as Promise<ReceiptWithLines | null>;
}

// Partial, case-insensitive receipt-number search (for the live type-ahead),
// so results appear as the user types — mirroring searchItemsBySerial. Capped.
export function searchReceiptsByNumber(q: string): Promise<{ receiptNumber: string; itemSummary: string }[]> {
  const s = q.trim();
  if (!s) return Promise.resolve([]);
  // Select only the two fields the public search renders — never pull the
  // signature blob / contact PII of up to 50 rows on every keystroke.
  return prisma.transfer.findMany({
    where: { receiptNumber: { contains: s, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { receiptNumber: true, itemSummary: true },
  });
}

export function listReceiptsForItem(itemId: string): Promise<Transfer[]> {
  return prisma.transfer.findMany({
    where: { lines: { some: { items: { some: { itemId } } } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getLastReceiver(itemId: string): Promise<PartyInput | null> {
  const last = await prisma.transfer.findFirst({
    where: { lines: { some: { items: { some: { itemId } } } } },
    orderBy: { createdAt: "desc" },
  });
  // Only the most-recent transfer reflects current custody; a CLOSED receipt
  // means the item was returned, so there is no current holder to prefill.
  if (!last || last.status !== "OPEN") return null;
  return {
    isDcsim: last.receiverIsDcsim,
    name: last.receiverName,
    rank: last.receiverRank ?? undefined,
    unit: last.receiverUnit ?? undefined,
    contact: last.receiverContact ?? undefined,
    email: last.receiverEmail ?? undefined,
  };
}
