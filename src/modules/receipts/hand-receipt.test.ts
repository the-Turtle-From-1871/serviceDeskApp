import { describe, it, expect } from "vitest";
import { buildHandReceiptPdf, partyHeader, partyHeaderShort, type ReceiptData } from "./hand-receipt";

const base: ReceiptData = {
  receiptNumber: "HR-AAAA1111",
  status: "COMPLETED",
  createdAt: new Date("2026-07-02T00:00:00Z"),
  receiptUrl: "https://app.example/receipts/HR-AAAA1111",
  receiverSignature: "",
  lines: [
    { lineNo: 1, make: "M4", model: "Carbine", unitOfIssue: "EA", serials: ["A1", "A2", "A3"], qtyAuth: 3, qtyIssued: 3 },
    { lineNo: 2, make: "AN/PVS", model: "14", unitOfIssue: "EA", serials: ["B7"], qtyAuth: 1, qtyIssued: 1 },
  ],
  sender: { isDcsim: true, name: "SPC Tech", rank: null, unit: null, contact: null, email: null },
  receiver: { isDcsim: false, name: "Jane Doe", rank: "SGT", unit: "A Co", contact: "808-555", email: "j@u.mil" },
};

describe("buildHandReceiptPdf", () => {
  it("produces a non-empty PDF for a DCSIM-sender receipt", async () => {
    const bytes = await buildHandReceiptPdf(base);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
  it("produces a PDF when the receiver is DCSIM and a signature is present", async () => {
    const bytes = await buildHandReceiptPdf({
      ...base,
      sender: base.receiver,
      receiver: { isDcsim: true, name: "SPC Tech", rank: null, unit: null, contact: null, email: null },
      receiverSignature: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
  it("renders a multi-line receipt into a valid PDF", async () => {
    const bytes = await buildHandReceiptPdf(base);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe("partyHeader", () => {
  it("comma-joins rank, name, unit, contact for a full non-DCSIM party", () => {
    expect(partyHeader({ isDcsim: false, name: "Jane Soldier", rank: "SGT", unit: "A Co 1-1 IN", contact: "808-555-0134", email: "j@u.mil" }))
      .toBe("SGT Jane Soldier, A Co 1-1 IN, 808-555-0134");
  });
  it("omits missing unit/contact", () => {
    expect(partyHeader({ isDcsim: false, name: "Jane Soldier", rank: "SGT", unit: null, contact: null, email: null }))
      .toBe("SGT Jane Soldier");
  });
  it("omits rank when absent", () => {
    expect(partyHeader({ isDcsim: false, name: "Jane Soldier", rank: null, unit: "A Co", contact: null, email: null }))
      .toBe("Jane Soldier, A Co");
  });
  it("renders DCSIM parties unchanged", () => {
    expect(partyHeader({ isDcsim: true, name: "SSG Tech", rank: null, unit: null, contact: null, email: null }))
      .toBe("DCSIM · SSG Tech");
  });
});

describe("partyHeaderShort", () => {
  it("omits unit/contact for a non-DCSIM party even when present", () => {
    expect(partyHeaderShort({ isDcsim: false, name: "Jane Soldier", rank: "SGT", unit: "A Co 1-1 IN", contact: "808-555-0134", email: "j@u.mil" }))
      .toBe("SGT Jane Soldier");
  });
  it("omits rank when absent", () => {
    expect(partyHeaderShort({ isDcsim: false, name: "Jane Soldier", rank: null, unit: "A Co", contact: null, email: null }))
      .toBe("Jane Soldier");
  });
  it("renders DCSIM parties unchanged", () => {
    expect(partyHeaderShort({ isDcsim: true, name: "SSG Tech", rank: null, unit: null, contact: null, email: null }))
      .toBe("DCSIM · SSG Tech");
  });
});
