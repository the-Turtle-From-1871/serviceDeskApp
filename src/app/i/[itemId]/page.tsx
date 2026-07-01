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

  const allUsers = isAdmin
    ? await prisma.user.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "2rem auto" }}>
      <h1>{item.make} {item.model}</h1>
      <ItemDetails item={item} />
      <section id="history">
        <h2>Transfer history</h2>
        <TransferHistory rows={history} />
      </section>
      {viewerIsHolder && item.status === "ACTIVE" && (
        <section>
          <h2>Transfer this item</h2>
          <InitiateTransferForm itemId={item.id} users={recipients} />
        </section>
      )}
      {isAdmin && (
        <section>
          <h2>Admin override — force reassign</h2>
          <OverrideForm itemId={item.id} users={allUsers} />
        </section>
      )}
      {!session?.user && <p><Link href="/login">Sign in</Link> to transfer or sign for this item.</p>}
    </main>
  );
}
