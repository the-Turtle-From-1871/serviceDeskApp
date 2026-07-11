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
    expect(msg.cc).toBe("desk@g6.mil");
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

  it("copies the admin inbox with the CLOSED subject and PDF on a full return", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    const pdf = new Uint8Array([1, 2, 3]);
    await sendReturnEmail(full({ pdf }), { sender: { send } });
    const adminMsg = send.mock.calls.find((c) => c[0].to === "admin@army.mil")![0];
    expect(adminMsg.subject).toBe(`CLOSED: ${base.receiptNumber}`);
    expect(adminMsg.attachments).toEqual([{ filename: `hand-receipt-${base.receiptNumber}.pdf`, content: pdf }]);
  });

  it("copies the admin inbox with the UPDATED subject on a partial return", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } }); // PARTIAL
    const adminMsg = send.mock.calls.find((c) => c[0].to === "admin@army.mil")![0];
    expect(adminMsg.subject).toBe(`UPDATED: ${base.receiptNumber}`);
    expect(adminMsg.text).toContain(`Hand receipt ${base.receiptNumber} has been updated.`);
  });

  it("does not copy the admin inbox when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(full(), { sender: { send } });
    expect(send.mock.calls.filter((c) => c[0].to === "admin@army.mil")).toHaveLength(0);
  });
});
