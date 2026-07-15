import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem } from "@/modules/items/items.service";
import { processReturn } from "@/modules/returns/returns.service";
import {
  createTransfer,
  getTransferByReceiptNumber,
  getHoldingTransfer,
  getLastReceiver,
  getCurrentOpenTransferId,
} from "./transfers.service";

// Real DB, not vi.mock: every question here is about how receipt status and each
// item's returnedAt interact across a real partial return. A mocked findFirst
// can only replay a shape the author already believes in — which is how the
// partial-return bug lived in three call sites with tests passing.

const SIG = "data:image/png;base64,iVBORw0KGgo=";

let adminId: string;
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Tech", email: "t@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = admin.id;
});

const newItem = (serialNumber: string) =>
  createItem({ make: "Dell", model: "5540", serialNumber, deviceName: "Laptop", homeUnit: undefined, notes: undefined }, adminId);

/** Issue two laptops to Jane on one receipt. Returns both items' ids plus the
 *  TransferItem ids a return needs. */
async function issueTwoToJane() {
  const a = await newItem("SN-A");
  const b = await newItem("SN-B");
  const t = await createTransfer({
    itemIds: [a.id, b.id],
    lines: [{ make: "Dell", model: "5540", qtyAuth: 2, qtyIssued: 2 }],
    sender: { isDcsim: true, name: "Desk" },
    receiver: { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "jane@u.mil" },
    receiverSignature: SIG,
    createdByUserId: adminId,
  });
  const full = (await getTransferByReceiptNumber(t.receiptNumber))!;
  const rows = full.lines[0].items;
  return {
    transferId: t.id,
    receiptNumber: t.receiptNumber,
    itemA: a.id,
    itemB: b.id,
    // TransferItem id for item A, which is what processReturn selects on.
    rowA: rows.find((r) => r.itemId === a.id)!.id,
  };
}

describe("getHoldingTransfer", () => {
  it("names the receiver of the item's open receipt", async () => {
    const { itemA, transferId } = await issueTwoToJane();
    const holder = await getHoldingTransfer(itemA);
    expect(holder?.id).toBe(transferId);
    expect(holder?.receiverName).toBe("Jane");
  });

  it("returns null for an item that has never been on a receipt", async () => {
    const fresh = await newItem("SN-NEW");
    expect(await getHoldingTransfer(fresh.id)).toBeNull();
  });

  // THE BUG: a partial return leaves the receipt OPEN, so keying off status
  // alone reported Jane as still holding a laptop she had already handed back.
  it("returns null for an item returned on a PARTIAL return, while the receipt is still OPEN", async () => {
    const { receiptNumber, itemA, rowA } = await issueTwoToJane();
    const res = await processReturn({
      receiptNumber,
      selectedItemIds: [rowA],
      signature: SIG,
      processedBy: { id: adminId, name: "Tech", email: "t@x.co" },
    });
    if ("error" in res) throw new Error(res.error);
    expect(res.plan.kind).toBe("PARTIAL");
    expect((await getTransferByReceiptNumber(receiptNumber))!.status).toBe("OPEN");

    expect(await getHoldingTransfer(itemA)).toBeNull();
  });

  // The other half: don't over-correct and orphan the items still genuinely out.
  it("still names the holder of the item NOT returned on that same partial return", async () => {
    const { receiptNumber, itemB, rowA, transferId } = await issueTwoToJane();
    await processReturn({
      receiptNumber,
      selectedItemIds: [rowA],
      signature: SIG,
      processedBy: { id: adminId, name: "Tech", email: "t@x.co" },
    });
    const holder = await getHoldingTransfer(itemB);
    expect(holder?.id).toBe(transferId);
    expect(holder?.receiverName).toBe("Jane");
  });

  it("returns null once a FULL return has closed the receipt", async () => {
    const { receiptNumber, itemA, itemB } = await issueTwoToJane();
    const full = (await getTransferByReceiptNumber(receiptNumber))!;
    await processReturn({
      receiptNumber,
      selectedItemIds: full.lines[0].items.map((r) => r.id),
      signature: SIG,
      processedBy: { id: adminId, name: "Tech", email: "t@x.co" },
    });
    expect((await getTransferByReceiptNumber(receiptNumber))!.status).toBe("CLOSED");
    expect(await getHoldingTransfer(itemA)).toBeNull();
    expect(await getHoldingTransfer(itemB)).toBeNull();
  });

  it("follows the newest receipt when an item is re-issued after being returned", async () => {
    const { receiptNumber, itemA, itemB, rowA } = await issueTwoToJane();
    await processReturn({
      receiptNumber,
      selectedItemIds: [rowA],
      signature: SIG,
      processedBy: { id: adminId, name: "Tech", email: "t@x.co" },
    });
    // Item A came back, so re-issue it to Bob on a second receipt.
    const t2 = await createTransfer({
      itemIds: [itemA],
      lines: [{ make: "Dell", model: "5540", qtyAuth: 1, qtyIssued: 1 }],
      sender: { isDcsim: true, name: "Desk" },
      receiver: { isDcsim: false, name: "Bob", rank: "CPL", unit: "C Co", contact: "808", email: "bob@u.mil" },
      receiverSignature: SIG,
      createdByUserId: adminId,
    });
    expect((await getHoldingTransfer(itemA))?.id).toBe(t2.id);
    expect((await getHoldingTransfer(itemA))?.receiverName).toBe("Bob");
    // B never moved — the second receipt must not disturb it.
    expect((await getHoldingTransfer(itemB))?.receiverName).toBe("Jane");
  });
});

