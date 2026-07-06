import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { getItem } from "@/modules/items/items.service";
import { getLastReceiver } from "@/modules/transfers/transfers.service";
import { SignOutButton } from "@/components/SignOutButton";
import { AppHeader } from "@/components/AppHeader";
import { ItemTransferForm } from "./ItemTransferForm";

export default async function ItemTransferPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const item = await getItem(id);
  if (!item) notFound();

  const [dbUser, last] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { rank: true, name: true, unit: true, contactNumber: true, email: true, role: true } }),
    getLastReceiver(id),
  ]);

  // Sender pre-fill precedence: item's last-known holder > non-admin operator's
  // own account > empty (admin/DCSIM operators type the sender).
  const isAdmin = dbUser?.role === "ADMIN";
  const senderPrefill = last
    ? (last.isDcsim
        ? { isDcsim: true, name: last.name }
        : { isDcsim: false, name: last.name, rank: last.rank ?? "", unit: last.unit ?? "", contact: last.contact ?? "", email: last.email ?? "" })
    : (isAdmin ? undefined : { isDcsim: false, name: dbUser?.name ?? user.name, rank: dbUser?.rank ?? "", unit: dbUser?.unit ?? "", contact: dbUser?.contactNumber ?? "", email: dbUser?.email ?? user.email });

  return (
    <>
      <AppHeader brandHref="/">
        <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
        <SignOutButton />
      </AppHeader>
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Transfer: {item.make} {item.model}</h1>
          <p className="subtle">Serial {item.serialNumber}</p>
        </div>
        {item.status === "RETIRED" ? (
          <div className="card empty">This item is retired and cannot be transferred.</div>
        ) : (
          <ItemTransferForm itemId={item.id} senderPrefill={senderPrefill} />
        )}
      </main>
    </>
  );
}
