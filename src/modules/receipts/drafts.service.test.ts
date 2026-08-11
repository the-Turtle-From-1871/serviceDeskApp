import { beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { saveDraft, listDrafts, getDraft, deleteDraft, MAX_DRAFTS_PER_USER } from "./drafts.service";
import { receiptDraftSchema } from "./drafts.schema";

let aliceId: string;
let bobId: string;

beforeEach(async () => {
  await resetDb();
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { name: "Alice", email: "alice@x.co", passwordHash: "x" } }),
    prisma.user.create({ data: { name: "Bob", email: "bob@x.co", passwordHash: "x" } }),
  ]);
  aliceId = a.id;
  bobId = b.id;
});

const payload = (over: Record<string, unknown> = {}) => receiptDraftSchema.parse(over);

test("saveDraft round-trips the payload unchanged", async () => {
  const p = payload({ itemIds: ["i1", "i2"], receiver: { name: "Doe, Jane", unit: "A Co" }, returnDays: "7" });
  const { id } = await saveDraft(aliceId, p);
  const got = await getDraft(id, aliceId);
  expect(got!.payload).toEqual(p);
});

test("saveDraft denormalises the recipient name and item count for the list", async () => {
  const { id } = await saveDraft(aliceId, payload({ itemIds: ["i1", "i2"], receiver: { name: "Doe, Jane" } }));
  const row = await prisma.receiptDraft.findUniqueOrThrow({ where: { id } });
  expect(row.recipientName).toBe("Doe, Jane");
  expect(row.itemCount).toBe(2);
});

test("saveDraft with a draftId UPDATES in place instead of creating a second row", async () => {
  const { id } = await saveDraft(aliceId, payload({ receiver: { name: "First" } }));
  const again = await saveDraft(aliceId, payload({ receiver: { name: "Second" } }), id);
  expect(again.id).toBe(id);
  expect(await prisma.receiptDraft.count({ where: { userId: aliceId } })).toBe(1);
  expect((await getDraft(id, aliceId))!.payload.receiver.name).toBe("Second");
});

test("saveDraft cannot overwrite another user's draft by passing its id", async () => {
  const { id } = await saveDraft(aliceId, payload({ receiver: { name: "Alice's" } }));
  await saveDraft(bobId, payload({ receiver: { name: "Bob's" } }), id);
  // Alice's row is untouched...
  expect((await getDraft(id, aliceId))!.payload.receiver.name).toBe("Alice's");
  // ...and Bob got his own new row rather than silently editing hers.
  const bobs = await listDrafts(bobId);
  expect(bobs).toHaveLength(1);
  expect(bobs[0].id).not.toBe(id);
});

test("getDraft returns null for another user's draft", async () => {
  const { id } = await saveDraft(aliceId, payload());
  expect(await getDraft(id, bobId)).toBeNull();
});

test("deleteDraft does not delete another user's draft", async () => {
  const { id } = await saveDraft(aliceId, payload());
  await deleteDraft(id, bobId);
  expect(await getDraft(id, aliceId)).not.toBeNull();
});

test("listDrafts returns only my drafts, newest first, with a derived label", async () => {
  await saveDraft(bobId, payload({ receiver: { name: "Bob's" } }));
  const older = await saveDraft(aliceId, payload({ receiver: { name: "Older" }, itemIds: ["i1"] }));
  await prisma.receiptDraft.update({ where: { id: older.id }, data: { updatedAt: new Date("2020-01-01") } });
  await saveDraft(aliceId, payload({ receiver: { name: "Newer" }, itemIds: ["i1", "i2"] }));

  const list = await listDrafts(aliceId);
  expect(list).toHaveLength(2);
  expect(list[0].label).toBe("Newer · 2 items");
  expect(list[1].label).toBe("Older · 1 item");
});

test("saveDraft refuses past the per-user cap rather than pruning the oldest", async () => {
  for (let i = 0; i < MAX_DRAFTS_PER_USER; i++) await saveDraft(aliceId, payload({ itemIds: [`i${i}`] }));
  await expect(saveDraft(aliceId, payload())).rejects.toMatchObject({ code: "TOO_MANY" });
  // The cap does not block UPDATING an existing draft.
  const mine = await listDrafts(aliceId);
  await expect(saveDraft(aliceId, payload({ receiver: { name: "edited" } }), mine[0].id)).resolves.toBeTruthy();
});

test("saveDraft serializes concurrent creates at the cap so exactly one wins", async () => {
  // Fill to cap - 1, then fire two concurrent creates. Both observe the same
  // pre-write count if the cap check is check-then-act; a correct
  // implementation serializes them so exactly one succeeds and the user ends
  // at the cap, never cap + 1.
  for (let i = 0; i < MAX_DRAFTS_PER_USER - 1; i++) await saveDraft(aliceId, payload({ itemIds: [`i${i}`] }));
  expect(await prisma.receiptDraft.count({ where: { userId: aliceId } })).toBe(MAX_DRAFTS_PER_USER - 1);

  const results = await Promise.allSettled([
    saveDraft(aliceId, payload({ itemIds: ["race-a"] })),
    saveDraft(aliceId, payload({ itemIds: ["race-b"] })),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "TOO_MANY" });
  expect(await prisma.receiptDraft.count({ where: { userId: aliceId } })).toBe(MAX_DRAFTS_PER_USER);
});

test("getDraft reports a corrupt payload instead of throwing", async () => {
  const { id } = await saveDraft(aliceId, payload());
  await prisma.receiptDraft.update({ where: { id }, data: { payload: { itemIds: "not-an-array" } } });
  await expect(getDraft(id, aliceId)).rejects.toMatchObject({ code: "CORRUPT" });
});

test("deleting the user cascades their drafts away", async () => {
  await saveDraft(aliceId, payload());
  await prisma.user.delete({ where: { id: aliceId } });
  expect(await prisma.receiptDraft.count()).toBe(0);
});
