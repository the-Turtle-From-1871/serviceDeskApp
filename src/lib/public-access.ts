import "server-only"; // bcrypt + Prisma must never reach the client/edge bundle
import prisma from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";

// Single-row config: one shared org PIN. Pinned id keeps it to one row.
const SINGLETON_ID = "singleton";

export async function getPinHash(): Promise<string | null> {
  const row = await prisma.publicAccessSetting.findUnique({
    where: { id: SINGLETON_ID },
    select: { pinHash: true },
  });
  return row?.pinHash ?? null;
}

export async function verifyPin(pin: string): Promise<boolean> {
  const hash = await getPinHash();
  if (!hash) return false; // no PIN configured -> nothing verifies
  return verifyPassword(pin, hash);
}

export async function setPin(pin: string, userId: string): Promise<void> {
  const pinHash = await hashPassword(pin);
  await prisma.publicAccessSetting.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, pinHash, updatedById: userId },
    update: { pinHash, updatedById: userId },
  });
}

export async function getPinMeta(): Promise<{ updatedAt: Date; updatedByName: string | null } | null> {
  const row = await prisma.publicAccessSetting.findUnique({
    where: { id: SINGLETON_ID },
    select: { updatedAt: true, updatedBy: { select: { name: true } } },
  });
  if (!row) return null;
  return { updatedAt: row.updatedAt, updatedByName: row.updatedBy?.name ?? null };
}
