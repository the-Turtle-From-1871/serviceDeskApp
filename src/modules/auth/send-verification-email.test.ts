import { describe, it, expect, vi } from "vitest";
import { sendVerificationEmail } from "./send-verification-email";

function fakeSender() {
  const send = vi.fn().mockResolvedValue(undefined);
  return { sender: { send }, send };
}

const URL_ = "https://www.dcsim.us/verify-email?token=abc123";

describe("sendVerificationEmail", () => {
  it("sends a multipart message carrying the verification link in both parts", async () => {
    const { sender, send } = fakeSender();
    await sendVerificationEmail({ to: "a@b.mil", name: "Jane", verifyUrl: URL_ }, { sender });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("a@b.mil");
    expect(msg.subject).toMatch(/confirm/i);
    expect(msg.text).toContain(URL_);
    expect(msg.html).toContain("verify-email?token=abc123");
  });

  it("says the account cannot be used until confirmed, so an unexpected mail is not alarming", async () => {
    const { sender, send } = fakeSender();
    await sendVerificationEmail({ to: "a@b.mil", name: "Jane", verifyUrl: URL_ }, { sender });
    expect(send.mock.calls[0][0].text).toMatch(/didn't create this account/i);
  });

  // A crafted display name must not be able to inject markup into the HTML part.
  it("escapes the recipient name in the HTML body", async () => {
    const { sender, send } = fakeSender();
    await sendVerificationEmail(
      { to: "a@b.mil", name: "<script>alert(1)</script>", verifyUrl: URL_ },
      { sender },
    );
    const html = send.mock.calls[0][0].html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("greets without a name when none is given", async () => {
    const { sender, send } = fakeSender();
    await sendVerificationEmail({ to: "a@b.mil", name: "", verifyUrl: URL_ }, { sender });
    expect(send.mock.calls[0][0].text.startsWith("Hello,")).toBe(true);
  });

  it("propagates a send failure so the caller decides", async () => {
    const send = vi.fn().mockRejectedValue(new Error("smtp down"));
    await expect(
      sendVerificationEmail({ to: "a@b.mil", name: "J", verifyUrl: URL_ }, { sender: { send } }),
    ).rejects.toThrow("smtp down");
  });
});
