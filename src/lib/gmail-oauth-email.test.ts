import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildRawEmail, getAccessToken, __resetTokenCache, type GmailOAuthConfig } from "./gmail-oauth-email";

// The Gmail API takes the message base64url-encoded; decode to assert on the wire format.
function decode(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

const FROM = "DCSIM Service Desk <desk@gmail.com>";
const BOUNDARIES = { mixed: "MIXBOUND", alt: "ALTBOUND" };
const base = { to: "user@example.com", subject: "NEW: HR-000123", text: "line one" };

describe("buildRawEmail body structure", () => {
  it("emits base64url with no padding and no + or /", () => {
    const raw = buildRawEmail({ ...base }, FROM, BOUNDARIES);
    expect(raw).not.toMatch(/[+/=]/);
  });

  it("uses text/plain when there is no html and no attachment", () => {
    const mime = decode(buildRawEmail({ ...base }, FROM, BOUNDARIES));
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).not.toContain("multipart");
    expect(mime).toContain("line one");
  });

  it("emits the required headers", () => {
    const mime = decode(buildRawEmail({ ...base, cc: ["a@x.com", "b@x.com"] }, FROM, BOUNDARIES));
    expect(mime).toContain(`From: ${FROM}`);
    expect(mime).toContain("To: user@example.com");
    expect(mime).toContain("Cc: a@x.com, b@x.com");
    expect(mime).toContain("Subject: NEW: HR-000123");
    expect(mime).toContain("MIME-Version: 1.0");
  });

  it("uses multipart/alternative for text + html", () => {
    const mime = decode(buildRawEmail({ ...base, html: "<p>hi</p>" }, FROM, BOUNDARIES));
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="ALTBOUND"');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toContain("<p>hi</p>");
    expect(mime.trimEnd().endsWith("--ALTBOUND--")).toBe(true);
  });

  it("puts text before html so clients prefer the html part", () => {
    const mime = decode(buildRawEmail({ ...base, html: "<p>hi</p>" }, FROM, BOUNDARIES));
    expect(mime.indexOf("text/plain")).toBeLessThan(mime.indexOf("text/html"));
  });

  it("uses multipart/mixed for text + attachment", () => {
    const mime = decode(
      buildRawEmail({ ...base, attachments: [{ filename: "hr.pdf", content: new Uint8Array([1, 2, 3]) }] }, FROM, BOUNDARIES),
    );
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="MIXBOUND"');
    expect(mime).toContain('Content-Disposition: attachment; filename="hr.pdf"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).not.toContain("multipart/alternative");
    expect(mime.trimEnd().endsWith("--MIXBOUND--")).toBe(true);
  });

  it("nests alternative inside mixed for text + html + attachment", () => {
    const mime = decode(
      buildRawEmail(
        { ...base, html: "<p>hi</p>", attachments: [{ filename: "hr.pdf", content: new Uint8Array([1]) }] },
        FROM,
        BOUNDARIES,
      ),
    );
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="MIXBOUND"');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="ALTBOUND"');
    // The alternative block closes before the attachment part opens.
    expect(mime.indexOf("--ALTBOUND--")).toBeLessThan(mime.indexOf('filename="hr.pdf"'));
  });

  it("wraps base64 attachment payloads at 76 columns", () => {
    const big = new Uint8Array(500).fill(65);
    const mime = decode(buildRawEmail({ ...base, attachments: [{ filename: "b.pdf", content: big }] }, FROM, BOUNDARIES));
    const payload = mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split("\r\n--")[0];
    for (const line of payload.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("uses CRLF line endings, never bare LF — including inside multi-line text and html bodies", () => {
    const mime = decode(
      buildRawEmail({ ...base, text: "line one\nline two", html: "<p>hi</p>\n<p>bye</p>" }, FROM, BOUNDARIES),
    );
    expect(mime).not.toMatch(/[^\r]\n/);
    expect(mime).toContain("line one\r\nline two");
    expect(mime).toContain("<p>hi</p>\r\n<p>bye</p>");
  });

  it("does not double an already-CRLF newline in text/html bodies", () => {
    const mime = decode(
      buildRawEmail({ ...base, text: "line one\r\nline two", html: "<p>hi</p>\r\n<p>bye</p>" }, FROM, BOUNDARIES),
    );
    expect(mime).not.toMatch(/[^\r]\n/);
    expect(mime).not.toMatch(/\r\r\n/);
    expect(mime).toContain("line one\r\nline two");
    expect(mime).toContain("<p>hi</p>\r\n<p>bye</p>");
  });

  it("declares 8bit transfer encoding on the text and html parts and survives a non-ASCII body round-trip", () => {
    const mime = decode(
      buildRawEmail({ ...base, text: "Réparation requise", html: "<p>Réparation requise</p>" }, FROM, BOUNDARIES),
    );
    const textSection = mime.split('Content-Type: text/plain; charset="UTF-8"')[1];
    expect(textSection.startsWith("\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")).toBe(true);
    const htmlSection = mime.split('Content-Type: text/html; charset="UTF-8"')[1];
    expect(htmlSection.startsWith("\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")).toBe(true);
    expect(mime).toContain("Réparation requise");
    expect(mime).toContain("<p>Réparation requise</p>");
  });

  it("generates distinct boundaries when none are supplied", () => {
    const a = decode(buildRawEmail({ ...base, html: "<p>x</p>", attachments: [{ filename: "f.pdf", content: new Uint8Array([1]) }] }, FROM));
    const mixed = a.match(/multipart\/mixed; boundary="([^"]+)"/)?.[1];
    const alt = a.match(/multipart\/alternative; boundary="([^"]+)"/)?.[1];
    expect(mixed).toBeTruthy();
    expect(alt).toBeTruthy();
    expect(mixed).not.toBe(alt);
  });
});

describe("buildRawEmail header safety", () => {
  // Injection means a NEW header line, so assert on the line break rather than
  // on the substring — the sanitized value legitimately still contains the
  // text "Bcc:", just folded harmlessly into the header it came from.
  const FORGED_HEADER = /\r\nBcc:/;

  it("strips CRLF from the subject so headers cannot be forged", () => {
    const mime = decode(
      buildRawEmail({ ...base, subject: "ok\r\nBcc: attacker@evil.com" }, FROM, BOUNDARIES),
    );
    expect(mime).not.toMatch(FORGED_HEADER);
    expect(mime).toContain("Subject: ok Bcc: attacker@evil.com");
  });

  it("strips CRLF from the to address", () => {
    const mime = decode(buildRawEmail({ ...base, to: "a@x.com\r\nBcc: attacker@evil.com" }, FROM, BOUNDARIES));
    expect(mime).not.toMatch(FORGED_HEADER);
    expect(mime).toContain("To: a@x.com Bcc: attacker@evil.com");
  });

  it("strips CRLF from cc entries", () => {
    const mime = decode(buildRawEmail({ ...base, cc: ["a@x.com\r\nBcc: evil@x.com"] }, FROM, BOUNDARIES));
    expect(mime).not.toMatch(FORGED_HEADER);
  });

  it("strips CRLF from the from address", () => {
    const mime = decode(buildRawEmail({ ...base }, "Desk <d@x.com>\r\nBcc: evil@x.com", BOUNDARIES));
    expect(mime).not.toMatch(FORGED_HEADER);
  });

  it("strips CRLF and quotes from an attachment filename", () => {
    const mime = decode(
      buildRawEmail(
        { ...base, attachments: [{ filename: 'a.pdf"\r\nBcc: evil@x.com', content: new Uint8Array([1]) }] },
        FROM,
        BOUNDARIES,
      ),
    );
    expect(mime).not.toMatch(FORGED_HEADER);
    // The quote is stripped too, or it would close the filename="..." parameter early.
    expect(mime).toContain('filename="a.pdf Bcc: evil@x.com"');
  });

  it("RFC 2047 encodes a non-ASCII subject", () => {
    const mime = decode(buildRawEmail({ ...base, subject: "Réparation requise" }, FROM, BOUNDARIES));
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Réparation requise", "utf8").toString("base64")}?=`);
  });

  it("leaves a pure-ASCII subject unencoded", () => {
    const mime = decode(buildRawEmail({ ...base, subject: "NEW: HR-000123" }, FROM, BOUNDARIES));
    expect(mime).toContain("Subject: NEW: HR-000123");
    expect(mime).not.toContain("=?UTF-8?B?");
  });

  it("derives the attachment content type from the extension", () => {
    const mime = decode(
      buildRawEmail({ ...base, attachments: [{ filename: "report.csv", content: new Uint8Array([1]) }] }, FROM, BOUNDARIES),
    );
    expect(mime).toContain('Content-Type: text/csv; name="report.csv"');
  });

  it("falls back to application/octet-stream for an unknown extension", () => {
    const mime = decode(
      buildRawEmail({ ...base, attachments: [{ filename: "thing.xyz", content: new Uint8Array([1]) }] }, FROM, BOUNDARIES),
    );
    expect(mime).toContain('Content-Type: application/octet-stream; name="thing.xyz"');
  });

  it("still labels a pdf as application/pdf", () => {
    const mime = decode(
      buildRawEmail({ ...base, attachments: [{ filename: "hand-receipt.PDF", content: new Uint8Array([1]) }] }, FROM, BOUNDARIES),
    );
    expect(mime).toContain("Content-Type: application/pdf");
  });
});

const CFG: GmailOAuthConfig = {
  from: FROM,
  clientId: "cid",
  clientSecret: "secret",
  refreshToken: "rtok",
};

function okToken(token: string, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 });
}

