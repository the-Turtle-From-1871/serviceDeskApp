import { notFound, redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { SiteHeader } from "@/components/SiteHeader";
import { ReturnForm } from "./ReturnForm";

export default async function ReturnPage({ params }: { params: Promise<{ receiptNumber: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) notFound();
  if (t.status !== "OPEN") redirect(`/receipts/${t.receiptNumber}`);

  const held = t.lines.flatMap((l) =>
    l.items
      .filter((it) => it.returnedAt === null)
      .map((it) => ({ transferItemId: it.id, serialNumber: it.serialNumber, make: l.make, model: l.model, lineNo: l.lineNo }))
  );

  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <h1 className="page-title">Process return — {t.receiptNumber}</h1>
        <p className="subtle">Check off each serial number physically turned in. Returning every held item closes the receipt.</p>
        <ReturnForm receiptNumber={t.receiptNumber} held={held} />
      </main>
    </>
  );
}
