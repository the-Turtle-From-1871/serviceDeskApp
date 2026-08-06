import "server-only";
import { Prisma } from "@prisma/client";
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
      // findFirst, so `userId` stays in the WHERE for this follow-up read too —
      // never findUniqueOrThrow by bare id. Also tolerates a raced delete
      // between the updateMany above and this read: `row` comes back null and
      // we fall through to the create path below instead of throwing P2025.
      const row = await prisma.receiptDraft.findFirst({
        where: { id: draftId, userId },
        select: { id: true, updatedAt: true },
      });
      if (row) return row;
    }
  }

  // The cap applies to CREATING a draft only; an update above has already
  // returned. Refusing (rather than pruning the oldest) is deliberate: silently
  // deleting the technician's own saved work is worse than a message they can
  // act on.
  return createDraftUnderCap(userId, denormalized);
}

type Denormalized = {
  payload: ReceiptDraftPayload;
  recipientName: string | null;
  itemCount: number;
};

// count() then create() is check-then-act: two concurrent saves can each
// observe count() < cap and both create, letting a user end up over the cap.
// Running both inside a single Serializable transaction makes Postgres
// serialize the two attempts instead — the loser re-executes against the
// true, post-winner count. Serializable transactions can abort with a
// serialization failure purely from that concurrency, with no cap involved at
// all, so that failure is retried here rather than being reported as
// TOO_MANY (wrong: might not be at cap) or allowed to escape as a raw error
// (wrong: a transient conflict isn't a real failure the caller should see).
//
// The @prisma/adapter-pg driver surfaces Postgres's serialization_failure as
// a `DriverAdapterError` (from `@prisma/driver-adapter-utils`, a transitive
// dependency we don't import directly) wrapping the raw `pg` error, rather
// than as the engine-level `PrismaClientKnownRequestError` P2034 — so this
// checks the underlying Postgres SQLSTATE instead of either package's own
// error class. 40001 = serialization_failure, 40P01 = deadlock_detected
// (Serializable can produce either under contention).
function isSerializationConflict(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") return true;
  const cause = (e as { cause?: unknown } | null)?.cause;
  const originalCode = (cause as { originalCode?: unknown } | null | undefined)?.originalCode;
  return originalCode === "40001" || originalCode === "40P01";
}

const MAX_SERIALIZATION_RETRIES = 5;

async function createDraftUnderCap(
  userId: string,
  denormalized: Denormalized,
): Promise<{ id: string; updatedAt: Date }> {
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.receiptDraft.count({ where: { userId } });
          if (existing >= MAX_DRAFTS_PER_USER) throw new DraftError("TOO_MANY");
          return tx.receiptDraft.create({
            data: { ...denormalized, userId },
            select: { id: true, updatedAt: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      if (e instanceof DraftError) throw e;
      if (isSerializationConflict(e) && attempt < MAX_SERIALIZATION_RETRIES) continue;
      throw e;
    }
  }
  // Unreachable — the loop above always returns or throws.
  throw new DraftError("TOO_MANY");
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
