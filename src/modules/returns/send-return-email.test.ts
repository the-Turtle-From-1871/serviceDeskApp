import { describe, it, expect, vi, afterEach } from "vitest";
import { sendReturnEmail, type ReturnEmailArgs } from "./send-return-email";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

const base: ReturnEmailArgs = {
  receiver: { isDcsim: false, name: "Jane", email: "jane@u.mil" },
  receiptNumber: "HR-000123",
  receiptUrl: "https://x/receipts/HR-000123",
  kind: "PARTIAL",
  returned: [{ serialNumber: "SN-A", make: "Dell", model: "5540" }],
  byLine: [{ lineNo: 1, make: "Dell", model: "5540", heldBefore: 2, returnedNow: 1, heldAfter: 1 }],
  processedByName: "Tech",
  processedByEmail: "tech@g6.mil",
  processedAt: new Date("2026-07-09T20:00:00Z"),
};

describe("sendReturnEmail", () => {
  it("emails the receiver, CCs the desk, and uses the partial subject", async () => {
    process.env.G6_SERVICE_DESK_EMAIL = "desk@g6.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("jane@u.mil");
    expect(msg.cc).toBe("desk@g6.mil");
    expect(msg.subject).toBe("UPDATE: G6 Digital Hand Receipt - Partial Property Return Confirmation [ID: HR-000123]");
    expect(msg.text).toContain("SN-A");
    expect(msg.text).toContain("AR 735-5");
  });

  it("uses the clearance subject and CLEARED banner on a full return", async () => {
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail({ ...base, kind: "FULL", byLine: [{ ...base.byLine[0], returnedNow: 2, heldAfter: 0 }] }, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.subject).toBe("CLEARANCE RECORD: G6 Digital Hand Receipt - Final Property Return [ID: HR-000123]");
    expect(msg.text).toMatch(/CLEARED/);
  });

  it("omits CC when the desk env var is unset", async () => {
    delete process.env.G6_SERVICE_DESK_EMAIL;
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    expect(send.mock.calls[0][0].cc).toBeUndefined();
  });

  it("falls back to the desk as recipient when the receiver has no email", async () => {
    process.env.G6_SERVICE_DESK_EMAIL = "desk@g6.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail({ ...base, receiver: { isDcsim: false, name: "Jane", email: null } }, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("desk@g6.mil");
    expect(msg.cc).toBeUndefined();
  });

  it("never throws when the sender fails", async () => {
    const send = vi.fn(async () => { throw new Error("boom"); });
    await expect(sendReturnEmail(base, { sender: { send } })).resolves.toBeUndefined();
  });
});
