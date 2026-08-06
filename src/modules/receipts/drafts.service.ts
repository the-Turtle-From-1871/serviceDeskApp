import "server-only";
import prisma from "@/lib/prisma";
import { receiptDraftSchema, formatDraftLabel, type ReceiptDraftPayload } from "./drafts.schema";
import { DraftError } from "./drafts.errors";

// Every read and write here is scoped by `userId`, and the scope is part of the
// WHERE clause (findFirst / updateMany / deleteMany) rather than a check after
// the fact — a mismatched owner therefore touches zero rows instead of throwing
// a Prisma error that a caller might swallow. Same shape as
// signatures.service.ts. Callers pass the id from the authenticated session;
// a userId is NEVER accepted from client input.

export const MAX_DRAFTS_PER_USER = 25;

export async function saveDraft(
  userId: string,
  payload: ReceiptDraftPayload,
  draftId?: string,
): Promise<{ id: string; updatedAt: Date }> {
  // Re-parse at the service boundary: this module is reachable from more than
  // one action, and the caps in the schema are the only thing bounding what
  // lands in an untyped Json column.
  const data = receiptDraftSchema.parse(payload);
  const denormalized = {
    payload: data,
    recipientName: data.receiver.name || null,
    itemCount: data.itemIds.length,
  };

  if (draftId) {
    // updateMany, so `userId` is part of the WHERE. count === 0 means the id
    // was bogus or belongs to someone else; fall through and create a new draft
    // rather than erroring — the operator's work must not be lost because a
    // stale tab held a since-deleted id.
    const { count } = await prisma.receiptDraft.updateMany({
      where: { id: draftId, userId },
      data: denormalized,
    });
    if (count === 1) {
      const row = await prisma.receiptDraft.findUniqueOrThrow({
        where: { id: draftId },
        select: { id: true, updatedAt: true },
      });
      return row;
    }
  }

  // The cap applies to CREATING a draft only; an update above has already
  // returned. Refusing (rather than pruning the oldest) is deliberate: silently
  // deleting the technician's own saved work is worse than a message they can
  // act on.
  const existing = await prisma.receiptDraft.count({ where: { userId } });
  if (existing >= MAX_DRAFTS_PER_USER) throw new DraftError("TOO_MANY");

  return prisma.receiptDraft.create({
    data: { ...denormalized, userId },
    select: { id: true, updatedAt: true },
  });
}

/** Newest first. Reads only the denormalized columns — a payload is never
 *  deserialized to render the list. */
export async function listDrafts(userId: string): Promise<{ id: string; label: string; updatedAt: Date }[]> {
  const rows = await prisma.receiptDraft.findMany({
    where: { userId },
    select: { id: true, recipientName: true, itemCount: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  // Built from the denormalized columns via the SHARED formatter, so the
  // account list and the builder can never word a label differently.
  return rows.map((r) => ({
    id: r.id,
    label: formatDraftLabel(r.recipientName, r.itemCount),
    updatedAt: r.updatedAt,
  }));
}

export async function getDraft(
  id: string,
  userId: string,
): Promise<{ id: string; payload: ReceiptDraftPayload; updatedAt: Date } | null> {
  const row = await prisma.receiptDraft.findFirst({
    where: { id, userId },
    select: { id: true, payload: true, updatedAt: true },
  });
  if (!row) return null;
  // A Json column is untyped at the DB level, so a payload written by an older
  // deploy (or by hand) must not be able to crash the builder. Report it as a
  // corrupt draft the operator can delete.
  const parsed = receiptDraftSchema.safeParse(row.payload);
  if (!parsed.success) throw new DraftError("CORRUPT");
  return { id: row.id, payload: parsed.data, updatedAt: row.updatedAt };
}

export async function deleteDraft(id: string, userId: string): Promise<void> {
  // deleteMany, so a foreign or bogus id is a no-op rather than a throw.
  await prisma.receiptDraft.deleteMany({ where: { id, userId } });
}
