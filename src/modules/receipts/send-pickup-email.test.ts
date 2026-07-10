import { describe, it, expect, vi } from "vitest";
import {
  sendPickupEmail,
  PICKUP_SUBJECT,
  customerParty,
  pickupItems,
  type PickupEmailArgs,
} from "./send-pickup-email";
import type { EmailMessage } from "@/lib/email";

const args: PickupEmailArgs = {
  customerName: "Jane",
  customerEmail: "jane@u.mil",
  receiptNumber: "HR-000123",
  receiptUrl: "https://x/receipts/HR-000123",
  items: [
    { make: "Dell", model: "Latitude", serialNumber: "SN-A" },
    { make: "Panasonic", model: "Toughbook", serialNumber: "SN-B" },
  ],
};

describe("sendPickupEmail", () => {
  it("emails the customer with the exact pickup subject and an itemized body", async () => {
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendPickupEmail(args, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("jane@u.mil");
    expect(msg.subject).toBe("DCSIM Service Desk - Items Ready for Pickup");
    expect(msg.subject).toBe(PICKUP_SUBJECT);
    expect(msg.text).toContain("Dell Latitude (SN SN-A)");
    expect(msg.text).toContain("Panasonic Toughbook (SN SN-B)");
    expect(msg.text).toContain("Items ready (2)");
    expect(msg.text).toContain(args.receiptUrl);
  });

  it("propagates a send failure so the caller can report it", async () => {
    const send = vi.fn(async () => { throw new Error("boom"); });
    await expect(sendPickupEmail(args, { sender: { send } })).rejects.toThrow("boom");
  });
});

const receipt = (over: Record<string, unknown> = {}) => ({
  senderIsDcsim: true,
  senderName: "DCSIM Tech",
  senderEmail: null,
  receiverIsDcsim: false,
  receiverName: "Jane",
  receiverEmail: "jane@u.mil",
  lines: [
    {
      make: "Dell",
      model: "Latitude",
      items: [
        { serialNumber: "SN-A", returnedAt: null },
        { serialNumber: "SN-B", returnedAt: new Date("2026-01-01") }, // already returned
      ],
    },
    { make: "Panasonic", model: "Toughbook", items: [{ serialNumber: "SN-C", returnedAt: null }] },
  ],
  ...over,
});

describe("customerParty", () => {
  it("returns the receiver when the receiver is the non-DCSIM party", () => {
    expect(customerParty(receipt())).toEqual({ name: "Jane", email: "jane@u.mil" });
  });

  it("returns the sender when the sender is the non-DCSIM party", () => {
    const t = receipt({ senderIsDcsim: false, senderName: "Bob", senderEmail: "bob@u.mil", receiverIsDcsim: true, receiverName: "DCSIM", receiverEmail: null });
    expect(customerParty(t)).toEqual({ name: "Bob", email: "bob@u.mil" });
  });

  it("prefers the receiver when both parties are non-DCSIM", () => {
    const t = receipt({ senderIsDcsim: false, senderName: "Bob", senderEmail: "bob@u.mil" });
    expect(customerParty(t)).toEqual({ name: "Jane", email: "jane@u.mil" });
  });
});

describe("pickupItems", () => {
  it("lists only items not yet returned, flattened across lines", () => {
    expect(pickupItems(receipt())).toEqual([
      { make: "Dell", model: "Latitude", serialNumber: "SN-A" },
      { make: "Panasonic", model: "Toughbook", serialNumber: "SN-C" },
    ]);
  });
});
