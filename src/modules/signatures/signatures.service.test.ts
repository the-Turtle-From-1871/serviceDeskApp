import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { listSignatures, listSignatureNames, createSignature, deleteSignature, getOwnedSignature } from "./signatures.service";
import { SignatureError } from "./signatures.errors";

const PNG = "data:image/png;base64,AAAA";
let adminId: string;
let otherId: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const a = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  const b = await prisma.user.create({ data: { name: "Other", email: "b@x.co", passwordHash: "x", role: "ADMIN" } });
  adminId = a.id;
  otherId = b.id;
});

test("createSignature stores a named signature for the owner", async () => {
  const sig = await createSignature(adminId, { name: "SGT Smith", image: PNG });
  expect(sig.userId).toBe(adminId);
  expect(sig.name).toBe("SGT Smith");
  expect(sig.image).toBe(PNG);
});

test("createSignature rejects a duplicate name for the same admin", async () => {
  await createSignature(adminId, { name: "SGT Smith", image: PNG });
  await expect(createSignature(adminId, { name: "SGT Smith", image: PNG }))
    .rejects.toMatchObject({ code: "DUPLICATE_NAME" });
});

test("the same name is allowed for a different admin", async () => {
  await createSignature(adminId, { name: "SGT Smith", image: PNG });
  const sig = await createSignature(otherId, { name: "SGT Smith", image: PNG });
  expect(sig.userId).toBe(otherId);
});

test("listSignatures returns only the owner's, ordered by name", async () => {
  await createSignature(adminId, { name: "SSG Zulu", image: PNG });
  await createSignature(adminId, { name: "PFC Alpha", image: PNG });
  await createSignature(otherId, { name: "CPL Other", image: PNG });
  const list = await listSignatures(adminId);
  expect(list.map((s) => s.name)).toEqual(["PFC Alpha", "SSG Zulu"]);
});

test("listSignatureNames returns id+name only (no image blob), owner-scoped and ordered", async () => {
  await createSignature(adminId, { name: "SSG Zulu", image: PNG });
  await createSignature(adminId, { name: "PFC Alpha", image: PNG });
  await createSignature(otherId, { name: "CPL Other", image: PNG });
  const list = await listSignatureNames(adminId);
  expect(list.map((s) => s.name)).toEqual(["PFC Alpha", "SSG Zulu"]);
  expect(list[0]).not.toHaveProperty("image");
});

test("deleteSignature removes the owner's signature", async () => {
  const sig = await createSignature(adminId, { name: "SGT Smith", image: PNG });
  await deleteSignature(sig.id, adminId);
  expect(await listSignatures(adminId)).toEqual([]);
});

test("deleteSignature refuses another admin's signature", async () => {
  const sig = await createSignature(otherId, { name: "CPL Other", image: PNG });
  await expect(deleteSignature(sig.id, adminId)).rejects.toBeInstanceOf(SignatureError);
  // still there — the other admin's row was untouched
  expect(await listSignatures(otherId)).toHaveLength(1);
});

test("getOwnedSignature returns name + image for the owner", async () => {
  const sig = await createSignature(adminId, { name: "SGT Smith", image: PNG });
  expect(await getOwnedSignature(sig.id, adminId)).toEqual({ name: "SGT Smith", image: PNG });
});

test("getOwnedSignature returns null for another admin's signature", async () => {
  const sig = await createSignature(otherId, { name: "CPL Other", image: PNG });
  expect(await getOwnedSignature(sig.id, adminId)).toBeNull();
});
