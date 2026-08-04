import { describe, it, expect, vi, afterEach } from "vitest";
import { sendReturnEmail, type ReturnEmailArgs } from "./send-return-email";
import { DEFAULT_RECEIPT_CC_EMAILS } from "@/lib/email-recipients";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

const base: ReturnEmailArgs = {
  receiver: { isDcsim: false, name: "Jane", email: "jane@u.mil" },
  receiptNumber: "HR-000123",
  receiptUrl: "https://x/receipts/HR-000123",
  kind: "PARTIAL",
  returned: [{ serialNumber: "SN-A", make: "Dell", model: "5540" }],
  remaining: [{ serialNumber: "SN-B", make: "Dell", model: "5540" }],
  allItems: [
    { serialNumber: "SN-A", make: "Dell", model: "5540" },
    { serialNumber: "SN-B", make: "Dell", model: "5540" },
  ],
};

const full = (over: Partial<ReturnEmailArgs> = {}): ReturnEmailArgs => ({ ...base, kind: "FULL", ...over });

describe("sendReturnEmail", () => {
  it("uses UPDATED subject and lists returned + not-returned on a partial return", async () => {
    process.env.G6_SERVICE_DESK_EMAIL = "desk@g6.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("jane@u.mil");
    expect(msg.cc).toEqual(["desk@g6.mil", ...DEFAULT_RECEIPT_CC_EMAILS]);
    expect(msg.subject).toBe(`UPDATED: ${base.receiptNumber}`);
    expect(msg.text).toContain(`Hand receipt ${base.receiptNumber} has been updated.`);
    expect(msg.text).toContain("Returned:");
    expect(msg.text).toContain("Dell 5540 (SN SN-A)"); // returned
    expect(msg.text).toContain("Not returned:");
    expect(msg.text).toContain("Dell 5540 (SN SN-B)"); // still out
  });

  it("uses CLOSED subject and lists all items on a full return", async () => {
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(full(), { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.subject).toBe(`CLOSED: ${base.receiptNumber}`);
    expect(msg.text).toContain(`Hand receipt ${base.receiptNumber} has been closed.`);
    expect(msg.text).toContain("Dell 5540 (SN SN-A)");
    expect(msg.text).toContain("Dell 5540 (SN SN-B)");
  });

  it("omits the desk from CC when its env var is unset, keeping the record copies", async () => {
    delete process.env.G6_SERVICE_DESK_EMAIL;
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    expect(send.mock.calls[0][0].cc).toEqual(DEFAULT_RECEIPT_CC_EMAILS);
  });

  it("has no CC at all when the desk is unset and the record copies are disabled", async () => {
    delete process.env.G6_SERVICE_DESK_EMAIL;
    delete process.env.ADMIN_INBOX_EMAIL;
    process.env.RECEIPT_CC_EMAILS = "";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    expect(send.mock.calls[0][0].cc).toBeUndefined();
  });

  it("falls back to the desk as recipient when the receiver has no email", async () => {
    process.env.G6_SERVICE_DESK_EMAIL = "desk@g6.mil";
    process.env.RECEIPT_CC_EMAILS = "";
    delete process.env.ADMIN_INBOX_EMAIL;
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

  it("attaches the PDF when supplied", async () => {
    const send = vi.fn(async (_m: EmailMessage) => {});
    const pdf = new Uint8Array([1, 2, 3]);
    await sendReturnEmail({ ...base, pdf }, { sender: { send } });
    expect(send.mock.calls[0][0].attachments).toEqual([{ filename: `hand-receipt-${base.receiptNumber}.pdf`, content: pdf }]);
  });

  it("omits attachments when no PDF is supplied", async () => {
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    expect(send.mock.calls[0][0].attachments).toBeUndefined();
  });

  it("copies the admin inbox on the SAME message rather than a separate archive send", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    const pdf = new Uint8Array([1, 2, 3]);
    await sendReturnEmail(full({ pdf }), { sender: { send } });
    // Previously this produced two messages: one to the customer and one to the
    // admin inbox. It is now one message with the admin inbox on CC.
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("jane@u.mil");
    expect(msg.cc).toContain("admin@army.mil");
    expect(msg.subject).toBe(`CLOSED: ${base.receiptNumber}`);
    expect(msg.attachments).toEqual([{ filename: `hand-receipt-${base.receiptNumber}.pdf`, content: pdf }]);
  });

  it("copies the admin inbox on a partial return too", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } }); // PARTIAL
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.cc).toContain("admin@army.mil");
    expect(msg.subject).toBe(`UPDATED: ${base.receiptNumber}`);
    expect(msg.text).toContain(`Hand receipt ${base.receiptNumber} has been updated.`);
  });

  it("does not copy the admin inbox when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(full(), { sender: { send } });
    const cc = send.mock.calls[0][0].cc;
    expect(Array.isArray(cc) ? cc : [cc]).not.toContain("admin@army.mil");
  });
});