describe("getLastReceiver", () => {
  it("maps the holding receipt's receiver into a PartyInput", async () => {
    const { itemA } = await issueTwoToJane();
    expect(await getLastReceiver(itemA)).toEqual({
      isDcsim: false,
      name: "Jane",
      rank: "SGT",
      unit: "A Co",
      contact: "808",
      email: "jane@u.mil",
    });
  });

  it("maps a DCSIM receiver's null columns to undefined", async () => {
    const item = await newItem("SN-D");
    await createTransfer({
      itemIds: [item.id],
      lines: [{ make: "Dell", model: "5540", qtyAuth: 1, qtyIssued: 1 }],
      sender: { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "jane@u.mil" },
      receiver: { isDcsim: true, name: "DCSIM Tech" },
      receiverSignature: SIG,
      createdByUserId: adminId,
    });
    expect(await getLastReceiver(item.id)).toEqual({
      isDcsim: true,
      name: "DCSIM Tech",
      rank: undefined,
      unit: undefined,
      contact: undefined,
      email: undefined,
    });
  });

  it("returns null for an item with no receipts", async () => {
    const fresh = await newItem("SN-NEW");
    expect(await getLastReceiver(fresh.id)).toBeNull();
  });

  // The user-visible bug: this value prefills the SENDER on the next hand
  // receipt, so before the fix a returned item prefilled Jane — who no longer
  // had it — onto a DA 2062.
  it("returns null after a partial return, so the next receipt does not prefill the customer who gave it back", async () => {
    const { receiptNumber, itemA, rowA } = await issueTwoToJane();
    await processReturn({
      receiptNumber,
      selectedItemIds: [rowA],
      signature: SIG,
      processedBy: { id: adminId, name: "Tech", email: "t@x.co" },
    });
    expect(await getLastReceiver(itemA)).toBeNull();
  });
});

describe("getCurrentOpenTransferId", () => {
  it("returns the open receipt id for a held item", async () => {
    const { itemA, transferId } = await issueTwoToJane();
    expect(await getCurrentOpenTransferId(itemA)).toBe(transferId);
  });

  it("returns null for an item returned on a still-open receipt", async () => {
    const { receiptNumber, itemA, rowA } = await issueTwoToJane();
    await processReturn({
      receiptNumber,
      selectedItemIds: [rowA],
      signature: SIG,
      processedBy: { id: adminId, name: "Tech", email: "t@x.co" },
    });
    expect(await getCurrentOpenTransferId(itemA)).toBeNull();
  });
});
