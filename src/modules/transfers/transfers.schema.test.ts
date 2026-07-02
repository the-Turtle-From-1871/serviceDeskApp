import { describe, it, expect } from "vitest";
import { partySchema, transferSchema, SIGNATURE_PREFIX } from "./transfers.schema";

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
  it("rejects a non-DCSIM party with an invalid email", () => {
    const r = partySchema.safeParse({ ...fullParty, email: "not-an-email" });
    expect(r.success).toBe(false);
  });
});

describe("transferSchema", () => {
  it("accepts a valid DCSIM-sender transfer", () => {
    const r = transferSchema.safeParse({ itemId: "itm1", sender: dcsimParty, receiver: fullParty, receiverSignature: sig });
    expect(r.success).toBe(true);
  });
  it("rejects when both parties are DCSIM", () => {
    const r = transferSchema.safeParse({ itemId: "itm1", sender: dcsimParty, receiver: { isDcsim: true, name: "Other Tech" }, receiverSignature: sig });
    expect(r.success).toBe(false);
  });
  it("rejects a missing/short signature", () => {
    const r = transferSchema.safeParse({ itemId: "itm1", sender: dcsimParty, receiver: fullParty, receiverSignature: "nope" });
    expect(r.success).toBe(false);
  });
});
