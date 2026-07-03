"use server";
import { redirect } from "next/navigation";
import { searchItemsBySerial } from "@/modules/items/items.service";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";

export type ItemResult = { id: string; make: string; model: string; serialNumber: string; status: string };

export async function searchAction(_prev: unknown, formData: FormData) {
  const mode = String(formData.get("mode") ?? "serial") === "receipt" ? "receipt" : "serial";
  const query = String(formData.get("query") ?? "").trim();
  if (!query) return { error: "Enter a search term." };

  if (mode === "receipt") {
    const t = await getTransferByReceiptNumber(query);
    if (!t) return { error: "No hand receipt found with that number." };
    redirect(`/receipts/${t.receiptNumber}`);
  }

  const items = await searchItemsBySerial(query);
  if (items.length === 0) return { error: "No items found with that serial number." };
  if (items.length === 1) redirect(`/i/${items[0].id}`);
  const results: ItemResult[] = items.map((i) => ({ id: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber, status: i.status }));
  return { results };
}
