# Gmail OAuth Sender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send all outbound mail through Gmail API v1 (`users.messages.send`) authenticated with an OAuth2 refresh token, replacing the SMTP app-password transport entirely.

**Architecture:** One new leaf module, `src/lib/gmail-oauth-email.ts`, exports a `GmailOAuthSender` implementing the existing `EmailSender` interface. It hand-builds an RFC 2822 message, base64url-encodes it into the API's `raw` field, and authenticates with a module-cached access token exchanged from a refresh token. `getEmailSender()` selects it by env presence. The existing `GmailEmailSender` (nodemailer + app password) is deleted. No caller changes.

**Tech Stack:** TypeScript 5, Next.js 16, Vitest. `fetch` + `node:crypto` only — no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-gmail-oauth-sender-design.md`

## Global Constraints

- **No new npm dependencies.** The Gmail REST endpoint takes a base64url string; `googleapis` buys nothing and CLAUDE.md §3 gates new packages.
- **Do not change any caller.** `send-receipt-email.ts`, `send-return-email.ts`, `send-pickup-email.ts`, `send-password-reset-email.ts`, and both `timer-alert.service.ts` files must be untouched. They resolve transport via `getEmailSender()`.
- **Do not change the `EmailMessage` or `EmailSender` types** in `src/lib/email.ts`.
- **Scope is exactly `https://www.googleapis.com/auth/gmail.send`.** Never `https://mail.google.com/` — that is a *restricted* scope requiring an annual CASA security assessment.
- **No fallback transport on send failure.** Selection is by env presence only. A dead refresh token must throw.
- **Run tests by file, never the whole suite.** `npx vitest run <file>`. A bare `npm test` runs DB-backed integration tests that truncate a shared test database — if another agent or session is running tests, you corrupt each other's runs.
- **CRLF (`\r\n`) line endings throughout the MIME message**, never `\n`.
- `src/lib/email.ts` is on the `WATCHED` list in `scripts/check-security-docs.mjs`. **Any commit touching it must also touch `docs/SECURITY.md`** or the `Security docs current` CI check fails the PR.
- Branch is `feat/gmail-oauth-sender`, already created off `main`. Never commit to `main`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/gmail-oauth-email.ts` | **Create.** MIME builder, token cache, `GmailOAuthSender`, env config reader. |
| `src/lib/gmail-oauth-email.test.ts` | **Create.** Unit tests, `fetch` stubbed. |
| `src/lib/email.ts` | **Modify.** Delete `GmailEmailSender`; add OAuth branch to `getEmailSender()`. |
| `src/lib/email.test.ts` | **Modify.** Replace app-password precedence cases with OAuth ones. |
| `.env.example` | **Modify.** Add four `GMAIL_*` OAuth vars; remove the two app-password vars. |
| `docs/SECURITY.md` | **Modify.** New credential + header-injection control; remove app-password entry. |
| `scripts/check-security-docs.mjs` | **Modify.** Add the new module to `WATCHED`. |
| `CHANGELOG.md` | **Modify.** Entry under `## 2026-07-31`. |

Task order matters: Tasks 1–2 build the message, Task 3 builds auth, Task 4 joins them, Task 5 swaps the transport, Task 6 documents it.

---

### Task 1: MIME builder — body structure

Builds `buildRawEmail` covering all four body shapes. The reverted `16cb793` dropped `msg.html` entirely; `send-password-reset-email.ts` sets it, so that regression is fixed here.

**Files:**
- Create: `src/lib/gmail-oauth-email.ts`
- Test: `src/lib/gmail-oauth-email.test.ts`

**Interfaces:**
- Consumes: `EmailMessage` from `src/lib/email.ts` (fields: `to`, `subject`, `text`, `html?`, `cc?`, `attachments?: { filename: string; content: Uint8Array }[]`).
- Produces: `buildRawEmail(msg: EmailMessage, from: string, boundaries?: { mixed?: string; alt?: string }): string` — base64url, no padding. Boundaries are injectable so tests are deterministic.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/gmail-oauth-email.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts`
Expected: FAIL — `Failed to resolve import "./gmail-oauth-email"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/gmail-oauth-email.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailSender } from "./email";

const CRLF = "\r\n";

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Wrap base64 payloads at 76 columns per RFC 2045.
function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, `$1${CRLF}`);
}

