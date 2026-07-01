import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { cancelTransferAction } from "@/app/actions/transfers";
import { SignForm } from "./SignForm";

export default async function SignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const t = await prisma.transfer.findUnique({ where: { id } });
  if (!t) notFound();
  if (t.status !== "PENDING") redirect(`/i/${t.itemId}`);

  const isRecipient = t.toUserId === user.id;
  const isInitiator = t.fromUserId === user.id;

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/dashboard" className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </Link>
          <span className="spacer" />
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
        </div>
      </header>

      <main className="container container-narrow stack">
        <div>
          <h1 className="page-title" style={{ fontSize: 22 }}>Custody transfer</h1>
          <p className="subtle">{t.itemSummary}</p>
        </div>

        <div className="card stack">
          <div className="dl">
            <dt>From</dt><dd>{t.fromUserName ?? "—"}</dd>
            <dt>To</dt><dd>{t.toUserName}</dd>
          </div>

          {isRecipient && <SignForm transferId={t.id} />}

          {isInitiator && (
            <form action={cancelTransferAction}>
              <input type="hidden" name="transferId" value={t.id} />
              <p className="hint" style={{ marginBottom: 10 }}>
                Waiting for {t.toUserName} to sign. You can cancel this transfer until they accept.
              </p>
              <button type="submit" className="btn btn-danger">Cancel this transfer</button>
            </form>
          )}

          {!isRecipient && !isInitiator && (
            <p className="empty">You are not a party to this transfer.</p>
          )}
        </div>
      </main>
    </>
  );
}
