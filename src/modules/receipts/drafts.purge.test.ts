import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { saveDraft, purgeStaleDrafts, DRAFT_RETENTION_DAYS } from "./drafts.service";
import { receiptDraftSchema } from "./drafts.schema";

let userId: string;
const NOW = new Date("2026-08-06T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { name: "A", email: "a@x.co", passwordHash: "x" } });
  userId = u.id;
});

async function draftUpdatedAt(when: Date) {
  const { id } = await saveDraft(userId, receiptDraftSchema.parse({}));
  await prisma.receiptDraft.update({ where: { id }, data: { updatedAt: when } });
  return id;
}

test("deletes drafts untouched for longer than the retention window", async () => {
  const stale = await draftUpdatedAt(daysAgo(DRAFT_RETENTION_DAYS + 1));
  const { deletedCount } = await purgeStaleDrafts(NOW);
  expect(deletedCount).toBe(1);
  expect(await prisma.receiptDraft.findUnique({ where: { id: stale } })).toBeNull();
});

test("spares a draft inside the window", async () => {
  const fresh = await draftUpdatedAt(daysAgo(DRAFT_RETENTION_DAYS - 1));
  const { deletedCount } = await purgeStaleDrafts(NOW);
  expect(deletedCount).toBe(0);
  expect(await prisma.receiptDraft.findUnique({ where: { id: fresh } })).not.toBeNull();
});

test("spares a draft sitting exactly on the cutoff (lt, not lte)", async () => {
  const atBoundary = await draftUpdatedAt(daysAgo(DRAFT_RETENTION_DAYS));
  const { deletedCount } = await purgeStaleDrafts(NOW);
  expect(deletedCount).toBe(0);
  expect(await prisma.receiptDraft.findUnique({ where: { id: atBoundary } })).not.toBeNull();
});

test("measures from updatedAt, so re-saving an old draft keeps it alive", async () => {
  const id = await draftUpdatedAt(daysAgo(DRAFT_RETENTION_DAYS + 5));
  await saveDraft(userId, receiptDraftSchema.parse({ receiver: { name: "touched" } }), id);
  const { deletedCount } = await purgeStaleDrafts(NOW);
  expect(deletedCount).toBe(0);
});
