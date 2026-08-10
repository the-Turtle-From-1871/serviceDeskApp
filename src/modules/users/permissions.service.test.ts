import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, prismaMock } = vi.hoisted(() => {
  const db = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    permissionRequest: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    permissionRequestItem: { findFirst: vi.fn(), updateMany: vi.fn() },
    userCapability: { createMany: vi.fn() },
  };
  const prismaMock = {
    ...db,
    // The callback form: hand the same mock back as `tx` so the test can assert
    // that every write happened inside it.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, prismaMock };
});
vi.mock("@/lib/prisma", () => ({ default: prismaMock, prisma: prismaMock }));

import { createPermissionRequest, decidePermissionRequest } from "./permissions.service";
import { PermissionRequestError } from "./permissions.errors";

const JUSTIFICATION = "I have taken over returns processing for the shop this quarter.";

const requestRow = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  userId: "u1",
  status: "OPEN",
  items: [
    { id: "i1", capability: "MANAGE_QUEUE", decision: "PENDING" },
    { id: "i2", capability: "PROCESS_RETURNS", decision: "PENDING" },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue({ role: "VIEWER", capabilities: [] });
  db.permissionRequestItem.findFirst.mockResolvedValue(null);
  db.permissionRequest.create.mockResolvedValue({ id: "r1", items: [] });
  db.permissionRequest.findUnique.mockResolvedValue(requestRow());
  db.permissionRequest.update.mockResolvedValue({ id: "r1" });
  db.permissionRequestItem.updateMany.mockResolvedValue({ count: 1 });
  db.userCapability.createMany.mockResolvedValue({ count: 1 });
  db.user.update.mockResolvedValue({ id: "u1", role: "ADMIN" });
});

const adminRequestRow = (over: Record<string, unknown> = {}) =>
  requestRow({ items: [{ id: "i1", capability: "ADMINISTER", decision: "PENDING" }], ...over });

describe("createPermissionRequest", () => {
  it("files a request with one line per capability", async () => {
    await createPermissionRequest("u1", {
      justification: JUSTIFICATION,
      capabilities: ["MANAGE_QUEUE", "PROCESS_RETURNS"],
    });
    const data = db.permissionRequest.create.mock.calls[0][0].data;
    expect(data.userId).toBe("u1");
    expect(data.items.create).toEqual([
      { capability: "MANAGE_QUEUE" },
      { capability: "PROCESS_RETURNS" },
    ]);
  });

  it("refuses a capability the user already holds via their ROLE baseline", async () => {
    db.user.findUnique.mockResolvedValue({ role: "USER", capabilities: [] });
    await expect(
      createPermissionRequest("u1", { justification: JUSTIFICATION, capabilities: ["CREATE_RECEIPTS"] }),
    ).rejects.toMatchObject({ code: "ALREADY_HELD" });
  });

  it("refuses a capability the user already holds via a GRANT", async () => {
    db.user.findUnique.mockResolvedValue({
      role: "VIEWER",
      capabilities: [{ capability: "MANAGE_QUEUE" }],
    });
    await expect(
      createPermissionRequest("u1", { justification: JUSTIFICATION, capabilities: ["MANAGE_QUEUE"] }),
    ).rejects.toMatchObject({ code: "ALREADY_HELD" });
  });

  it("refuses a capability already pending for that user", async () => {
    db.permissionRequestItem.findFirst.mockResolvedValue({ id: "i9" });
    await expect(
      createPermissionRequest("u1", { justification: JUSTIFICATION, capabilities: ["MANAGE_QUEUE"] }),
    ).rejects.toMatchObject({ code: "ALREADY_PENDING" });
  });

  // Denial decides one ask, it is not a permanent bar.
  it("allows re-requesting after a denial", async () => {
    db.permissionRequestItem.findFirst.mockResolvedValue(null); // only PENDING blocks
    await expect(
      createPermissionRequest("u1", { justification: JUSTIFICATION, capabilities: ["MANAGE_QUEUE"] }),
    ).resolves.toBeTruthy();
  });

  it("only considers PENDING lines on OPEN requests when blocking", async () => {
    await createPermissionRequest("u1", { justification: JUSTIFICATION, capabilities: ["MANAGE_QUEUE"] });
    const where = db.permissionRequestItem.findFirst.mock.calls[0][0].where;
    expect(where.decision).toBe("PENDING");
    expect(where.request).toEqual({ userId: "u1", status: "OPEN" });
  });
});

