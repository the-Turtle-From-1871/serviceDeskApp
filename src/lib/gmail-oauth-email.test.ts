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

  it("uses CRLF line endings, never bare LF", () => {
    const mime = decode(buildRawEmail({ ...base, html: "<p>hi</p>" }, FROM, BOUNDARIES));
    const headerBlock = mime.split("\r\n\r\n")[0];
    expect(headerBlock).not.toMatch(/[^\r]\n/);
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
