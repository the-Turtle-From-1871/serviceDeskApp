import { describe, it, expect } from "vitest";
import { partySchema, receiptSchema, SIGNATURE_PREFIX } from "./transfers.schema";

const sig = SIGNATURE_PREFIX + "AAAA";
const fullParty = { isDcsim: false, name: "Jane Doe", rank: "SGT", unit: "A Co", contact: "808-555-1212", email: "jane@unit.mil" };
const dcsimParty = { isDcsim: true, name: "SPC Tech" };

describe("partySchema", () => {
  it("accepts a full non-DCSIM party and lowercases email", () => {
    const p = partySchema.parse({ ...fullParty, email: "Jane@Unit.Mil" });
    expect(p.email).toBe("jane@unit.mil");
  });
  it("accepts a DCSIM party with only a name", () => {
    expect(partySchema.parse(dcsimParty).name).toBe("SPC Tech");
  });
  it("rejects a non-DCSIM party missing unit/contact/email", () => {
    const r = partySchema.safeParse({ isDcsim: false, name: "No Fields" });
    expect(r.success).toBe(false);
  });
  // Rank is optional on purpose — the book holds civilians and contractors with
  // no rank, and requiring one made inventing a value the only way to file a
  // receipt. Blank and absent must both survive, and both must normalise to
  // undefined so `transfers.service`'s `rank ?? null` stores a real NULL rather
  // than an empty string that would print as a leading space on the PDF.
  it("accepts a non-DCSIM party with no rank", () => {
    const { rank: _rank, ...noRank } = fullParty;
    const r = partySchema.safeParse(noRank);
    expect(r.success).toBe(true);
    expect(r.success && r.data.rank).toBeUndefined();
  });
  it("treats a blank rank as absent rather than an empty string", () => {
    const r = partySchema.safeParse({ ...fullParty, rank: "   " });
    expect(r.success).toBe(true);
    expect(r.success && r.data.rank).toBeUndefined();
  });
  it("still rejects a non-DCSIM party missing unit, even with a rank", () => {
    const { unit: _unit, ...noUnit } = fullParty;
    expect(partySchema.safeParse(noUnit).success).toBe(false);
  });
  it("rejects a non-DCSIM party with an invalid email", () => {
    const r = partySchema.safeParse({ ...fullParty, email: "not-an-email" });
    expect(r.success).toBe(false);
  });
});

describe("receiptSchema", () => {
  const base = {
    itemIds: ["i1", "i2"],
    lines: [{ make: "M4", model: "Carbine", qtyAuth: 2, qtyIssued: 2 }],
    sender: dcsimParty,
    receiver: fullParty,
    receiverSignature: sig,
  };
  it("accepts a valid multi-item receipt", () => {
    expect(receiptSchema.safeParse(base).success).toBe(true);
  });
  it("coerces string quantities to positive ints", () => {
    const r = receiptSchema.parse({ ...base, lines: [{ make: "M4", model: "Carbine", qtyAuth: "3", qtyIssued: "2" }] });
    expect(r.lines[0]).toMatchObject({ qtyAuth: 3, qtyIssued: 2 });
  });
  it("rejects an empty item list", () => {
    expect(receiptSchema.safeParse({ ...base, itemIds: [] }).success).toBe(false);
  });
  it("rejects a zero or negative quantity", () => {
    expect(receiptSchema.safeParse({ ...base, lines: [{ make: "M4", model: "Carbine", qtyAuth: 0, qtyIssued: 1 }] }).success).toBe(false);
  });
  it("rejects more than 18 lines", () => {
    const lines = Array.from({ length: 19 }, (_, n) => ({ make: `M${n}`, model: "x", qtyAuth: 1, qtyIssued: 1 }));
    expect(receiptSchema.safeParse({ ...base, lines }).success).toBe(false);
  });
  it("rejects when both parties are DCSIM", () => {
    expect(receiptSchema.safeParse({ ...base, receiver: { isDcsim: true, name: "Other Tech" } }).success).toBe(false);
  });
});
