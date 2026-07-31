import { describe, it, expect, vi, beforeEach } from "vitest";

const searchItemsBySerial = vi.fn();
const searchReceiptsByNumber = vi.fn();
const allowed = vi.fn<() => Promise<boolean>>();
vi.mock("@/modules/items/items.service", () => ({ searchItemsBySerial: (q: string) => searchItemsBySerial(q) }));
vi.mock("@/modules/transfers/transfers.service", () => ({ searchReceiptsByNumber: (q: string) => searchReceiptsByNumber(q) }));
vi.mock("@/lib/public-access-guard", () => ({ publicAccessAllowed: () => allowed() }));

import { liveSearchAction } from "./search";

beforeEach(() => {
  vi.clearAllMocks();
  allowed.mockResolvedValue(true);
});

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

// `/` is no longer PIN-gated in the proxy — it has to be readable by a stranger,
// because it is the page that explains what this application is. A Server Action
// POSTs to the path of the page hosting it, so this action's own check is now
// the ONLY thing between an anonymous POST and the whole item + receipt catalog.
describe("liveSearchAction — the PIN gate it enforces for itself", () => {
  beforeEach(() => allowed.mockResolvedValue(false));

  it("refuses a locked serial search instead of running it", async () => {
    expect(await liveSearchAction("serial", "SN1")).toEqual({ locked: true });
    expect(searchItemsBySerial).not.toHaveBeenCalled();
  });

  it("refuses a locked receipt lookup instead of running it", async () => {
    expect(await liveSearchAction("receipt", "HR-000001")).toEqual({ locked: true });
    expect(searchReceiptsByNumber).not.toHaveBeenCalled();
  });

  it("reports the refusal as locked, NOT as an empty result", async () => {
    // An empty result renders "No matches." — telling someone their serial
    // number does not exist, which is a confident wrong answer about the
    // property book rather than a prompt to re-enter the PIN. The 12-hour
    // cookie can lapse with this page open, so it is a real user's path.
    const res = await liveSearchAction("serial", "SN1");
    expect(res.items).toBeUndefined();
    expect(res.receipts).toBeUndefined();
  });

  it("checks the gate BEFORE the blank-query short-circuit", async () => {
    // Ordering, pinned deliberately: the blank-query return used to be the
    // first statement in the function, and left there it answers `{items: []}`
    // to a locked caller — a different reply for a locked caller than a
    // refusal, and the wrong order to leave for whoever edits this next.
    expect(await liveSearchAction("serial", "   ")).toEqual({ locked: true });
  });
});
