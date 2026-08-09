import { describe, expect, it, vi } from "vitest";
import { sendDecisionEmail } from "./send-decision-email";

function fakeSender() {
  const send = vi.fn().mockResolvedValue(undefined);
  return { sender: { send }, send };
}

const base = {
  to: "jane@unit.mil",
  name: "Jane",
  accountUrl: "https://www.dcsim.us/account",
};

describe("sendDecisionEmail", () => {
  it("lists approved and denied capabilities by their human labels", async () => {
    const { sender, send } = fakeSender();
    await sendDecisionEmail(
      { ...base, approved: ["MANAGE_QUEUE"], denied: ["ADMINISTER"], denialReason: "Not yet." },
      { sender },
    );
    const msg = send.mock.calls[0][0];
    expect(msg.text).toContain("Manage the service queue");
    expect(msg.text).toContain("Administer the application");
  });

  // Mail clients strip CSS and block images, so colour and icons cannot be the
  // only signal — the words have to be present in both parts.
  it("carries the words Approved and Denied, not just marks", async () => {
    const { sender, send } = fakeSender();
    await sendDecisionEmail(
      { ...base, approved: ["MANAGE_QUEUE"], denied: ["ADMINISTER"], denialReason: "Not yet." },
      { sender },
    );
    const msg = send.mock.calls[0][0];
    expect(msg.text).toContain("Approved");
    expect(msg.text).toContain("Denied");
    expect(msg.html).toContain("Approved");
    expect(msg.html).toContain("Denied");
  });

  it("shows the reason exactly once, and only when something was denied", async () => {
    const { sender, send } = fakeSender();
    await sendDecisionEmail(
      { ...base, approved: [], denied: ["ADMINISTER"], denialReason: "Senior technicians only." },
      { sender },
    );
    const text = send.mock.calls[0][0].text as string;
    expect(text.match(/Senior technicians only\./g)).toHaveLength(1);
  });

  it("omits the reason entirely when everything was approved", async () => {
    const { sender, send } = fakeSender();
    await sendDecisionEmail(
      { ...base, approved: ["MANAGE_QUEUE"], denied: [], denialReason: null },
      { sender },
    );
    const msg = send.mock.calls[0][0];
    expect(msg.text).not.toMatch(/Reason given/);
    expect(msg.html).not.toMatch(/Reason given/);
  });

  it("says outright that nothing was granted when everything was denied", async () => {
    const { sender, send } = fakeSender();
    await sendDecisionEmail(
      { ...base, approved: [], denied: ["ADMINISTER"], denialReason: "No." },
      { sender },
    );
    expect(send.mock.calls[0][0].text).toMatch(/was not granted/);
  });

  it("escapes the name and the reason in the HTML part", async () => {
    const { sender, send } = fakeSender();
    await sendDecisionEmail(
      {
        ...base,
        name: "<script>alert(1)</script>",
        approved: [],
        denied: ["ADMINISTER"],
        denialReason: "<img onerror=x>",
      },
      { sender },
    );
    const html = send.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
  });

  it("propagates a send failure so the caller decides", async () => {
    const send = vi.fn().mockRejectedValue(new Error("smtp down"));
    await expect(
      sendDecisionEmail({ ...base, approved: [], denied: ["ADMINISTER"], denialReason: "n" }, { sender: { send } }),
    ).rejects.toThrow("smtp down");
  });
});
