import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

vi.mock("@/lib/authz", () => ({
  requireAdmin: vi.fn(async () => ({ id: "u1", role: "ADMIN" })),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getTransferByReceiptNumber: vi.fn(),
}));

import { requireAdmin } from "@/lib/authz";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { generateCryptographicSeal } from "@/lib/crypto";
import { manifestFromTransfer } from "@/modules/transfers/seal";
import { verifyReceiptSealAction } from "./verify-seal";

const savedKey = process.env.SIGNING_PRIVATE_KEY;
function setKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
function sealedRow() {
  const row: Record<string, unknown> = {
    receiptNumber: "HR-000123", createdByUserId: "u1", sealedAt: new Date("2026-07-20T18:04:11.482Z"),
    receiverIsDcsim: false, receiverName: "Jane", receiverRank: "SGT", receiverUnit: "A Co",
    receiverContact: "808", receiverEmail: "j@u.mil", receiverSignature: "data:image/png;base64,AAAA",
    lines: [{ make: "M4", model: "Carbine", items: [{ serialNumber: "A1" }] }],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row.cryptoSignature = generateCryptographicSeal(manifestFromTransfer(row as any)!);
  return row;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (savedKey === undefined) delete process.env.SIGNING_PRIVATE_KEY;
  else process.env.SIGNING_PRIVATE_KEY = savedKey;
});

describe("verifyReceiptSealAction", () => {
  it("returns VALID for an intact sealed receipt", async () => {
    setKey();
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(sealedRow() as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("VALID");
  });

  it("returns TAMPERED when a sealed field was altered", async () => {
    setKey();
    const row = sealedRow();
    row.receiverName = "Someone Else"; // mutate AFTER signing
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(row as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("TAMPERED");
  });

  it("returns UNSEALED when there is no signature", async () => {
    setKey();
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce({ ...sealedRow(), cryptoSignature: null } as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("UNSEALED");
  });

  it("returns NOT_FOUND when the receipt is gone", async () => {
    setKey();
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(null);
    expect((await verifyReceiptSealAction("HR-NOPE")).status).toBe("NOT_FOUND");
  });

  it("returns CANNOT_VERIFY when the key is unset", async () => {
    setKey();
    const signed = sealedRow(); // sign while a key is present...
    delete process.env.SIGNING_PRIVATE_KEY; // ...then remove it before verifying
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(signed as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("CANNOT_VERIFY");
  });

  it("rejects a non-admin caller", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(verifyReceiptSealAction("HR-000123")).rejects.toThrow();
  });
});
