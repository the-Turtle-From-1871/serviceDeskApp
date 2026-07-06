import { describe, it, expect, vi, beforeEach } from "vitest";

const searchItemsBySerial = vi.fn();
const searchReceiptsByNumber = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ searchItemsBySerial: (q: string) => searchItemsBySerial(q) }));
vi.mock("@/modules/transfers/transfers.service", () => ({ searchReceiptsByNumber: (q: string) => searchReceiptsByNumber(q) }));

import { liveSearchAction } from "./search";

beforeEach(() => vi.clearAllMocks());

describe("liveSearchAction", () => {
  it("returns empty items for a blank query without hitting the services", async () => {
    expect(await liveSearchAction("serial", "  ")).toEqual({ items: [] });
    expect(searchItemsBySerial).not.toHaveBeenCalled();
    expect(searchReceiptsByNumber).not.toHaveBeenCalled();
  });
  it("serial: maps matches to ItemResult[] (dropping extra fields)", async () => {
    searchItemsBySerial.mockResolvedValue([{ id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE", createdAt: new Date() }]);
    expect(await liveSearchAction("serial", "SN1")).toEqual({ items: [{ id: "a", make: "Dell", model: "L", serialNumber: "SN1", status: "ACTIVE" }] });
  });
  it("receipt: partial-matches receipt numbers and maps to ReceiptHit[]", async () => {
    searchReceiptsByNumber.mockResolvedValue([
      { receiptNumber: "HR-000001", itemSummary: "Dell L (SN SN1)", senderName: "x" },
      { receiptNumber: "HR-000012", itemSummary: "HP E (SN SN2)", senderName: "y" },
    ]);
    expect(await liveSearchAction("receipt", "hr-0000")).toEqual({ receipts: [
      { receiptNumber: "HR-000001", itemSummary: "Dell L (SN SN1)" },
      { receiptNumber: "HR-000012", itemSummary: "HP E (SN SN2)" },
    ] });
    expect(searchReceiptsByNumber).toHaveBeenCalledWith("hr-0000");
  });
  it("receipt: returns an empty list when nothing matches", async () => {
    searchReceiptsByNumber.mockResolvedValue([]);
    expect(await liveSearchAction("receipt", "HR-999")).toEqual({ receipts: [] });
  });
});
