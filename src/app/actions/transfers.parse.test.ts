import { describe, it, expect } from "vitest";
import { parseTransferForm } from "./transfers.parse";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("parseTransferForm", () => {
  it("reads an existing-item transfer with a DCSIM sender", () => {
    const out = parseTransferForm(fd({
      itemMode: "existing", itemId: "itm1",
      senderIsDcsim: "on", senderName: "Tech",
      receiverIsDcsim: "", receiverName: "Jane", receiverRank: "SGT", receiverUnit: "A Co", receiverContact: "808", receiverEmail: "j@u.mil",
      receiverSignature: "data:image/png;base64,AAAA",
    }));
    expect(out.itemMode).toBe("existing");
    expect(out.itemId).toBe("itm1");
    expect(out.sender.isDcsim).toBe(true);
    expect(out.receiver.isDcsim).toBe(false);
    expect(out.receiver.email).toBe("j@u.mil");
  });
  it("reads a new-item transfer", () => {
    const out = parseTransferForm(fd({
      itemMode: "new", make: "Dell", model: "Latitude", serialNumber: "SN1", homeUnit: "A Co",
      senderIsDcsim: "", senderName: "A", senderRank: "PVT", senderUnit: "A", senderContact: "1", senderEmail: "a@u.mil",
      receiverIsDcsim: "on", receiverName: "Tech",
      receiverSignature: "data:image/png;base64,BBBB",
    }));
    expect(out.itemMode).toBe("new");
    expect(out.newItem?.make).toBe("Dell");
    expect(out.receiver.isDcsim).toBe(true);
  });
});
