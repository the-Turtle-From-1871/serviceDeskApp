import { describe, it, expect, vi, beforeEach } from "vitest";

const searchItemsBySerial = vi.fn();
const getTransferByReceiptNumber = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ searchItemsBySerial: (q: string) => searchItemsBySerial(q) }));
vi.mock("@/modules/transfers/transfers.service", () => ({ getTransferByReceiptNumber: (n: string) => getTransferByReceiptNumber(n) }));

import { liveSearchAction } from "./search";

beforeEach(() => vi.clearAllMocks());

describe("liveSearchAction", () => {
  it("returns empty items for a blank query without hitting the services", async () => {
    expect(await liveSearchAction("serial", "  ")).toEqual({ items: [] });
    expect(searchItemsBySerial).not.toHaveBeenCalled();
    expect(getTransferByReceiptNumber).not.toHaveBeenCalled();
  });
  it("serial: maps matches to ItemResult[] (dropping extra fields)", async () => {
    searchItemsBySerial.mockResolvedValue([{ id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE", createdAt: new Date() }]);
    expect(await liveSearchAction("serial", "SN1")).toEqual({ items: [{ id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" }] });
  });
  it("receipt: returns the hit when found", async () => {
    getTransferByReceiptNumber.mockResolvedValue({ receiptNumber: "HR-000042", itemSummary: "Dell L (SN SN1)" });
    expect(await liveSearchAction("receipt", "hr-000042")).toEqual({ receipt: { receiptNumber: "HR-000042", itemSummary: "Dell L (SN SN1)" } });
  });
  it("receipt: returns null when not found", async () => {
    getTransferByReceiptNumber.mockResolvedValue(null);
    expect(await liveSearchAction("receipt", "HR-999")).toEqual({ receipt: null });
  });
});
