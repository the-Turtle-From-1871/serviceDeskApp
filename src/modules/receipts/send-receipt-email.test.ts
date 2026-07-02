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
    expect(send.mock.calls[0][0].text).toContain(base.receiptUrl);
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
});
