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
    <main style={{ fontFamily: "system-ui", maxWidth: 480, margin: "2rem auto" }}>
      <h1>Transfer of {t.itemSummary}</h1>
      <p>From {t.fromUserName ?? "—"} to {t.toUserName}</p>
      {isRecipient && <SignForm transferId={t.id} />}
      {isInitiator && (
        <form action={cancelTransferAction}>
          <input type="hidden" name="transferId" value={t.id} />
          <button type="submit">Cancel this transfer</button>
        </form>
      )}
      {!isRecipient && !isInitiator && <p>You are not a party to this transfer.</p>}
    </main>
  );
}
