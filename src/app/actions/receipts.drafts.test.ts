import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const createTransfer = vi.fn();
const deleteDraft = vi.fn();

vi.mock("@/lib/authz", () => ({ requireUser: () => requireUser(), AuthError: class extends Error {} }));
vi.mock("@/modules/transfers/transfers.service", () => ({
  createTransfer: (...a: unknown[]) => createTransfer(...a),
  getTransferByReceiptNumber: vi.fn().mockResolvedValue({ lines: [] }),
}));
vi.mock("@/modules/receipts/drafts.service", () => ({ deleteDraft: (...a: unknown[]) => deleteDraft(...a) }));
vi.mock("@/modules/receipts/send-receipt-email", () => ({ sendReceiptEmails: vi.fn() }));
vi.mock("@/modules/receipts/render", () => ({ renderReceiptPdf: vi.fn() }));
vi.mock("@/modules/items/qr", () => ({ receiptLinkUrl: vi.fn().mockResolvedValue("http://x") }));
vi.mock("@/modules/service-queue/service-queue.service", () => ({ upsertServiceRequest: vi.fn() }));

import { createReceiptAction } from "./receipts";

function validForm(extra: [string, string][] = []): FormData {
  const fd = new FormData();
  fd.append("itemId", "i1");
  fd.append("line[0][make]", "Dell");
  fd.append("line[0][model]", "5420");
  fd.append("line[0][qtyAuth]", "1");
  fd.append("line[0][qtyIssued]", "1");
  fd.append("senderIsDcsim", "on");
  fd.append("senderName", "SGT Smith");
  fd.append("receiverName", "Doe, Jane");
  fd.append("receiverUnit", "A Co");
  fd.append("receiverContact", "8085551234");
  fd.append("receiverEmail", "jane@unit.mil");
  fd.append("receiverSignature", "data:image/png;base64,AAAA");
  for (const [k, v] of extra) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "USER" });
  createTransfer.mockResolvedValue({ id: "t1", receiptNumber: "HR-000001" });
});

describe("createReceiptAction draft cleanup", () => {
  it("deletes the draft it was filed from, scoped to the acting user", async () => {
    const r = await createReceiptAction(undefined, validForm([["draftId", "d1"]]));
    expect(r).toMatchObject({ receiptNumber: "HR-000001" });
    expect(deleteDraft).toHaveBeenCalledWith("d1", "u1");
  });

  it("does nothing when the receipt was not filed from a draft", async () => {
    await createReceiptAction(undefined, validForm());
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("still reports success when the cleanup fails — the receipt already exists", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteDraft.mockRejectedValueOnce(new Error("db down"));
    const r = await createReceiptAction(undefined, validForm([["draftId", "d1"]]));
    expect(r).toMatchObject({ receiptNumber: "HR-000001" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not delete the draft when the receipt fails to create", async () => {
    createTransfer.mockRejectedValueOnce(new Error("nope"));
    await createReceiptAction(undefined, validForm([["draftId", "d1"]]));
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});
