import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { getItem } from "@/modules/items/items.service";
import { getItemHistory } from "@/modules/transfers/transfers.service";
import { ItemDetails } from "@/components/ItemDetails";
import { TransferHistory } from "@/components/TransferHistory";
import { InitiateTransferForm } from "@/components/InitiateTransferForm";
import { OverrideForm } from "@/components/OverrideForm";
import { StatusBadge } from "@/components/StatusBadge";

export default async function ItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const [session, history] = await Promise.all([auth(), getItemHistory(itemId)]);
  const viewerIsHolder = !!session?.user && item.currentHolderId === session.user.id;
  const isAdmin = session?.user.role === "ADMIN";

  const recipients = viewerIsHolder
    ? await prisma.user.findMany({
        where: { isActive: true, id: { not: session!.user.id } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  // Exclude the current holder so an admin can't record a no-op A→A override.
  const allUsers = isAdmin
    ? await prisma.user.findMany({
        where: { isActive: true, id: item.currentHolderId ? { not: item.currentHolderId } : undefined },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  const backHref = !session?.user ? "/login" : isAdmin ? "/admin/items" : "/dashboard";
  const backLabel = !session?.user ? "Sign in" : isAdmin ? "All items" : "Dashboard";

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </Link>
          <span className="spacer" />
          <Link href={backHref} className="btn btn-ghost btn-sm">{backLabel}</Link>
        </div>
      </header>

      <main className="container container-mid stack">
        <div className="row">
          <div>
            <h1 className="page-title">{item.make} {item.model}</h1>
            <p className="subtle">Serial {item.serialNumber}</p>
          </div>
          <span className="spacer" />
          <StatusBadge status={item.status} />
          {isAdmin && (
            <Link href={`/admin/items/${item.id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
          )}
        </div>

        <div className="card">
          <div className="card__title">Details</div>
          <ItemDetails item={item} />
        </div>

        <div className="card">
          <div className="card__title">Transfer history</div>
          <TransferHistory rows={history} />
        </div>

        {viewerIsHolder && item.status === "ACTIVE" && (
          <div className="card">
            <div className="card__title">Transfer this item</div>
            <InitiateTransferForm itemId={item.id} users={recipients} />
          </div>
        )}

        {isAdmin && (
          <div className="card">
            <div className="card__title">Admin override — force reassign</div>
            <p className="hint" style={{ marginBottom: 12 }}>
              Reassigns custody without the recipient signing. Recorded in the audit log as an override.
            </p>
            <OverrideForm itemId={item.id} users={allUsers} />
          </div>
        )}

        {!session?.user && (
          <p className="subtle"><Link href="/login">Sign in</Link> to transfer or sign for this item.</p>
        )}
      </main>
    </>
  );
}
