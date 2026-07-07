import { notFound } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { getLastReceiver } from "@/modules/transfers/transfers.service";
import { groupItemsIntoLines, MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";
import { SiteHeader } from "@/components/SiteHeader";
import { ReceiptBuilderForm } from "./ReceiptBuilderForm";

export default async function NewReceiptPage({ searchParams }: { searchParams: Promise<{ items?: string }> }) {
  await requireUser();
  const { items: itemsParam } = await searchParams;
  const ids = (itemsParam ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) notFound();

  const loaded = (await Promise.all(ids.map((id) => getItem(id)))).filter((i) => i && i.status === "ACTIVE") as NonNullable<Awaited<ReturnType<typeof getItem>>>[];
  if (loaded.length === 0) notFound();

  const lines = groupItemsIntoLines(loaded.map((i) => ({ itemId: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber })));
  const tooMany = lines.length > MAX_RECEIPT_ROWS;
  const tooManyPerRow = lines.some((l) => l.serials.length > MAX_ITEMS_PER_ROW);

  // Sender prefill only when every item shares an identical last receiver.
  const lastReceivers = await Promise.all(loaded.map((i) => getLastReceiver(i.id)));
  const first = lastReceivers[0];
  const allSame = first != null && lastReceivers.every((r) => r && JSON.stringify(r) === JSON.stringify(first));
  const senderPrefill = allSame
    ? (first!.isDcsim ? { isDcsim: true, name: first!.name } : { isDcsim: false, name: first!.name, rank: first!.rank ?? "", unit: first!.unit ?? "", contact: first!.contact ?? "", email: first!.email ?? "" })
    : undefined;

  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <h1 className="page-title">New hand receipt</h1>
        {tooMany ? (
          <div className="card empty">This selection has {lines.length} item types — the form holds {MAX_RECEIPT_ROWS}. Split it into two receipts.</div>
        ) : tooManyPerRow ? (
          <div className="card empty">One item type has more than {MAX_ITEMS_PER_ROW} items on a single row. Split that item across two receipts.</div>
        ) : (
          <ReceiptBuilderForm
            itemIds={loaded.map((i) => i.id)}
            lines={lines.map((l) => ({ make: l.make, model: l.model, serials: l.serials, defaultQty: l.defaultQty }))}
            senderPrefill={senderPrefill}
          />
        )}
      </main>
    </>
  );
}
