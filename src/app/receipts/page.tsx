import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCapability, AuthError } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { SiteHeader } from "@/components/SiteHeader";
import { listReceipts } from "@/modules/transfers/transfers.service";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  let user;
  try {
    // VIEW_INVENTORY is the baseline every signed-in account holds, so this
    // gates on "signed in" without re-deriving what that means. Whether the
    // list is scoped is a SEPARATE capability, below.
    user = await requireCapability("VIEW_INVENTORY");
  } catch (e) {
    if (e instanceof AuthError) redirect("/login");
    throw e;
  }

  const all = user.capabilities.includes("VIEW_ALL_RECEIPTS");

  // The VERIFIED address only. An unverified one is an unproved claim about
  // somebody else's mailbox — matching on it would show this account their
  // receipts.
  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, emailVerifiedAt: true },
  });
  const viewerEmail = me?.emailVerifiedAt ? me.email : null;

  const { cursor } = await searchParams;
  const { rows, nextCursor } = await listReceipts({ viewerEmail, all, cursor });

  return (
    <>
      <SiteHeader />
      <main className="container container-wide stack">
        <div>
          <h1 className="page-title">{all ? "All hand receipts" : "Your hand receipts"}</h1>
          {/* Said explicitly, so an empty list is never read as "there are no
              receipts" when it means "none with your name on them". */}
          <p className="subtle">
            {all
              ? "Every hand receipt on file, newest first."
              : "Hand receipts where you are the issuing or receiving party, newest first."}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="card stack">
            <p className="subtle" style={{ margin: 0 }}>
              {all
                ? "No hand receipts have been filed yet."
                : "No hand receipts name you yet. When equipment is issued to you, the receipt will appear here."}
            </p>
            {!all && (
              <p className="subtle" style={{ margin: 0 }}>
                Looking for a specific receipt? You can open any receipt by its number from{" "}
                <Link href="/">the search page</Link>.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Items</th>
                    <th>Issued by</th>
                    <th>Issued to</th>
                    <th>Date</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Receipt" className="mono">
                        <Link href={`/receipts/${r.receiptNumber}`}>{r.receiptNumber}</Link>
                      </td>
                      <td data-label="Items">{r.itemSummary}</td>
                      <td data-label="Issued by">{r.senderName}</td>
                      <td data-label="Issued to">{r.receiverName}</td>
                      <td data-label="Date">{r.createdAt.toLocaleDateString()}</td>
                      <td data-label="Status"><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor && (
              <div className="row">
                <Link className="btn btn-secondary" href={`/receipts?cursor=${nextCursor}`}>
                  Load more
                </Link>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