function textPart(text: string): string {
  return `Content-Type: text/plain; charset="UTF-8"${CRLF}${CRLF}${text}`;
}

function htmlPart(html: string): string {
  return `Content-Type: text/html; charset="UTF-8"${CRLF}${CRLF}${html}`;
}

function attachmentPart(a: { filename: string; content: Uint8Array }): string {
  return (
    `Content-Type: application/pdf; name="${a.filename}"${CRLF}` +
    `Content-Disposition: attachment; filename="${a.filename}"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrap76(Buffer.from(a.content).toString("base64"))
  );
}

// Join parts into a multipart body. Each part is preceded by its boundary
// delimiter; the block closes with the boundary plus a trailing "--".
function multipart(boundary: string, parts: string[]): string {
  return parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--`;
}

/** Build an RFC 2822 message and return it base64url-encoded for the Gmail
 *  API `raw` field. Boundaries are injectable so tests are deterministic. */
export function buildRawEmail(
  msg: EmailMessage,
  from: string,
  boundaries: { mixed?: string; alt?: string } = {},
): string {
  const mixed = boundaries.mixed ?? `mix_${randomUUID()}`;
  const alt = boundaries.alt ?? `alt_${randomUUID()}`;

  const headers = [`From: ${from}`, `To: ${msg.to}`];
  if (msg.cc) headers.push(`Cc: ${Array.isArray(msg.cc) ? msg.cc.join(", ") : msg.cc}`);
  headers.push(`Subject: ${msg.subject}`, "MIME-Version: 1.0");

  // A complete body part, headers included — so it can serve either as the
  // top-level body or as the first part inside multipart/mixed.
  const bodyPart = msg.html
    ? `Content-Type: multipart/alternative; boundary="${alt}"${CRLF}${CRLF}` +
      multipart(alt, [textPart(msg.text), htmlPart(msg.html)])
    : textPart(msg.text);

  const attachments = msg.attachments ?? [];
  const mime =
    attachments.length === 0
      ? `${headers.join(CRLF)}${CRLF}${bodyPart}`
      : `${headers.join(CRLF)}${CRLF}Content-Type: multipart/mixed; boundary="${mixed}"${CRLF}${CRLF}` +
        multipart(mixed, [bodyPart, ...attachments.map(attachmentPart)]);

  return toBase64Url(Buffer.from(mime, "utf8"));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail-oauth-email.ts src/lib/gmail-oauth-email.test.ts
git commit -m "feat(email): build RFC 2822 messages for the Gmail API

Covers all four body shapes including text+html, which the earlier
reverted implementation dropped entirely."
```

---

### Task 2: MIME builder — header safety

Three defects inherited from `16cb793`. Each is independently rejectable, so this is its own review gate.

**Files:**
- Modify: `src/lib/gmail-oauth-email.ts`
- Test: `src/lib/gmail-oauth-email.test.ts`

**Interfaces:**
- Consumes: `buildRawEmail` from Task 1.
- Produces: no new exports. `buildRawEmail`'s signature is unchanged; only its output for hostile or non-ASCII input changes.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/gmail-oauth-email.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts -t "header safety"`
Expected: FAIL — CRLF passes through, subject is not encoded, csv is labelled `application/pdf`.

- [ ] **Step 3: Write the implementation**

In `src/lib/gmail-oauth-email.ts`, add these helpers below `wrap76`:

```ts
// A header value may never contain CR or LF: either would terminate the header
// and let caller-supplied text forge new ones (an injected Bcc, a replaced
// body). Collapse both to a space rather than dropping the value, so the
// message still sends with visibly mangled — not silently altered — content.
function headerValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

// Non-ASCII is invalid raw in a header. Device, unit and person names can carry
// it, so encode per RFC 2047 and leave pure-ASCII subjects byte-identical.
function encodeSubject(s: string): string {
  const clean = headerValue(s);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function contentTypeFor(filename: string): string {
  switch (filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) {
    case "pdf": return "application/pdf";
    case "csv": return "text/csv";
    case "txt": return "text/plain";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}
```

Replace `attachmentPart` with:

```ts
function attachmentPart(a: { filename: string; content: Uint8Array }): string {
  const name = headerValue(a.filename).replace(/"/g, "");
  return (
    `Content-Type: ${contentTypeFor(name)}; name="${name}"${CRLF}` +
    `Content-Disposition: attachment; filename="${name}"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrap76(Buffer.from(a.content).toString("base64"))
  );
}
```

In `buildRawEmail`, replace the header-assembly block with:

```ts
  const headers = [`From: ${headerValue(from)}`, `To: ${headerValue(msg.to)}`];
  if (msg.cc) {
    const cc = Array.isArray(msg.cc) ? msg.cc.map(headerValue).join(", ") : headerValue(msg.cc);
    headers.push(`Cc: ${cc}`);
  }
  headers.push(`Subject: ${encodeSubject(msg.subject)}`, "MIME-Version: 1.0");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts`
Expected: PASS — 20 tests (Task 1's 10 still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail-oauth-email.ts src/lib/gmail-oauth-email.test.ts
git commit -m "feat(email): guard MIME headers against CRLF injection

Strips CR/LF from every header value, RFC 2047-encodes non-ASCII
subjects, and derives attachment content types from the filename."
```

