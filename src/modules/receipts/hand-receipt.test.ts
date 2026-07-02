import { describe, it, expect } from "vitest";
import { buildHandReceiptPdf, type ReceiptData } from "./hand-receipt";

const base: ReceiptData = {
  receiptNumber: "HR-AAAA1111",
  status: "COMPLETED",
  createdAt: new Date("2026-07-02T00:00:00Z"),
  receiptUrl: "https://app.example/receipts/HR-AAAA1111",
  receiverSignature: "",
  item: { make: "Dell", model: "Latitude", serialNumber: "SN123", homeUnit: "A Co" },
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
});
