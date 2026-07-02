import { describe, it, expect } from "vitest";
import { parseTransferForm } from "./transfers.parse";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("parseTransferForm", () => {
  it("reads the fixed itemId and both parties (DCSIM sender)", () => {
    const out = parseTransferForm(fd({
      itemId: "itm1",
      senderIsDcsim: "on", senderName: "Tech",
      receiverIsDcsim: "", receiverName: "Jane", receiverRank: "SGT", receiverUnit: "A Co", receiverContact: "808", receiverEmail: "j@u.mil",
      receiverSignature: "data:image/png;base64,AAAA",
    }));
    expect(out.itemId).toBe("itm1");
    expect(out.sender.isDcsim).toBe(true);
    expect(out.receiver.isDcsim).toBe(false);
    expect(out.receiver.email).toBe("j@u.mil");
    expect(out.receiverSignature.startsWith("data:image/png;base64,")).toBe(true);
  });
});
