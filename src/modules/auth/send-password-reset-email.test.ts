import { describe, it, expect, vi } from "vitest";
import { sendPasswordResetEmail } from "./send-password-reset-email";
import type { EmailMessage } from "@/lib/email";

describe("sendPasswordResetEmail", () => {
  it("emails the reset link with a clear subject and expiry note", async () => {
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendPasswordResetEmail(
      { to: "jane@u.mil", name: "Jane", resetUrl: "https://x/reset-password?token=abc" },
      { sender: { send } },
    );
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("jane@u.mil");
    expect(msg.subject).toBe("Reset your DCSIM Service Desk password");
    expect(msg.text).toContain("https://x/reset-password?token=abc");
    expect(msg.text).toContain("1 hour");
    // Multipart: an HTML body with the link, for better inbox placement.
    expect(msg.html).toContain("https://x/reset-password?token=abc");
    expect(msg.html).toContain("Reset your password");
  });

  it("propagates a send failure so the caller can handle it", async () => {
    const send = vi.fn(async () => { throw new Error("boom"); });
    await expect(
      sendPasswordResetEmail({ to: "a@x", name: "A", resetUrl: "u" }, { sender: { send } }),
    ).rejects.toThrow("boom");
  });
});
