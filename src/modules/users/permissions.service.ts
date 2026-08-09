import type { Capability } from "@prisma/client";
import prisma from "@/lib/prisma";
import { effectiveCapabilities } from "./capabilities";
import { PermissionRequestError } from "./permissions.errors";
import type { PermissionRequestInput } from "./permissions.schema";

/**
 * Files a request. Refuses capabilities the user already holds or already has
 * pending, so the admin queue never carries a line that cannot change anything.
 *
 * A DENIED capability may be requested again — denial is a decision about one
 * ask, not a permanent bar, and the admin queue is the throttle on repetition.
 */
export async function createPermissionRequest(userId: string, input: PermissionRequestInput) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, capabilities: { select: { capability: true } } },
  });
  if (!user) throw new PermissionRequestError("NOT_FOUND");

  // Resolved through the SAME pure function requireCapability uses, so "already
  // held" cannot drift from what the app actually admits.
  const held = new Set(
    effectiveCapabilities(user.role, user.capabilities.map((c) => c.capability)),
  );
  if (input.capabilities.some((c) => held.has(c))) {
    throw new PermissionRequestError("ALREADY_HELD");
  }

  const pending = await prisma.permissionRequestItem.findFirst({
    where: {
      capability: { in: input.capabilities },
      decision: "PENDING",
      request: { userId, status: "OPEN" },
    },
    select: { id: true },
  });
  if (pending) throw new PermissionRequestError("ALREADY_PENDING");

  return prisma.permissionRequest.create({
    data: {
      userId,
      justification: input.justification,
      items: { create: input.capabilities.map((capability) => ({ capability })) },
    },
    include: { items: true },
  });
}

const REQUEST_INCLUDE = {
  items: true,
  user: { select: { id: true, name: true, rank: true, email: true, role: true } },
  decidedBy: { select: { name: true, rank: true } },
} as const;

/** Open requests, oldest first — a queue is worked front to back. */
export function listOpenRequests() {
  return prisma.permissionRequest.findMany({
    where: { status: "OPEN" },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: "asc" },
    take: 100,
  });
}

/** Recently decided, newest first, for the "Recently decided" list. */
export function listRecentlyDecided(take = 20) {
  return prisma.permissionRequest.findMany({
    where: { status: "CLOSED" },
    include: REQUEST_INCLUDE,
    orderBy: { decidedAt: "desc" },
    take,
  });
}

/** One user's own requests, newest first — pending and decided together. */
export function listRequestsForUser(userId: string, take = 20) {
  return prisma.permissionRequest.findMany({
    where: { userId },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: "desc" },
    take,
  });
}

export function countOpenRequests(): Promise<number> {
  return prisma.permissionRequest.count({ where: { status: "OPEN" } });
}

/**
 * Decides a request. `approve` is the CHECKED set; every other line on the
 * request is denied, because the admin decides by unchecking.
 *
 * Everything commits in ONE transaction: a partial apply would leave grants
 * without decisions (or the reverse), and the audit trail is the whole point of
 * recording a justification in the first place.
 */
export async function decidePermissionRequest({
  requestId,
  deciderId,
  approve,
  denialReason,
}: {
  requestId: string;
  deciderId: string;
  approve: Capability[];
  denialReason?: string;
}) {
  const request = await prisma.permissionRequest.findUnique({
    where: { id: requestId },
    include: { items: true },
  });
  if (!request) throw new PermissionRequestError("NOT_FOUND");
  if (request.status === "CLOSED") throw new PermissionRequestError("ALREADY_DECIDED");

  // THE privilege guard. An admin approving their own ADMINISTER request is a
  // self-grant with an audit trail that reads as legitimate — the one failure
  // here that is a security bug rather than a usability wart. Do not relax it
  // to "unless they are already an admin": the point is that the record shows
  // two people.
  if (request.userId === deciderId) throw new PermissionRequestError("SELF_DECISION");

  const approved = request.items.filter((i) => approve.includes(i.capability));
  const denied = request.items.filter((i) => !approve.includes(i.capability));

  // A denial the requester cannot act on is a dead end, so the reason is
  // required whenever anything is withheld — and only then.
  const reason = denialReason?.trim() ?? "";
  if (denied.length > 0 && reason.length === 0) {
    throw new PermissionRequestError("REASON_REQUIRED");
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    if (approved.length > 0) {
      // skipDuplicates rather than a read-then-write: two admins deciding
      // overlapping requests at the same moment would otherwise race, and the
      // unique constraint on (userId, capability) is the real arbiter anyway.
      // This is what makes approval idempotent.
      await tx.userCapability.createMany({
        data: approved.map((i) => ({
          userId: request.userId,
          capability: i.capability,
          grantedById: deciderId,
        })),
        skipDuplicates: true,
      });
      await tx.permissionRequestItem.updateMany({
        where: { id: { in: approved.map((i) => i.id) } },
        data: { decision: "APPROVED" },
      });
    }

    if (denied.length > 0) {
      await tx.permissionRequestItem.updateMany({
        where: { id: { in: denied.map((i) => i.id) } },
        data: { decision: "DENIED" },
      });
    }

    return tx.permissionRequest.update({
      where: { id: requestId },
      data: {
        status: "CLOSED",
        decidedAt: now,
        decidedById: deciderId,
        denialReason: denied.length > 0 ? reason : null,
      },
      include: REQUEST_INCLUDE,
    });
  });
}
