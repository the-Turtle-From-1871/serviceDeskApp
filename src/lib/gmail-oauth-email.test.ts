import { describe, it, expect } from "vitest";
import { buildRawEmail } from "./gmail-oauth-email";

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