---

### Task 3: Access token exchange and cache

The reverted implementation exchanged the refresh token on **every** send; `sendReceiptEmails` fans out to three recipients concurrently, so one receipt cost three round-trips.

**Files:**
- Modify: `src/lib/gmail-oauth-email.ts`
- Test: `src/lib/gmail-oauth-email.test.ts`

**Interfaces:**
- Produces:
  - `export type GmailOAuthConfig = { from: string; clientId: string; clientSecret: string; refreshToken: string }`
  - `export async function getAccessToken(cfg: GmailOAuthConfig): Promise<string>`
  - `export function __resetTokenCache(): void` — test seam only.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/gmail-oauth-email.test.ts`:

```ts
import { beforeEach, afterEach, vi } from "vitest";
import { getAccessToken, __resetTokenCache, type GmailOAuthConfig } from "./gmail-oauth-email";

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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts -t "getAccessToken"`
Expected: FAIL — `getAccessToken` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/gmail-oauth-email.ts`:

```ts
export type GmailOAuthConfig = {
  from: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

// Refresh a minute early so a token cannot expire in flight between the check
// and Gmail receiving the request.
const SAFETY_MARGIN_MS = 60_000;

// Module scope, not instance state: getEmailSender() constructs a fresh sender
// per send, so an instance-level cache would never be reused. Keyed by the
// credentials it was minted from, so a rotated refresh token invalidates it.
let cache: { key: string; token: string; expiresAt: number } | null = null;
let inFlight: { key: string; promise: Promise<string> } | null = null;

/** Test seam: clears cached state between cases. */
export function __resetTokenCache(): void {
  cache = null;
  inFlight = null;
}

async function exchange(cfg: GmailOAuthConfig, key: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    // Every way a refresh token dies — the 7-day Testing-status expiry,
    // revocation, an account password change, 6 months idle, or exceeding 100
    // live tokens per client — arrives as this one opaque 400. Name the remedy
    // here or the log line is unactionable.
    if (text.includes("invalid_grant")) {
      throw new Error(
        "Gmail OAuth refresh token rejected (invalid_grant). Re-mint GMAIL_REFRESH_TOKEN and redeploy. " +
          "Roughly weekly is EXPECTED, not a misconfiguration: the consent screen is deliberately left in Testing " +
          "status, and Google expires a Testing-status consent grant every 7 days. Run the token-rotation tooling.",
      );
    }
    throw new Error(`Google token refresh failed: ${res.status} ${text}`);
  }

  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Google token refresh returned no access_token");

  const ttlMs = (json.expires_in ?? 3600) * 1000;
  cache = { key, token: json.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - SAFETY_MARGIN_MS) };
  return json.access_token;
}

/** Returns a valid access token, exchanging the refresh token only when the
 *  cached one is missing, stale, or minted from different credentials.
 *  Concurrent callers share a single in-flight exchange. */
export async function getAccessToken(cfg: GmailOAuthConfig): Promise<string> {
  const key = `${cfg.clientId}:${cfg.refreshToken}`;
  if (cache && cache.key === key && cache.expiresAt > Date.now()) return cache.token;
  if (inFlight && inFlight.key === key) return inFlight.promise;

  // A rejection clears inFlight but leaves the cache untouched, so the next
  // send retries rather than inheriting a poisoned entry.
  const promise = exchange(cfg, key).finally(() => {
    if (inFlight?.key === key) inFlight = null;
  });
  inFlight = { key, promise };
  return promise;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts`
