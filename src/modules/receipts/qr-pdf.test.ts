import { describe, it, expect } from "vitest";
import { buildItemQrPdf } from "./qr-pdf";

describe("buildItemQrPdf", () => {
  it("produces a non-empty PDF for an item", async () => {
    const bytes = await buildItemQrPdf({ id: "itm1", make: "Dell", model: "Latitude", serialNumber: "SN123", homeUnit: "A Co" });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
});
