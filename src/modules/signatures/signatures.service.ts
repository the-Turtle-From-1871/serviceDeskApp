import type { Signature } from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newSignatureSchema, type NewSignatureInput } from "./signatures.schema";
import { SignatureError } from "./signatures.errors";

// Every read/write is scoped by `userId` so one admin can never see, use, or
// delete another admin's signature. Callers (server actions) pass the id from
// the authenticated session — never from client input.

export function listSignatures(userId: string): Promise<{ id: string; name: string; image: string }[]> {
  return prisma.signature.findMany({
    where: { userId },
    select: { id: true, name: true, image: true },
    orderBy: { name: "asc" },
  });
}

// Names only (no image blob) for the account-page management list, which reveals
// each signature on demand rather than shipping every image to the client.
// Scoped by userId like every other read here.
export function listSignatureNames(userId: string): Promise<{ id: string; name: string }[]> {
  return prisma.signature.findMany({
    where: { userId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

export async function createSignature(userId: string, input: NewSignatureInput): Promise<Signature> {
  const data = newSignatureSchema.parse(input);
  try {
    return await prisma.signature.create({ data: { ...data, userId } });
  } catch (e) {
    // P2002 = unique violation on (userId, name): this admin already has a
    // signature under that technician's name.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new SignatureError("DUPLICATE_NAME");
    }
    throw e;
  }
}

export async function deleteSignature(id: string, userId: string): Promise<void> {
  // deleteMany (not delete) so the userId scope is part of the WHERE clause —
  // a mismatched owner deletes nothing rather than throwing a Prisma error.
  const { count } = await prisma.signature.deleteMany({ where: { id, userId } });
  if (count === 0) throw new SignatureError("NOT_FOUND");
}

/** The authoritative lookup used when signing: resolves a signature the acting
 *  admin actually owns. Returns null for someone else's id or a bogus one, so a
 *  client can neither forge a signer name nor inject an image. */
export function getOwnedSignature(id: string, userId: string): Promise<{ name: string; image: string } | null> {
  return prisma.signature.findFirst({
    where: { id, userId },
    select: { name: true, image: true },
  });
}
