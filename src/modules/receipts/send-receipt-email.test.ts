import { describe, it, expect, vi } from "vitest";
import { sendReceiptEmails } from "./send-receipt-email";
import type { EmailMessage } from "@/lib/email";

const base = {
  receiptNumber: "HR-AAAA1111",
  receiptUrl: "https://x/receipts/HR-AAAA1111",
  itemSummary: "Dell Latitude (SN SN123)",
};

describe("sendReceiptEmails", () => {
  it("emails only non-DCSIM parties, using their email", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      {
        ...base,
        sender: { isDcsim: true, name: "Tech" },
        receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" },
      },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("j@u.mil");
    // Subject is just the hand receipt number.
    expect(send.mock.calls[0][0].subject).toBe(base.receiptNumber);
    // Body carries a short message plus the receipt link.
    expect(send.mock.calls[0][0].text).toContain(base.receiptUrl);
    expect(send.mock.calls[0][0].text).toContain(base.receiptNumber);
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
      {
        ...base,
        sender: { isDcsim: true, name: "Tech" },
        receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" },
        pdf,
      },
      { sender: { send } }
    );
    const msg = send.mock.calls[0][0];
    expect(msg.attachments).toEqual([{ filename: `hand-receipt-${base.receiptNumber}.pdf`, content: pdf }]);
  });

  it("omits attachments when no PDF is supplied", async () => {
    const send = vi.fn(async (_msg: EmailMessage) => {});
    await sendReceiptEmails(
      {
        ...base,
        sender: { isDcsim: true, name: "Tech" },
        receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" },
      },
      { sender: { send } }
    );
    expect(send.mock.calls[0][0].attachments).toBeUndefined();
  });
});
