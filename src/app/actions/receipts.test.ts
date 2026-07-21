import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const getOwnedSignature = vi.fn();
const createTransfer = vi.fn();
const getTransferByReceiptNumber = vi.fn();
const sendReceiptEmails = vi.fn();
const renderReceiptPdf = vi.fn();
const upsertServiceRequest = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/signatures/signatures.service", () => ({
  getOwnedSignature: (id: string, userId: string) => getOwnedSignature(id, userId),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  createTransfer: (input: unknown) => createTransfer(input),
  getTransferByReceiptNumber: (n: string) => getTransferByReceiptNumber(n),
}));
vi.mock("@/modules/receipts/send-receipt-email", () => ({
  sendReceiptEmails: (args: unknown) => sendReceiptEmails(args),
}));
vi.mock("@/modules/receipts/render", () => ({
  renderReceiptPdf: (n: string) => renderReceiptPdf(n),
}));
vi.mock("@/modules/service-queue/service-queue.service", () => ({
  upsertServiceRequest: (input: unknown) => upsertServiceRequest(input),
}));
vi.mock("@/modules/items/qr", () => ({
  receiptUrl: (n: string) => `https://example.test/receipts/${n}`,
}));

import { createReceiptAction } from "./receipts";

const USER = { id: "user-1", role: "ADMIN" as const, name: "Admin Actor", email: "admin@x.mil" };
const SAVED_SIG = "data:image/png;base64,SAVED";
const DRAWN_SIG = "data:image/png;base64,DRAWN";

/** A minimal valid receipt form. `receiver.*` is overridden per test. */
function makeFormData(extra: Record<string, string>) {
  const fd = new FormData();
  fd.set("itemId", "item-1");
  fd.set("line[0][make]", "Dell");
  fd.set("line[0][model]", "5540");
  fd.set("line[0][qtyAuth]", "1");
  fd.set("line[0][qtyIssued]", "1");
  fd.set("senderName", "Jane");
  fd.set("senderRank", "SGT");
  fd.set("senderUnit", "A Co");
  fd.set("senderContact", "808");
  fd.set("senderEmail", "jane@u.mil");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue(USER);
  createTransfer.mockResolvedValue({ id: "t-1", receiptNumber: "HR-000001" });
  getTransferByReceiptNumber.mockResolvedValue({ receiptNumber: "HR-000001", lines: [] });
  renderReceiptPdf.mockResolvedValue(undefined);
  sendReceiptEmails.mockResolvedValue(undefined);
});

describe("createReceiptAction — DCSIM recipient signature", () => {
  it("resolves a picked signature's name and image from the DB, scoped to the acting user", async () => {
    getOwnedSignature.mockResolvedValue({ name: "SGT Alvarez", image: SAVED_SIG });
    const fd = makeFormData({ receiverIsDcsim: "on", signatureId: "sig-1" });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(getOwnedSignature).toHaveBeenCalledWith("sig-1", USER.id);
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverSignature: SAVED_SIG,
      receiver: expect.objectContaining({ isDcsim: true, name: "SGT Alvarez" }),
    }));
  });

  it("forgery attempt: a forged receiverName and receiverSignature posted alongside a valid signatureId are both ignored", async () => {
    getOwnedSignature.mockResolvedValue({ name: "SGT Alvarez", image: SAVED_SIG });
    const fd = makeFormData({
      receiverIsDcsim: "on",
      signatureId: "sig-1",
      receiverName: "Somebody Else",
      receiverSignature: "data:image/png;base64,FORGED",
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    const arg = createTransfer.mock.calls[0][0] as { receiverSignature: string; receiver: { name: string } };
    expect(arg.receiverSignature).toBe(SAVED_SIG);
    expect(arg.receiver.name).toBe("SGT Alvarez");
  });

  it("rejects a signatureId when the recipient is NOT DCSIM, and creates nothing", async () => {
    const fd = makeFormData({
      signatureId: "sig-1",
      receiverName: "Jane Doe",
      receiverRank: "SGT",
      receiverUnit: "B Co",
      receiverContact: "808",
      receiverEmail: "jd@u.mil",
      receiverSignature: DRAWN_SIG,
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ error: "A saved signature can only be used when the recipient is DCSIM." });
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
  });

  // A demoted admin keeps their Signature rows, so getOwnedSignature would still
  // find one. The role check is what actually revokes the capability.
  it("rejects a signatureId from a non-admin (e.g. a demoted admin who still owns signatures)", async () => {
    requireUser.mockResolvedValue({ ...USER, role: "USER" });
    getOwnedSignature.mockResolvedValue({ name: "SGT Alvarez", image: SAVED_SIG });
    const fd = makeFormData({ receiverIsDcsim: "on", signatureId: "sig-1" });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ error: "A saved signature can only be used when the recipient is DCSIM." });
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("rejects a bogus or another user's signatureId, and creates nothing", async () => {
    getOwnedSignature.mockResolvedValue(null);
    const fd = makeFormData({ receiverIsDcsim: "on", signatureId: "not-mine" });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ error: "That signature is no longer available. Pick another or draw one." });
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("without a signatureId, a drawn signature and typed DCSIM name still work", async () => {
    const fd = makeFormData({
      receiverIsDcsim: "on",
      receiverName: "DCSIM Tech",
      receiverSignature: DRAWN_SIG,
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverSignature: DRAWN_SIG,
      receiver: expect.objectContaining({ isDcsim: true, name: "DCSIM Tech" }),
    }));
  });

  it("without a signatureId, an ordinary non-DCSIM recipient is unaffected", async () => {
    const fd = makeFormData({
      receiverName: "Jane Doe",
      receiverRank: "SGT",
      receiverUnit: "B Co",
      receiverContact: "808",
      receiverEmail: "jd@u.mil",
      receiverSignature: DRAWN_SIG,
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverSignature: DRAWN_SIG,
      receiver: expect.objectContaining({ isDcsim: false, name: "Jane Doe" }),
    }));
  });
});

describe("createReceiptAction — 'Needs service?' is DCSIM-recipient only", () => {
  it("enqueues a per-item service request when the recipient is DCSIM", async () => {
    const fd = makeFormData({
      receiverIsDcsim: "on",
      receiverName: "DCSIM Tech",
      receiverSignature: DRAWN_SIG,
      "service[item-1][needs]": "on",
      "service[item-1][type]": "REIMAGE",
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(upsertServiceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-1", serviceType: "REIMAGE" }),
    );
  });

  it("drops service selections when the recipient is NOT DCSIM, still creating the receipt", async () => {
    // Simulates a crafted POST: service[...] fields present on a non-DCSIM
    // receipt (the builder never renders them). The receipt is still created,
    // but nothing is enqueued.
    const fd = makeFormData({
      receiverName: "Jane Doe",
      receiverRank: "SGT",
      receiverUnit: "B Co",
      receiverContact: "808",
      receiverEmail: "jd@u.mil",
      receiverSignature: DRAWN_SIG,
      "service[item-1][needs]": "on",
      "service[item-1][type]": "REIMAGE",
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(upsertServiceRequest).not.toHaveBeenCalled();
  });
});
