"use server";
import { searchReceipts } from "@/modules/transfers/transfers.service";

export type ReceiptResult = {
  receiptNumber: string;
  itemSummary: string;
  fromLabel: string;
  toLabel: string;
};

function label(isDcsim: boolean, name: string, rank: string | null): string {
  if (isDcsim) return `DCSIM · ${name}`;
  return rank ? `${rank} ${name}` : name;
}

export async function searchReceiptsAction(_prev: unknown, formData: FormData) {
  const query = String(formData.get("query") ?? "").trim();
  if (!query) return { error: "Enter a serial number or receipt number." };
  const rows = await searchReceipts(query);
  const results: ReceiptResult[] = rows.map((t) => ({
    receiptNumber: t.receiptNumber,
    itemSummary: t.itemSummary,
    fromLabel: label(t.senderIsDcsim, t.senderName, t.senderRank),
    toLabel: label(t.receiverIsDcsim, t.receiverName, t.receiverRank),
  }));
  return { results };
}
