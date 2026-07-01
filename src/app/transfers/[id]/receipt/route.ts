import { requireUser, AuthError } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { buildHandReceiptPdf } from "@/modules/receipts/hand-receipt";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.code, { status: 401 });
    throw e;
  }
  const { id } = await params;
  const t = await prisma.transfer.findUnique({ where: { id }, include: { item: true } });
  if (!t) return new Response("Not found", { status: 404 });

  // Admins can pull any receipt; everyone else only for transfers they were a party to.
  const isParty = t.fromUserId === user.id || t.toUserId === user.id;
  if (user.role !== "ADMIN" && !isParty) return new Response("FORBIDDEN", { status: 403 });

  const bytes = await buildHandReceiptPdf({
    id: t.id,
    fromUserName: t.fromUserName,
    toUserName: t.toUserName,
    status: t.status,
    isOverride: t.isOverride,
    signatureImage: t.signatureImage,
    initiatedAt: t.initiatedAt,
    signedAt: t.signedAt,
    item: {
      make: t.item.make,
      model: t.item.model,
      serialNumber: t.item.serialNumber,
      assetTag: t.item.assetTag,
    },
  });

  const filename = `hand-receipt-${t.id.slice(0, 8)}.pdf`;
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