Expected: PASS — 29 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail-oauth-email.ts src/lib/gmail-oauth-email.test.ts
git commit -m "feat(email): cache the Gmail OAuth access token

One exchange per token lifetime instead of one per send, with a shared
in-flight promise so concurrent recipients do not race, and a named
error for invalid_grant."
```

---

### Task 4: The sender

**Files:**
- Modify: `src/lib/gmail-oauth-email.ts`
- Test: `src/lib/gmail-oauth-email.test.ts`

**Interfaces:**
- Consumes: `buildRawEmail` (Task 1–2), `getAccessToken` (Task 3).
- Produces:
  - `export class GmailOAuthSender implements EmailSender` — constructor takes `GmailOAuthConfig`; `send(msg: EmailMessage): Promise<void>`.
  - `export function gmailOAuthConfigFromEnv(): GmailOAuthConfig | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/gmail-oauth-email.test.ts`:

```ts
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
  afterEach(() => {
    process.env = { ...orig };
  });

  it("returns null when any var is missing", () => {
    process.env.GMAIL_FROM = FROM;
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(gmailOAuthConfigFromEnv()).toBeNull();
  });

  it("returns the config when all four are present", () => {
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
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts -t "GmailOAuthSender"`
Expected: FAIL — `GmailOAuthSender` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/gmail-oauth-email.ts`:

```ts
/** Sends as a Gmail account through the Gmail API. Errors propagate; callers
 *  decide whether a mail failure is fatal (sendReceiptEmails, for one,
 *  deliberately swallows per-recipient failures so a mail outage never rolls
 *  back a completed transfer). There is no fallback transport by design — a
 *  dead refresh token must be visible, not silently routed around. */
export class GmailOAuthSender implements EmailSender {
  constructor(private cfg: GmailOAuthConfig) {}

  async send(msg: EmailMessage): Promise<void> {
    const raw = buildRawEmail(msg, this.cfg.from);
    const token = await getAccessToken(this.cfg);
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  }
}

export function gmailOAuthConfigFromEnv(): GmailOAuthConfig | null {
  const from = process.env.GMAIL_FROM;
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (from && clientId && clientSecret && refreshToken) return { from, clientId, clientSecret, refreshToken };
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/gmail-oauth-email.test.ts`
Expected: PASS — 35 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail-oauth-email.ts src/lib/gmail-oauth-email.test.ts
git commit -m "feat(email): add the Gmail API OAuth sender"
```

---

### Task 5: Swap the transport

Wires the new sender into `getEmailSender()` and deletes the app-password path.

**Files:**
- Modify: `src/lib/email.ts:47-87`
- Modify: `src/lib/email.test.ts`
- Modify: `docs/SECURITY.md` (required — `email.ts` is a `WATCHED` file, see Global Constraints)

**Interfaces:**
- Consumes: `GmailOAuthSender`, `gmailOAuthConfigFromEnv` (Task 4).
- Produces: `getEmailSender()` returning `GmailOAuthSender | ResendEmailSender | LogEmailSender`.

- [ ] **Step 1: Check whether the new module can be marked server-only**

Run: `npx grep -rn "from \"@/lib/email\"" src/ || grep -rn 'from "@/lib/email"' src/`

Every importer must be a server module (a Server Action, service, or route handler). `escapeHtml` lives in `email.ts`, so a Client Component importing it would break under `server-only`. If and only if all importers are server-side, add `import "server-only";` as the first line of `src/lib/gmail-oauth-email.ts` (CLAUDE.md §4). If any importer is a Client Component, skip it and note why in the commit message.

- [ ] **Step 2: Write the failing tests**

Replace the body of `describe("getEmailSender", ...)` in `src/lib/email.test.ts` with:

```ts
describe("getEmailSender", () => {
  function clearAll() {
    for (const k of [
      "RESEND_API_KEY", "EMAIL_FROM",
      "GMAIL_FROM", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN",
      "GMAIL_USER", "GMAIL_APP_PASSWORD",
    ]) delete process.env[k];
  }
  function setOAuth() {
    process.env.GMAIL_FROM = "DCSIM Service Desk <dcsimservicedesk@gmail.com>";
    process.env.GMAIL_CLIENT_ID = "cid";
    process.env.GMAIL_CLIENT_SECRET = "secret";
    process.env.GMAIL_REFRESH_TOKEN = "rtok";
  }

  it("returns the logging stub when no email env is present", () => {
    clearAll();
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });

  it("returns the Resend sender when only Resend env is present", () => {
    clearAll();
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("ResendEmailSender");
  });

  it("returns the Gmail OAuth sender when all four OAuth vars are present", () => {
    clearAll();
    setOAuth();
    expect(getEmailSender().constructor.name).toBe("GmailOAuthSender");
  });

  it("prefers Gmail OAuth over Resend when both are configured", () => {
    clearAll();
    setOAuth();
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("GmailOAuthSender");
  });

  it("falls through when the OAuth config is incomplete", () => {
    clearAll();
    setOAuth();
    delete process.env.GMAIL_REFRESH_TOKEN;
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });

  // The app-password transport is gone: these vars must no longer select a
  // sender, or a stale Vercel env would silently keep the old path alive.
  it("ignores the retired app-password vars", () => {
    clearAll();
    process.env.GMAIL_USER = "dcsimservicedesk@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/email.test.ts`
Expected: FAIL — app-password vars still return `GmailEmailSender`; `GmailOAuthSender` never selected.

- [ ] **Step 4: Write the implementation**

In `src/lib/email.ts`: add the import at the top,

```ts
import { GmailOAuthSender, gmailOAuthConfigFromEnv } from "./gmail-oauth-email";
```

delete the entire `class GmailEmailSender { … }` block (lines 47–71), and replace `getEmailSender` with:

```ts
export function getEmailSender(): EmailSender {
  // Gmail via the Gmail API (OAuth2 refresh token, scope gmail.send) is the
  // only Gmail transport: the SMTP app-password path was removed on
  // 2026-07-31. Selection is by env presence ONLY — never fall back to another
  // transport on a send failure, or an expired refresh token silently reroutes
  // mail instead of surfacing. See docs/superpowers/specs/2026-07-31-gmail-oauth-sender-design.md.
  const oauth = gmailOAuthConfigFromEnv();
  if (oauth) return new GmailOAuthSender(oauth);
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (key && from) return new ResendEmailSender(key, from);
  return new LogEmailSender();
}
```

- [ ] **Step 5: Run the tests and the build to verify they pass**

Run: `npx vitest run src/lib/email.test.ts src/lib/gmail-oauth-email.test.ts`
Expected: PASS — 6 + 35 tests.

Run: `npm run lint && npm run build`
Expected: both succeed. The build proves no remaining importer references the deleted class.

- [ ] **Step 6: Update `docs/SECURITY.md`**

Required in this commit — `src/lib/email.ts` is `WATCHED`. Make these edits:

- **§6 Secrets & data leakage:** replace any mention of the Gmail app password with `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` — long-lived credentials held only in Vercel env, never in the repo. Note the refresh token grants send-only access (`gmail.send`), not mailbox read.
- **§5 Injection & output safety:** add the outbound-header control — `src/lib/gmail-oauth-email.ts` strips CR/LF from every MIME header value (`From`, `To`, `Cc`, `Subject`, attachment filename), so caller-supplied text cannot forge headers or inject a `Bcc`.
- **Known gaps & accepted risks:** add that a dead refresh token stops outbound mail with no fallback, deliberately, so the failure is visible; and that the OAuth consent screen is deliberately kept in **Testing** status, so Google expires the consent grant every 7 days and the refresh token must be re-minted on that cadence by a person. Record it as an accepted operational risk with a named mitigation (the rotation tooling), not as a misconfiguration.
- Bump **Last reviewed** on line 6 to `2026-07-31`.

- [ ] **Step 7: Verify the security-docs gate passes**

Run: `npm run check:security-docs`
Expected: PASS. If it fails, `docs/SECURITY.md` was not modified in the commit range — fix before committing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/email.ts src/lib/email.test.ts src/lib/gmail-oauth-email.ts docs/SECURITY.md
git commit -m "feat(email)!: send via the Gmail API, remove the SMTP app-password path

getEmailSender() now selects GmailOAuthSender when the four GMAIL_*
OAuth vars are set. GmailEmailSender and GMAIL_USER/GMAIL_APP_PASSWORD
are removed. Selection is by env presence only — there is no fallback
on send failure, so a dead refresh token surfaces instead of silently
rerouting."
```

---

### Task 6: Configuration and documentation

**Files:**
- Modify: `.env.example`
- Modify: `scripts/check-security-docs.mjs`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the env var names from Task 4's `gmailOAuthConfigFromEnv`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update `.env.example`**

Replace the Gmail block (the `GMAIL_USER` / `GMAIL_APP_PASSWORD` lines and the comment above them) with:

```bash
# Transactional email. Sender is chosen in this order: Gmail API (if all four
# GMAIL_* vars below are set) → Resend (RESEND_API_KEY + EMAIL_FROM) → console stub.
# There is NO fallback if a send fails — see docs/SECURITY.md.
RESEND_API_KEY=
EMAIL_FROM="DCSIM <receipts@turtolabs.com>"
# Gmail API sender — sends AS a Gmail account via Gmail API v1 (users.messages.send).
# Requires a Google Cloud OAuth2 client with the Gmail API enabled and a refresh
# token for the sending account, scope https://www.googleapis.com/auth/gmail.send
#
# IMPORTANT: the consent screen is deliberately kept in "Testing" publishing
# status, so Google expires the consent grant every 7 days. GMAIL_REFRESH_TOKEN
# therefore has to be re-minted about weekly by a person and pushed to Vercel —
# this is a known, accepted operating cost, not a misconfiguration. A dead token
# stops outbound mail (there is no fallback, by design), so treat the rotation as
# a standing chore. See docs/superpowers/specs/2026-07-31-gmail-token-rotation-design.md.
#
# GMAIL_FROM is the From header ("Name <addr>"); the address must be the
# authenticated account or one of its verified "Send mail as" aliases.
GMAIL_FROM="DCSIM Service Desk <dcsimservicedesk@gmail.com>"
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
```

- [ ] **Step 2: Add the new module to the security-docs watch list**

In `scripts/check-security-docs.mjs`, directly below the existing `src/lib/email.ts` entry, add:

```js
  // Holds a long-lived send credential and builds raw MIME headers. The CR/LF
  // strip in buildRawEmail is the only thing stopping caller-supplied text from
  // forging headers, and it is one deleted regex away from being gone.
  [/^src\/lib\/gmail-oauth-email\.ts$/, "outbound mail header injection guard + the OAuth send credential (§5, §6)"],
```

- [ ] **Step 3: Verify the watch-list test still passes**

Run: `npx vitest run scripts/check-security-docs.test.mjs`
Expected: PASS. This test asserts `WATCHED` still covers every security-relevant file.

- [ ] **Step 4: Add the CHANGELOG entry**

Under the existing `## 2026-07-31` heading in `CHANGELOG.md`, add to the **Changed** section:

```markdown
- **Outbound email now sends through the Gmail API instead of SMTP.** Hand receipts, return notices, pickup notices, password resets and overdue alerts are all sent by the same Gmail account as before and look identical to a recipient; what changed is how the app authenticates to Google — an OAuth2 authorization for send-only access, replacing the account app password. This does not change whether any particular recipient's mail server accepts the message.
```

and add a **Security** section (or append to it if one exists):

```markdown
### Security
- **Email headers are now protected against injection.** Text that reaches an email header — a subject line, a recipient address, an attachment filename — has line breaks stripped, so content drawn from item or receipt data cannot add headers of its own, such as a hidden extra recipient.
- **The account app password is no longer used or accepted.** It is replaced by a send-only OAuth authorization, which cannot read the mailbox.
```

and add to the **Notes** section:

```markdown
- Outbound email requires four new environment variables — `GMAIL_FROM`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` — which **must be set in Vercel production before this deploys**. Without them the app falls through to the Resend sender, which does not deliver. `GMAIL_USER` and `GMAIL_APP_PASSWORD` are no longer read and should be deleted after the deploy is confirmed working.
- The Google OAuth consent screen is deliberately kept in "Testing" publishing status, so Google expires the consent grant every 7 days. `GMAIL_REFRESH_TOKEN` must be re-minted and updated in Vercel on roughly that cadence, or outbound email stops. This is an accepted operating cost with its own tooling, not a fault to diagnose.
```

- [ ] **Step 5: Check `CLAUDE.md` for anything this change contradicts**

Run: `grep -n -i "gmail\|app password\|nodemailer\|email" CLAUDE.md AGENTS.md README.md`

CLAUDE.md's rule is that a change must not leave a stale instruction behind. If any hit describes the SMTP app-password transport as current, correct it in this commit. If nothing describes the mail transport, add nothing — this change introduces no new project-wide rule, and the spec plus `.env.example` already carry the operational detail. Record which it was in the commit message.

- [ ] **Step 6: Verify docs and build**

Run: `npm run check:security-docs && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add .env.example scripts/check-security-docs.mjs CHANGELOG.md
# add CLAUDE.md only if Step 5 found something to correct
git commit -m "docs(email): document the Gmail OAuth transport and its env vars"
```

---

## Manual verification (before opening the PR)

Code cannot prove this works; a real send can. Do these in order.

- [ ] **1. Google Cloud console** (project `dcsim-hand-receipt`)
  - Enable the **Gmail API**.
  - Leave publishing status at **Testing** — this is a deliberate decision (2026-07-31), not an oversight. The consequence is that Google expires the consent grant every 7 days, so the refresh token must be re-minted on that cadence; that cost is accepted and handled by separate rotation tooling. Do not "fix" this by switching to In production without asking.
  - Confirm the sending account is listed as a **test user** on the consent screen — a Testing-status app only issues tokens to those.
  - Confirm the client's authorized redirect URI includes `https://developers.google.com/oauthplayground/`.

- [ ] **2. Mint the refresh token**
  - Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) → gear icon → **Use your own OAuth credentials** → paste the client id and secret.
  - Step 1: enter the scope `https://www.googleapis.com/auth/gmail.send` in the "Input your own scopes" box → **Authorize APIs** → sign in as the sending account → accept (an "unverified app" warning here is expected and fine).
  - Step 2: **Exchange authorization code for tokens** → copy the **refresh token**.

- [ ] **3. Local smoke test**
  - Put the four vars in `.env.local`; remove `GMAIL_USER` and `GMAIL_APP_PASSWORD`.
  - `npm run dev`, create a hand receipt with a real recipient address you control, and confirm the message arrives **with the PDF attached and readable**.
  - Trigger a password reset to the same address and confirm the **HTML body renders with a working button** — that path is the one the reverted implementation broke.

- [ ] **4. Capture the headers** — in Gmail, open the received message → ⋮ → **Show original**. Record the `Authentication-Results` line. Per the spec §2 this should show the same `dkim=pass header.d=gmail.com` and `spf=pass` as a hand-sent message; capturing it settles the original question with evidence rather than argument.

- [ ] **5. Set the Vercel production env vars** — `GMAIL_FROM`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Verify with `vercel env ls production`. **This must happen before the PR merges** (spec §10): production still has `RESEND_API_KEY` and `EMAIL_FROM` set, so merging first makes Resend the silent fallback.

- [ ] **6. Open the PR** — `feat/gmail-oauth-sender` → `main`. All three required checks must pass: `Semgrep SAST`, `Build (next build)`, `Security docs current`.

- [ ] **7. After deploy** — send one real receipt from production and confirm arrival. Then delete `GMAIL_USER` and `GMAIL_APP_PASSWORD` from Vercel, delete `~/Downloads/credentials.json`, and rotate the client secret.

---

## Optional follow-up — needs an explicit decision

**Not in the approved spec** (§4 explicitly deferred it). Do not do this without asking.

`src/lib/email.ts` is the only importer of `nodemailer`. Deleting `GmailEmailSender` orphans both `nodemailer` and `@types/nodemailer` in `package.json`. Removing them would also close the tracked `nodemailer` 7→9 advisory (SMTP command + CRLF header injection) currently listed as an open deferred dependency upgrade — turning a required major-version bump into a deletion.

If approved: confirm zero importers remain, `npm uninstall nodemailer @types/nodemailer`, run `npm run build` and the full suite, and note the closed advisory in `CHANGELOG.md` under **Security**.
