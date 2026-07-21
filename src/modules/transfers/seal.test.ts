import { describe, it, expect } from "vitest";
import { canonicalize } from "@/lib/crypto";
import { buildHandoffManifest, manifestFromTransfer, type ManifestInput } from "./seal";

const when = new Date("2026-07-20T18:04:11.482Z");
const base: ManifestInput = {
  receiptNumber: "HR-000123",
  actingUserId: "user-1",
  sealedAt: when,
  receiver: { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "j@u.mil" },
  receiverSignature: "data:image/png;base64,AAAA",
  items: [
    { serialNumber: "B7", make: "AN/PVS", model: "14" },
    { serialNumber: "A1", make: "M4", model: "Carbine" },
  ],
};

describe("buildHandoffManifest", () => {
  it("is item-order independent (items sorted by serialNumber)", () => {
    const reversed = { ...base, items: [...base.items].reverse() };
    expect(canonicalize(buildHandoffManifest(base))).toBe(canonicalize(buildHandoffManifest(reversed)));
  });
});

describe("manifestFromTransfer", () => {
  it("reproduces the exact manifest a sealed row was built from", () => {
    const row = {
      receiptNumber: "HR-000123",
      createdByUserId: "user-1",
      sealedAt: when,
      cryptoSignature: "sig",
      receiverIsDcsim: false, receiverName: "Jane", receiverRank: "SGT",
      receiverUnit: "A Co", receiverContact: "808", receiverEmail: "j@u.mil",
      receiverSignature: "data:image/png;base64,AAAA",
      lines: [
        { make: "M4", model: "Carbine", items: [{ serialNumber: "A1" }] },
        { make: "AN/PVS", model: "14", items: [{ serialNumber: "B7" }] },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(canonicalize(manifestFromTransfer(row as any)!)).toBe(canonicalize(buildHandoffManifest(base)));
  });

  it("returns null for an unsealed row (no sealedAt)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(manifestFromTransfer({ sealedAt: null } as any)).toBeNull();
  });
});
