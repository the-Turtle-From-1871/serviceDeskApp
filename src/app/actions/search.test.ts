import { describe, it, expect, vi, beforeEach } from "vitest";

const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));
const searchItemsBySerial = vi.fn();
const getTransferByReceiptNumber = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ searchItemsBySerial: (q: string) => searchItemsBySerial(q) }));
vi.mock("@/modules/transfers/transfers.service", () => ({ getTransferByReceiptNumber: (n: string) => getTransferByReceiptNumber(n) }));

import { searchAction } from "./search";

function fd(o: Record<string, string>): FormData { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; }
beforeEach(() => vi.clearAllMocks());

describe("searchAction", () => {
  it("errors on a blank query", async () => {
    expect(await searchAction(undefined, fd({ mode: "serial", query: "  " }))).toEqual({ error: "Enter a search term." });
  });
  it("serial: redirects to the item on a single match", async () => {
    searchItemsBySerial.mockResolvedValue([{ id: "itm1", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" }]);
    await expect(searchAction(undefined, fd({ mode: "serial", query: "SN1" }))).rejects.toThrow("REDIRECT:/i/itm1");
  });
  it("serial: returns a results list on multiple matches", async () => {
    searchItemsBySerial.mockResolvedValue([
      { id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" },
      { id: "b", make: "HP", model: "E", serialNumber: "SN12", status: "ACTIVE" },
    ]);
    const r = await searchAction(undefined, fd({ mode: "serial", query: "SN1" }));
    expect(r).toEqual({ results: [
      { id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" },
      { id: "b", make: "HP", model: "E", serialNumber: "SN12", status: "ACTIVE" },
    ] });
  });
  it("receipt: redirects to the receipt when found", async () => {
    getTransferByReceiptNumber.mockResolvedValue({ receiptNumber: "HR-000042" });
    await expect(searchAction(undefined, fd({ mode: "receipt", query: "hr-000042" }))).rejects.toThrow("REDIRECT:/receipts/HR-000042");
  });
  it("receipt: errors when not found", async () => {
    getTransferByReceiptNumber.mockResolvedValue(null);
    expect(await searchAction(undefined, fd({ mode: "receipt", query: "HR-999" }))).toEqual({ error: "No hand receipt found with that number." });
  });
});
