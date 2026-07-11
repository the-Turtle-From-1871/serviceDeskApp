import { describe, it, expect, vi, afterEach } from "vitest";
import { sendReceiptEmails } from "./send-receipt-email";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

const base = {
  receiptNumber: "HR-AAAA1111",
  receiptUrl: "https://x/receipts/HR-AAAA1111",
  items: [
    { make: "Dell", model: "Latitude", serialNumber: "SN123" },
    { make: "Panasonic", model: "Toughbook", serialNumber: "SN456" },
  ],
};

describe("sendReceiptEmails", () => {
  it("emails non-DCSIM parties with a NEW: subject and an itemized body", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" } },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("j@u.mil");
    expect(msg.subject).toBe(`NEW: ${base.receiptNumber}`);
    expect(msg.text).toContain(`New hand receipt ${base.receiptNumber} has been created.`);
    expect(msg.text).toContain("Dell Latitude (SN SN123)");
    expect(msg.text).toContain("Panasonic Toughbook (SN SN456)");
    expect(msg.text).toContain(base.receiptUrl);
  });

  it("never throws when the underlying sender fails", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => { throw new Error("boom"); });
    await expect(
      sendReceiptEmails(
        { ...base, sender: { isDcsim: false, name: "A", email: "a@u.mil" }, receiver: { isDcsim: false, name: "B", email: "b@u.mil" } },
        { sender: { send } }
      )
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("attaches the PDF when supplied", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => {});
    const pdf = new Uint8Array([1, 2, 3]);
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" }, pdf },
      { sender: { send } }
    );
    expect(send.mock.calls[0][0].attachments).toEqual([{ filename: `hand-receipt-${base.receiptNumber}.pdf`, content: pdf }]);
  });

  it("omits attachments when no PDF is supplied", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" } },
      { sender: { send } }
    );
    expect(send.mock.calls[0][0].attachments).toBeUndefined();
  });

  it("copies the admin inbox with the same NEW: subject and PDF when configured", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    const send = vi.fn(async (_msg: EmailMessage) => {});
    const pdf = new Uint8Array([1, 2, 3]);
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" }, pdf },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(2);
    const adminMsg = send.mock.calls.find((c) => c[0].to === "admin@army.mil")![0];
    expect(adminMsg.subject).toBe(`NEW: ${base.receiptNumber}`);
    expect(adminMsg.text).toContain("Dell Latitude (SN SN123)");
    expect(adminMsg.attachments).toEqual([{ filename: `hand-receipt-${base.receiptNumber}.pdf`, content: pdf }]);
  });

  it("does not copy the admin inbox when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" } },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("j@u.mil");
  });

  it("still copies the admin inbox even when both parties are DCSIM (no party emails)", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: true, name: "Tech2" } },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@army.mil");
    expect(send.mock.calls[0][0].subject).toBe(`NEW: ${base.receiptNumber}`);
  });
});
