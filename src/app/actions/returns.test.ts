import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const getOwnedSignature = vi.fn();
const processReturn = vi.fn();
const sendReturnEmail = vi.fn();
const renderReceiptPdf = vi.fn();
const getTransferByReceiptNumber = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireAdmin: () => requireAdmin(),
  AuthError: class AuthError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock("@/modules/signatures/signatures.service", () => ({
  getOwnedSignature: (id: string, userId: string) => getOwnedSignature(id, userId),
}));
vi.mock("@/modules/returns/returns.service", () => ({
  processReturn: (input: unknown) => processReturn(input),
}));
vi.mock("@/modules/returns/send-return-email", () => ({
  sendReturnEmail: (args: unknown) => sendReturnEmail(args),
}));
vi.mock("@/modules/receipts/render", () => ({
  renderReceiptPdf: (receiptNumber: string) => renderReceiptPdf(receiptNumber),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getTransferByReceiptNumber: (receiptNumber: string) => getTransferByReceiptNumber(receiptNumber),
}));
vi.mock("@/modules/items/qr", () => ({
  receiptUrl: (receiptNumber: string) => `https://example.test/receipts/${receiptNumber}`,
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

import { processReturnAction } from "./returns";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin Actor", email: "admin@x.mil" };
const SIG = "data:image/png;base64,AAA";

function makeFormData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const basePlan = {
  kind: "PARTIAL" as const,
  returned: [{ transferItemId: "ti-1", serialNumber: "SN1", make: "Dell", model: "L", lineNo: 1 }],
  remaining: [{ transferItemId: "ti-2", serialNumber: "SN2", make: "Dell", model: "L", lineNo: 1 }],
  byLine: [{ lineNo: 1, make: "Dell", model: "L", heldBefore: 2, returnedNow: 1, heldAfter: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  processReturn.mockResolvedValue({
    plan: basePlan,
    receiptNumber: "HR-000001",
    receiver: { isDcsim: false, name: "Jane", email: "jane@u.mil" },
  });
  sendReturnEmail.mockResolvedValue(undefined);
});

describe("processReturnAction", () => {
  it("resolves a saved pick's name and image from the DB; processedBy.id stays the acting admin", async () => {
    getOwnedSignature.mockResolvedValue({ name: "SGT Smith", image: SIG });
    const fd = makeFormData({
      receiptNumber: "HR-000001",
      verified: "on",
      itemId: "ti-1",
      signatureId: "sig-1",
    });

    const res = await processReturnAction(undefined, fd);

    expect("ok" in res).toBe(true);
    expect(getOwnedSignature).toHaveBeenCalledWith("sig-1", ADMIN.id);
    expect(processReturn).toHaveBeenCalledWith(expect.objectContaining({
      signature: SIG,
      processedBy: { id: ADMIN.id, name: "SGT Smith", email: ADMIN.email },
    }));
  });

  it("forgery attempt: a forged signature posted alongside a valid signatureId is ignored", async () => {
    getOwnedSignature.mockResolvedValue({ name: "SGT Smith", image: SIG });
    const fd = makeFormData({
      receiptNumber: "HR-000001",
      verified: "on",
      itemId: "ti-1",
      signatureId: "sig-1",
      signature: "data:image/png;base64,FORGED",
    });

    const res = await processReturnAction(undefined, fd);

    expect("ok" in res).toBe(true);
    expect(processReturn).toHaveBeenCalledWith(expect.objectContaining({
      signature: SIG,
      processedBy: { id: ADMIN.id, name: "SGT Smith", email: ADMIN.email },
    }));
  });

  it("ad-hoc draw (no signatureId): processedBy.name falls back to the admin's own name", async () => {
    const fd = makeFormData({
      receiptNumber: "HR-000001",
      verified: "on",
      itemId: "ti-1",
      signature: SIG,
    });

    const res = await processReturnAction(undefined, fd);

    expect("ok" in res).toBe(true);
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(processReturn).toHaveBeenCalledWith(expect.objectContaining({
      signature: SIG,
      processedBy: { id: ADMIN.id, name: ADMIN.name, email: ADMIN.email },
    }));
  });

  it("bogus/foreign signatureId: getOwnedSignature returns null -> errors and never calls processReturn", async () => {
    getOwnedSignature.mockResolvedValue(null);
    const fd = makeFormData({
      receiptNumber: "HR-000001",
      verified: "on",
      itemId: "ti-1",
      signatureId: "not-mine",
    });

    const res = await processReturnAction(undefined, fd);

    expect(res).toEqual({ error: "That signature is no longer available. Pick another or draw one." });
    expect(processReturn).not.toHaveBeenCalled();
  });
});
