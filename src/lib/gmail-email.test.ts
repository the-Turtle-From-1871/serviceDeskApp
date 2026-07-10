import { describe, it, expect, vi } from "vitest";
import { buildRawEmail, GmailEmailSender } from "./gmail-email";

function decode(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

const from = "DCSIM Service Desk <dcsimservicedesk@gmail.com>";

describe("buildRawEmail", () => {
  it("emits base64url (no +, /, or padding)", () => {
    const raw = buildRawEmail({ to: "jane@u.mil", subject: "Hi", text: "Body" }, from);
    expect(raw).not.toMatch(/[+/=]/);
  });

  it("builds a plain-text message with the right headers and body", () => {
    const mime = decode(buildRawEmail({ to: "jane@u.mil", subject: "Hello there", text: "Line 1\nLine 2" }, from));
    expect(mime).toContain("From: DCSIM Service Desk <dcsimservicedesk@gmail.com>");
    expect(mime).toContain("To: jane@u.mil");
    expect(mime).toContain("Subject: Hello there");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("Line 1");
    expect(mime).toContain("Line 2");
  });

  it("adds a Cc header (string and array forms)", () => {
    expect(decode(buildRawEmail({ to: "a@x", subject: "S", text: "b", cc: "desk@g6.mil" }, from))).toContain("Cc: desk@g6.mil");
    expect(decode(buildRawEmail({ to: "a@x", subject: "S", text: "b", cc: ["one@x", "two@x"] }, from))).toContain("Cc: one@x, two@x");
  });

  it("builds multipart/mixed with a base64 PDF attachment", () => {
    const pdf = new Uint8Array([37, 80, 68, 70]); // %PDF
    const mime = decode(
      buildRawEmail(
        { to: "a@x", subject: "S", text: "body", attachments: [{ filename: "hand-receipt.pdf", content: pdf }] },
        from,
        "BOUND",
      ),
    );
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="BOUND"');
    expect(mime).toContain("--BOUND");
    expect(mime).toContain('Content-Type: application/pdf; name="hand-receipt.pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="hand-receipt.pdf"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain(Buffer.from(pdf).toString("base64")); // JVBERg==
    expect(mime.trimEnd()).toMatch(/--BOUND--$/);
  });
});

describe("GmailEmailSender.send", () => {
  const cfg = { from, clientId: "c", clientSecret: "s", refreshToken: "r" };

  it("exchanges the refresh token then posts the message to the Gmail API", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return String(url).includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 })
        : new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await new GmailEmailSender(cfg).send({ to: "jane@u.mil", subject: "Hi", text: "Body" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls[0].url).toContain("oauth2.googleapis.com/token");
    expect(calls[1].url).toContain("gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test");
    expect(typeof JSON.parse(calls[1].init.body as string).raw).toBe("string");
  });

  it("throws when the Gmail send fails", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("oauth2")
        ? new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
        : new Response("forbidden", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new GmailEmailSender(cfg).send({ to: "a@x", subject: "S", text: "b" })).rejects.toThrow(/Gmail send failed/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