describe("decidePermissionRequest", () => {
  // THE privilege guard: a self-grant with an audit trail that reads as
  // legitimate. This test must not be weakened.
  it("refuses a decision by the requester themselves", async () => {
    await expect(
      decidePermissionRequest({ requestId: "r1", deciderId: "u1", approve: ["MANAGE_QUEUE"] }),
    ).rejects.toMatchObject({ code: "SELF_DECISION" });
    expect(db.userCapability.createMany).not.toHaveBeenCalled();
  });

  it("checks the self-decision guard even when approving nothing", async () => {
    await expect(
      decidePermissionRequest({ requestId: "r1", deciderId: "u1", approve: [], denialReason: "no" }),
    ).rejects.toMatchObject({ code: "SELF_DECISION" });
  });

  it("grants ONLY the checked lines and denies the rest", async () => {
    await decidePermissionRequest({
      requestId: "r1",
      deciderId: "admin1",
      approve: ["MANAGE_QUEUE"],
      denialReason: "Returns stay with the senior technicians.",
    });
    const granted = db.userCapability.createMany.mock.calls[0][0].data;
    expect(granted).toEqual([
      { userId: "u1", capability: "MANAGE_QUEUE", grantedById: "admin1" },
    ]);
    const decisions = db.permissionRequestItem.updateMany.mock.calls.map((c) => c[0].data.decision);
    expect(decisions).toContain("APPROVED");
    expect(decisions).toContain("DENIED");
  });

  it("requires a reason when anything is withheld", async () => {
    await expect(
      decidePermissionRequest({ requestId: "r1", deciderId: "admin1", approve: ["MANAGE_QUEUE"] }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect(db.userCapability.createMany).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only reason as no reason", async () => {
    await expect(
      decidePermissionRequest({
        requestId: "r1", deciderId: "admin1", approve: ["MANAGE_QUEUE"], denialReason: "   ",
      }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("needs no reason when everything is approved", async () => {
    await expect(
      decidePermissionRequest({
        requestId: "r1", deciderId: "admin1", approve: ["MANAGE_QUEUE", "PROCESS_RETURNS"],
      }),
    ).resolves.toBeTruthy();
    expect(db.permissionRequest.update.mock.calls[0][0].data.denialReason).toBeNull();
  });

  it("denies everything when nothing is checked", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: [], denialReason: "Not this quarter.",
    });
    expect(db.userCapability.createMany).not.toHaveBeenCalled();
    expect(db.permissionRequest.update.mock.calls[0][0].data.denialReason).toBe("Not this quarter.");
  });

  // Two admins deciding overlapping requests must not collide on the unique
  // constraint — the grant write is idempotent by construction.
  it("writes grants with skipDuplicates so a repeat grant cannot throw", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["MANAGE_QUEUE", "PROCESS_RETURNS"],
    });
    expect(db.userCapability.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it("closes the request and records who decided it", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["MANAGE_QUEUE", "PROCESS_RETURNS"],
    });
    const data = db.permissionRequest.update.mock.calls[0][0].data;
    expect(data.status).toBe("CLOSED");
    expect(data.decidedById).toBe("admin1");
    expect(data.decidedAt).toBeInstanceOf(Date);
  });

  it("refuses to decide an already-closed request", async () => {
    db.permissionRequest.findUnique.mockResolvedValue(requestRow({ status: "CLOSED" }));
    await expect(
      decidePermissionRequest({ requestId: "r1", deciderId: "admin1", approve: [] }),
    ).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });

  it("refuses an unknown request", async () => {
    db.permissionRequest.findUnique.mockResolvedValue(null);
    await expect(
      decidePermissionRequest({ requestId: "nope", deciderId: "admin1", approve: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // Grants without decisions (or the reverse) would corrupt the audit trail the
  // whole feature exists to produce.
  it("commits grants and decisions in ONE transaction", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["MANAGE_QUEUE", "PROCESS_RETURNS"],
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("throws PermissionRequestError, not a bare Error", async () => {
    await expect(
      decidePermissionRequest({ requestId: "r1", deciderId: "u1", approve: [] }),
    ).rejects.toBeInstanceOf(PermissionRequestError);
  });
});

// Approving ADMINISTER means "make this person an administrator", so it moves
// the ROLE. A grant row would have left a VIEWER holding ADMINISTER and nothing
// else — able to manage users but not to file a receipt, and still displayed as
// a plain user on /admin/users.
describe("decidePermissionRequest — approving ADMINISTER promotes the role", () => {
  beforeEach(() => {
    db.permissionRequest.findUnique.mockResolvedValue(adminRequestRow());
  });

  it("sets the requester's role to ADMIN", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["ADMINISTER"],
    });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { role: "ADMIN" },
    });
  });

  // A UserCapability row outlives the role, so demoting the account later would
  // silently leave it holding full admin — defeating the one documented way to
  // reduce an account below its baseline.
  it("writes NO capability grant rows when promoting", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["ADMINISTER"],
    });
    expect(db.userCapability.createMany).not.toHaveBeenCalled();
  });

  it("writes no grant rows for the OTHER approved lines either", async () => {
    db.permissionRequest.findUnique.mockResolvedValue(
      requestRow({
        items: [
          { id: "i1", capability: "ADMINISTER", decision: "PENDING" },
          { id: "i2", capability: "MANAGE_QUEUE", decision: "PENDING" },
        ],
      }),
    );
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["ADMINISTER", "MANAGE_QUEUE"],
    });
    expect(db.userCapability.createMany).not.toHaveBeenCalled();
    expect(db.user.update).toHaveBeenCalledTimes(1);
  });

  it("still records the line as APPROVED and closes the request", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["ADMINISTER"],
    });
    const decisions = db.permissionRequestItem.updateMany.mock.calls.map((c) => c[0].data.decision);
    expect(decisions).toContain("APPROVED");
    expect(db.permissionRequest.update.mock.calls[0][0].data.decidedById).toBe("admin1");
  });

  it("promotes inside the SAME transaction as the decisions", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["ADMINISTER"],
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  // Denying it must not touch the role — this is the whole point of the
  // elevated line starting unchecked in the approval UI.
  it("does NOT promote when ADMINISTER is denied", async () => {
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: [], denialReason: "Not yet.",
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("grants normally, without promoting, when ADMINISTER is not on the request", async () => {
    db.permissionRequest.findUnique.mockResolvedValue(requestRow());
    await decidePermissionRequest({
      requestId: "r1", deciderId: "admin1", approve: ["MANAGE_QUEUE", "PROCESS_RETURNS"],
    });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.userCapability.createMany).toHaveBeenCalledTimes(1);
  });

  // THE privilege guard still comes first: promotion is a bigger act than a
  // grant, so self-decision must remain impossible.
  it("refuses to promote on a self-decision", async () => {
    await expect(
      decidePermissionRequest({ requestId: "r1", deciderId: "u1", approve: ["ADMINISTER"] }),
    ).rejects.toMatchObject({ code: "SELF_DECISION" });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
