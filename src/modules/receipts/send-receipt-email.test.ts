import { describe, it, expect, vi, afterEach } from "vitest";
import { sendReceiptEmails } from "./send-receipt-email";
import { DEFAULT_RECEIPT_CC_EMAILS } from "@/lib/email-recipients";
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
  it("sends ONE message to the customer, copying the record addresses", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" } },
      { sender: { send } }
    );
    // One message, not one per recipient -- that is the whole point of the change.
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("j@u.mil");
    expect(msg.cc).toEqual(DEFAULT_RECEIPT_CC_EMAILS);
    expect(msg.subject).toBe(`NEW: ${base.receiptNumber}`);
    expect(msg.text).toContain(`New hand receipt ${base.receiptNumber} has been created.`);
    expect(msg.text).toContain("Dell Latitude (SN SN123)");
    expect(msg.text).toContain("Panasonic Toughbook (SN SN456)");
    expect(msg.text).toContain(base.receiptUrl);
  });

  it("puts a second outside party on CC rather than dropping them", async () => {
    process.env.RECEIPT_CC_EMAILS = "";
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: false, name: "A", email: "a@u.mil" }, receiver: { isDcsim: false, name: "B", email: "b@u.mil" } },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    // The receiver is the customer of record, so they get the To line.
    expect(msg.to).toBe("b@u.mil");
    expect(msg.cc).toEqual(["a@u.mil"]);
  });

  it("never throws when the underlying sender fails", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => { throw new Error("boom"); });
    await expect(
      sendReceiptEmails(
        { ...base, sender: { isDcsim: false, name: "A", email: "a@u.mil" }, receiver: { isDcsim: false, name: "B", email: "b@u.mil" } },
        { sender: { send } }
      )
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
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

  it("copies the admin inbox on the SAME message, not a separate one", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    const send = vi.fn(async (_msg: EmailMessage) => {});
    const pdf = new Uint8Array([1, 2, 3]);
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" }, pdf },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("j@u.mil");
    expect(msg.cc).toContain("admin@army.mil");
    expect(msg.attachments).toEqual([{ filename: `hand-receipt-${base.receiptNumber}.pdf`, content: pdf }]);
  });

  it("omits the admin inbox from CC when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" } },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("j@u.mil");
    expect(send.mock.calls[0][0].cc).toEqual(DEFAULT_RECEIPT_CC_EMAILS);
  });

  it("still sends when both parties are DCSIM, promoting a record copy to the To line", async () => {
    // A message addressed only via CC is treated as suspicious by several gateways,
    // so with no customer the first copy becomes the recipient.
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: true, name: "Tech2" } },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe(DEFAULT_RECEIPT_CC_EMAILS[0]);
    expect(msg.cc).toEqual(DEFAULT_RECEIPT_CC_EMAILS.slice(1));
    expect(msg.subject).toBe(`NEW: ${base.receiptNumber}`);
  });

  it("sends nothing when there is no customer and the record copies are disabled", async () => {
    process.env.RECEIPT_CC_EMAILS = "";
    delete process.env.ADMIN_INBOX_EMAIL;
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      { ...base, sender: { isDcsim: true, name: "Tech" }, receiver: { isDcsim: true, name: "Tech2" } },
      { sender: { send } }
    );
    expect(send).not.toHaveBeenCalled();
  });
});