describe("getAccessToken", () => {
  beforeEach(() => {
    __resetTokenCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exchanges the refresh token and returns the access token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okToken("at-1"));
    await expect(getAccessToken(CFG)).resolves.toBe("at-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init!.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("refresh_token")).toBe("rtok");
  });

  it("reuses the cached token inside its lifetime", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okToken("at-1"));
    await getAccessToken(CFG);
    await getAccessToken(CFG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exchanges only once for concurrent callers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okToken("at-1"));
    const all = await Promise.all([getAccessToken(CFG), getAccessToken(CFG), getAccessToken(CFG)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(all).toEqual(["at-1", "at-1", "at-1"]);
  });

  it("re-exchanges after the token expires", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okToken("at-1", 3600))
      .mockResolvedValueOnce(okToken("at-2", 3600));
    await expect(getAccessToken(CFG)).resolves.toBe("at-1");
    vi.setSystemTime(new Date("2026-07-31T13:00:00Z")); // past the 3600s lifetime
    await expect(getAccessToken(CFG)).resolves.toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes early, inside the 60s safety margin", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okToken("at-1", 3600))
      .mockResolvedValueOnce(okToken("at-2", 3600));
    await getAccessToken(CFG);
    vi.setSystemTime(new Date("2026-07-31T12:59:30Z")); // 30s short of expiry
    await expect(getAccessToken(CFG)).resolves.toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names invalid_grant and the remedy so logs are actionable", async () => {
    // A fresh Response per call: a Response body can only be read once, and
    // this test calls getAccessToken three times against the same mock — a
    // single shared Response instance (mockResolvedValue with one object)
    // throws "Body is unusable" on the second read.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    await expect(getAccessToken(CFG)).rejects.toThrow(/invalid_grant/);
    await expect(getAccessToken(CFG)).rejects.toThrow(/GMAIL_REFRESH_TOKEN/);
    // The 7-day expiry is expected, not a misconfiguration — the message must
    // say so, or every rotation reads as an incident.
    await expect(getAccessToken(CFG)).rejects.toThrow(/7 days/);
  });

  it("surfaces other token errors with status and body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream boom", { status: 503 }));
    await expect(getAccessToken(CFG)).rejects.toThrow(/503 upstream boom/);
  });

  it("does not cache a failed exchange", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(okToken("at-1"));
    await expect(getAccessToken(CFG)).rejects.toThrow();
    await expect(getAccessToken(CFG)).resolves.toBe("at-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-exchanges when the refresh token itself changes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okToken("at-1"))
      .mockResolvedValueOnce(okToken("at-2"));
    await expect(getAccessToken(CFG)).resolves.toBe("at-1");
    await expect(getAccessToken({ ...CFG, refreshToken: "rotated" })).resolves.toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

import { GmailOAuthSender, gmailOAuthConfigFromEnv } from "./gmail-oauth-email";

describe("GmailOAuthSender", () => {
  beforeEach(() => {
    __resetTokenCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts the encoded message to the Gmail send endpoint with a bearer token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okToken("at-1"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await new GmailOAuthSender(CFG).send({ to: "u@example.com", subject: "NEW: HR-1", text: "body" });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
    const sent = JSON.parse(init!.body as string) as { raw: string };
    expect(decode(sent.raw)).toContain("Subject: NEW: HR-1");
    expect(decode(sent.raw)).toContain(`From: ${FROM}`);
  });

  it("exchanges the token only once across several sends", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("oauth2") ? okToken("at-1") : new Response("{}", { status: 200 }),
    );
    const sender = new GmailOAuthSender(CFG);
    await Promise.all([
      sender.send({ to: "a@x.com", subject: "s", text: "t" }),
      sender.send({ to: "b@x.com", subject: "s", text: "t" }),
      sender.send({ to: "c@x.com", subject: "s", text: "t" }),
    ]);
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("throws with status and body when the send is refused", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okToken("at-1"))
      .mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }));
    await expect(
      new GmailOAuthSender(CFG).send({ to: "u@x.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/Gmail send failed: 429 quota exceeded/);
  });

  it("does not attempt the send when the token exchange fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(
      new GmailOAuthSender(CFG).send({ to: "u@x.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/invalid_grant/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("gmailOAuthConfigFromEnv", () => {
  const orig = { ...process.env };
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...orig };
    errorSpy.mockRestore();
  });

  it("returns null and logs nothing when none of the four vars are present", () => {
    delete process.env.GMAIL_FROM;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(gmailOAuthConfigFromEnv()).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns null but logs an error naming the missing var when three of four are present", () => {
    process.env.GMAIL_FROM = FROM;
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(gmailOAuthConfigFromEnv()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("GMAIL_REFRESH_TOKEN");
  });

  it("returns null and logs an error naming every missing var when only one of four is present", () => {
    process.env.GMAIL_FROM = FROM;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(gmailOAuthConfigFromEnv()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0][0] as string;
    expect(message).toContain("GMAIL_CLIENT_ID");
    expect(message).toContain("GMAIL_CLIENT_SECRET");
    expect(message).toContain("GMAIL_REFRESH_TOKEN");
  });

  it("returns the config and logs nothing when all four are present", () => {
    process.env.GMAIL_FROM = FROM;
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    process.env.GMAIL_REFRESH_TOKEN = "rtok";
    expect(gmailOAuthConfigFromEnv()).toEqual({
      from: FROM,
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "rtok",
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
