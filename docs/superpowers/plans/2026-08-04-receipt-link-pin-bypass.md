# Scoped receipt-link PIN bypass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipient who follows a link we generated for a specific hand receipt — in a notification email, or by scanning the QR printed on the DA 2062 — sees that receipt immediately, with no public-access PIN prompt, and without the PIN ever appearing in an email or a URL.

**Architecture:** Each generated receipt link carries `?k=<hmac>`, an HMAC of the receipt number under `AUTH_SECRET`. `src/proxy.ts` verifies it with Web Crypto (no DB, no bcrypt), sets a cookie naming that one receipt, and redirects to the clean URL. The grant is evaluated *after* the existing logged-in / unlock-cookie checks and unlocks nothing but the receipt it names.

**Tech Stack:** Next.js 16 proxy (Node runtime), Web Crypto (`crypto.subtle`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-emailed-receipt-link-bypass-design.md`

## Global Constraints

- **`src/lib/receipt-link-token.ts` and `src/lib/web-hmac.ts` must not import Prisma, bcrypt, `node:crypto`, or `server-only`.** `src/proxy.ts` imports them and the proxy bundle must stay clean. Web Crypto globals (`crypto.subtle`, `btoa`, `TextEncoder`) only. Same rule as `src/lib/public-access-cookie.ts`.
- **The receipt grant must never widen `publicAccessAllowed()`.** That function gates `liveSearchAction`, and it is the *entire* gate on the public search. It reads the unlock cookie only; it must keep doing so.
- **The grant is evaluated after the logged-in and unlock-cookie checks, never before.** A PIN holder must not be narrowed to one receipt by clicking a link.
- **Domain separator `"rl:"` on every signed message.** The unlock cookie signs `String(expMs)` under the same `AUTH_SECRET`; the two namespaces must not overlap.
- **Query parameter name is `k`**, exported as `RECEIPT_LINK_PARAM`. Cookie is `__Secure-pub_receipt` in production, `pub_receipt` otherwise.
- **No expiry in the token.** The link lives as long as the receipt does.
- **Docs ship in the same commit as the code they describe** (`CLAUDE.md`, non-negotiable). Task 3 carries `docs/SECURITY.md`; Task 4 carries `CHANGELOG.md` + `CLAUDE.md`.
- **Run named test files, not the whole suite.** `npx vitest run <file>`. The integration suite shares one database with any other agent session running concurrently and they truncate each other.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/web-hmac.ts` (create) | The three Web-Crypto primitives — `base64url`, `hmac`, `safeEqual` — extracted from `public-access-cookie.ts` so the unlock cookie and the link token cannot grow two different constant-time compares. |
| `src/lib/public-access-cookie.ts` (modify) | Unchanged behavior; its private crypto helpers now come from `web-hmac.ts`. |
| `src/lib/receipt-link-token.ts` (create) | Sign/verify a per-receipt link token, and the grant-cookie name + value format. Pure; takes `secret` as an argument, reads no env. |
| `src/proxy.ts` (modify) | The new gate branch: `?k=` → set grant + redirect clean; grant cookie → allow; else the existing `/unlock` redirect. |
| `src/modules/items/qr.ts` (modify) | `receiptLinkUrl()` — `receiptUrl()` plus the token, falling back to the clean URL if signing throws. This is the only place that reads `AUTH_SECRET` for a link. |
| `src/app/actions/receipts.ts`, `src/app/actions/returns.ts`, `src/modules/receipts/render.ts` (modify) | The four call sites switch from `receiptUrl` to `await receiptLinkUrl`. |
| `scripts/check-security-docs.mjs` + `.test.mjs` (modify) | Put both new library files under the CI guardrail. |
| `docs/SECURITY.md`, `CHANGELOG.md`, `CLAUDE.md` (modify) | Control inventory, user-facing note, and the accepted-requirement block. |

---

### Task 1: Extract the Web-Crypto helpers

Mechanical refactor, no behavior change. Done first so the token module in Task 2 shares one constant-time compare with the unlock cookie instead of copying it. The existing `public-access-cookie.test.ts` is the proof it stayed identical.

**Files:**
- Create: `src/lib/web-hmac.ts`
- Modify: `src/lib/public-access-cookie.ts:28-53` (delete the three private helpers, import them instead)
- Test: `src/lib/public-access-cookie.test.ts` (existing, unchanged — it must still pass)

**Interfaces:**
- Consumes: nothing.
- Produces: `base64url(bytes: Uint8Array): string`, `hmac(secret: string, msg: string): Promise<string>`, `safeEqual(a: string, b: string): boolean`.

- [ ] **Step 1: Run the existing cookie tests to establish the baseline**

Run: `npx vitest run src/lib/public-access-cookie.test.ts`
Expected: PASS. Note the test count — it must be identical at the end of this task.

- [ ] **Step 2: Create the shared module**

Create `src/lib/web-hmac.ts`:

```ts
// Zero imports; uses only Web Crypto globals (crypto.subtle, btoa, TextEncoder),
// so it is safe to import from anywhere — the src/proxy.ts proxy (Node runtime
// in Next 16) and Node server actions alike.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.
//
// Extracted from public-access-cookie.ts when receipt-link-token.ts needed the
// same three primitives. They are shared rather than copied on purpose: two
// constant-time compares drift, and the one that drifts stops being
// constant-time silently.

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hmac(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return base64url(new Uint8Array(sig));
}

// Length-checked constant-time string compare (avoids early-exit timing leak).
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
```

- [ ] **Step 3: Point `public-access-cookie.ts` at it**

In `src/lib/public-access-cookie.ts`, delete the `base64url`, `hmac` and `safeEqual` function bodies (currently lines 28–53) and add this import directly below the file's header comment block, above `export const UNLOCK_MAX_AGE_SECONDS`:

```ts
import { hmac, safeEqual } from "@/lib/web-hmac";
```

Then amend the file's opening comment — its first line currently claims "Zero imports". Replace that first paragraph with:

```ts
// Imports nothing but @/lib/web-hmac, which is itself zero-import and uses only
// Web Crypto globals (crypto.subtle, btoa, TextEncoder) — so this file is safe
// to import from anywhere: the src/proxy.ts proxy (Node runtime in Next 16) and
// Node server actions alike.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.
```

`base64url` is not referenced anywhere else in this file once `hmac` moves out, so do not import it here.

- [ ] **Step 4: Verify nothing changed**

Run: `npx vitest run src/lib/public-access-cookie.test.ts src/proxy.test.ts src/lib/public-access-guard.test.ts`
Expected: PASS, with the same number of tests as Step 1's baseline for the cookie file. A failure here means the extraction was not mechanical — fix it rather than adjusting a test.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

The `[skip security-doc]` token is required and correct here: `public-access-cookie.ts` is on the CI watch list, and this commit genuinely does not alter the security posture. `CLAUDE.md` documents this exact use (a mechanical refactor), and the token is deliberately visible in review.

```bash
git add src/lib/web-hmac.ts src/lib/public-access-cookie.ts
git commit -m "refactor(security): share the Web-Crypto helpers via web-hmac.ts

Extracted base64url/hmac/safeEqual from public-access-cookie.ts unchanged so
the incoming receipt-link token signs and compares with the same primitives
rather than a second copy. No behavior change.

[skip security-doc]

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The receipt link token

**Files:**
- Create: `src/lib/receipt-link-token.ts`
- Test: `src/lib/receipt-link-token.test.ts`

**Interfaces:**
- Consumes: `hmac`, `safeEqual` from `@/lib/web-hmac` (Task 1).
- Produces:
  - `RECEIPT_LINK_PARAM: "k"`
  - `receiptGrantCookieName(secure: boolean): string`
  - `signReceiptLinkToken(receiptNumber: string, secret: string): Promise<string>`
  - `verifyReceiptLinkToken(receiptNumber: string, token: string | null | undefined, secret: string): Promise<boolean>`
  - `receiptGrantValue(receiptNumber: string, token: string): string`
  - `verifyReceiptGrantValue(value: string | undefined, receiptNumber: string, secret: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/receipt-link-token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signUnlockValue } from "@/lib/public-access-cookie";
import {
  RECEIPT_LINK_PARAM,
  receiptGrantCookieName,
  receiptGrantValue,
  signReceiptLinkToken,
  verifyReceiptGrantValue,
  verifyReceiptLinkToken,
} from "./receipt-link-token";

const SECRET = "test-secret";
const HR = "HR-000123";

describe("receipt link token", () => {
  it("round-trips a token for the receipt it was signed for", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken(HR, token, SECRET)).toBe(true);
  });

  it("is URL-safe, so it needs no encoding in a link", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("REFUSES a token minted for a different receipt", async () => {
    // The whole point of the scope: a link to one receipt must not open another.
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken("HR-000456", token, SECRET)).toBe(false);
  });

  it("refuses a tampered signature", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    const flipped = `${token.slice(0, -1)}${token.slice(-1) === "A" ? "B" : "A"}`;
    expect(await verifyReceiptLinkToken(HR, flipped, SECRET)).toBe(false);
  });

  it("refuses a missing, empty or truncated token", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken(HR, undefined, SECRET)).toBe(false);
    expect(await verifyReceiptLinkToken(HR, null, SECRET)).toBe(false);
    expect(await verifyReceiptLinkToken(HR, "", SECRET)).toBe(false);
    expect(await verifyReceiptLinkToken(HR, token.slice(0, -1), SECRET)).toBe(false);
  });

  it("fails CLOSED with no secret", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptLinkToken(HR, token, "")).toBe(false);
    await expect(signReceiptLinkToken(HR, "")).rejects.toThrow(/AUTH_SECRET/);
  });

  it("refuses a blank receipt number rather than signing one", async () => {
    await expect(signReceiptLinkToken("", SECRET)).rejects.toThrow(/receipt number/);
    expect(await verifyReceiptLinkToken("", "anything", SECRET)).toBe(false);
  });

  it("is domain-separated from the unlock cookie", async () => {
    // Both sign under AUTH_SECRET. Without the "rl:" prefix a value minted for
    // one purpose could be presented for the other.
    const exp = String(Date.now() + 60_000);
    const cookie = await signUnlockValue(Number(exp), SECRET);
    const sig = cookie.slice(cookie.indexOf(".") + 1);
    expect(await verifyReceiptLinkToken(exp, sig, SECRET)).toBe(false);
  });
});

describe("receipt grant cookie", () => {
  it("names the __Secure- prefixed cookie in production", () => {
    expect(receiptGrantCookieName(true)).toBe("__Secure-pub_receipt");
    expect(receiptGrantCookieName(false)).toBe("pub_receipt");
  });

  it("round-trips a grant for its own receipt", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    const value = receiptGrantValue(HR, token);
    expect(await verifyReceiptGrantValue(value, HR, SECRET)).toBe(true);
  });

  it("REFUSES a grant naming a different receipt", async () => {
    const token = await signReceiptLinkToken(HR, SECRET);
    const value = receiptGrantValue(HR, token);
    expect(await verifyReceiptGrantValue(value, "HR-000456", SECRET)).toBe(false);
  });

  it("refuses a grant whose receipt number was swapped but signature kept", async () => {
    // The name inside the cookie is not trusted on its own — it is re-verified
    // against the signature, so rewriting it invalidates the value.
    const token = await signReceiptLinkToken(HR, SECRET);
    expect(await verifyReceiptGrantValue(`HR-000456.${token}`, "HR-000456", SECRET)).toBe(false);
  });

  it("refuses malformed and missing values", async () => {
    expect(await verifyReceiptGrantValue(undefined, HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue("", HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue("no-dot", HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue(`.${await signReceiptLinkToken(HR, SECRET)}`, HR, SECRET)).toBe(false);
    expect(await verifyReceiptGrantValue(`${HR}.`, HR, SECRET)).toBe(false);
  });

  it("exports the query parameter name the proxy and the link builder share", () => {
    expect(RECEIPT_LINK_PARAM).toBe("k");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/receipt-link-token.test.ts`
Expected: FAIL — `Failed to resolve import "./receipt-link-token"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/receipt-link-token.ts`:

```ts
// Imports nothing but @/lib/web-hmac, which is itself zero-import and uses only
// Web Crypto globals — so this file is safe to import from src/proxy.ts.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.
import { hmac, safeEqual } from "@/lib/web-hmac";

/**
 * A capability token for ONE hand receipt, carried in the links we generate for
 * it (the notification emails, and the QR printed on the DA 2062). Holding it
 * lets a logged-out visitor read that receipt without the shared 8-digit PIN.
 *
 * It names a RECEIPT, not a person, and it does not expire — see
 * docs/SECURITY.md §3 and its Known gaps entry for what that costs.
 */

/** Query-string parameter carrying a receipt link token. */
export const RECEIPT_LINK_PARAM = "k";

/**
 * Domain separator, and it is load-bearing.
 *
 * `public-access-cookie.ts` signs `String(expMs)` under the SAME AUTH_SECRET.
 * Without a prefix the two signature namespaces overlap, and a value minted for
 * one purpose could be presented for the other — a receipt number that happened
 * to look like a timestamp, or an unlock signature replayed as a link token.
 * Prefixing keeps them provably disjoint.
 */
const DOMAIN = "rl:";

// Mirror the unlock cookie's convention: __Secure- over HTTPS.
export function receiptGrantCookieName(secure: boolean): string {
  return secure ? "__Secure-pub_receipt" : "pub_receipt";
}

export async function signReceiptLinkToken(receiptNumber: string, secret: string): Promise<string> {
  // Explicit, legible failures. Web Crypto already refuses a zero-length HMAC
  // key with an opaque DOMException from inside importKey; this names the
  // missing variable instead. The blank-receipt guard matters more: signing ""
  // would mint a token that verifies against every request whose path yielded
  // no receipt number.
  if (!secret) throw new Error("AUTH_SECRET is required to sign a receipt link token");
  if (!receiptNumber) throw new Error("a receipt number is required to sign a receipt link token");
  return hmac(secret, DOMAIN + receiptNumber);
}

/** Constant-time check that `token` was minted for exactly `receiptNumber`. */
export async function verifyReceiptLinkToken(
  receiptNumber: string,
  token: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!secret || !token || !receiptNumber) return false;
  const expected = await hmac(secret, DOMAIN + receiptNumber);
  return safeEqual(token, expected);
}

/**
 * Cookie value = "<receiptNumber>.<token>" — self-contained, so the proxy can
 * verify it with no lookup, exactly like the unlock cookie. A receipt number
 * contains no dot and a base64url token contains no dot, so the first dot is
 * unambiguously the separator.
 */
export function receiptGrantValue(receiptNumber: string, token: string): string {
  return `${receiptNumber}.${token}`;
}

/**
 * Check a grant cookie against the receipt the CALLER is asking for.
 *
 * The receipt number inside the cookie is never trusted on its own: it must
 * both match the requested one and be the number the signature covers. So
 * rewriting the name in the cookie invalidates it rather than widening it.
 */
export async function verifyReceiptGrantValue(
  value: string | undefined,
  receiptNumber: string,
  secret: string,
): Promise<boolean> {
  if (!value || !receiptNumber) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const named = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!token || named !== receiptNumber) return false;
  return verifyReceiptLinkToken(named, token, secret);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/receipt-link-token.test.ts`
Expected: PASS, all 13 tests.

Run: `npx tsc --noEmit && npx eslint src/lib/receipt-link-token.ts src/lib/web-hmac.ts`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/receipt-link-token.ts src/lib/receipt-link-token.test.ts
git commit -m "feat(security): per-receipt link token, signed and domain-separated

Signs an HMAC over 'rl:<receiptNumber>' under AUTH_SECRET and verifies it in
constant time, plus the grant-cookie name and value format the proxy will use.
Nothing consumes it yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The proxy gate branch

This is the task that changes who can see what. It carries the `docs/SECURITY.md` update and the CI watch-list entries.

**Files:**
- Modify: `src/proxy.ts:91-93` (capture the receipt number from the path), `src/proxy.ts:203-258` (the new branch)
- Modify: `scripts/check-security-docs.mjs:35+` (watch list), `scripts/check-security-docs.test.mjs:24-33`
- Modify: `docs/SECURITY.md` (§3, Known gaps, Last reviewed)
- Test: `src/proxy.test.ts`, `src/lib/public-access-guard.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: no new exports. `receiptNumberFromPath` stays private to `proxy.ts`.

- [ ] **Step 1: Write the failing proxy tests**

First extend the fixture helper in `src/proxy.test.ts`. Replace the `request` helper (lines 34–46) with:

```ts
const request = (
  opts: { path?: string; cookie?: string; secure?: boolean; cookies?: Record<string, string> } = {},
) => {
  // The public surface now refuses anonymous requests that do not present as a
  // browser, and that check runs BEFORE the PIN gate — so these fixtures need a
  // User-Agent or they would all assert 403 instead of what they are about.
  const headers = new Headers({ "user-agent": BROWSER_UA });
  const jar: string[] = [];
  if (opts.cookie !== undefined) {
    jar.push(`${unlockCookieName(opts.secure ?? false)}=${opts.cookie}`);
  }
  for (const [name, value] of Object.entries(opts.cookies ?? {})) jar.push(`${name}=${value}`);
  if (jar.length) headers.set("cookie", jar.join("; "));
  const req = new NextRequest(`https://example.test${opts.path ?? "/i/abc"}`, { headers });
  // Logged out — the PIN gate only applies to anonymous visitors.
  Object.defineProperty(req, "auth", { value: null, configurable: true });
  return req as NextRequest & { auth: null };
};
```

Then append this describe block to the end of the file:

```ts
describe("proxy — scoped receipt link", () => {
  const HR = "HR-000123";
  const link = async (receiptNumber = HR) =>
    signReceiptLinkToken(receiptNumber, SECRET);
  const grant = async (receiptNumber = HR, secure = false) => ({
    [receiptGrantCookieName(secure)]: receiptGrantValue(
      receiptNumber,
      await signReceiptLinkToken(receiptNumber, SECRET),
    ),
  });

  it("admits a valid ?k= link, stripping the token and remembering the grant", async () => {
    const res = await run(request({ path: `/receipts/${HR}?k=${await link()}` }));
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`/receipts/${HR}`);
    expect(location).not.toContain("k=");
    expect(location).not.toContain("/unlock");
    expect(res.headers.get("set-cookie") ?? "").toContain(receiptGrantCookieName(false));
  });

  it("preserves other query parameters when it strips the token", async () => {
    const res = await run(request({ path: `/receipts/${HR}?utm=mail&k=${await link()}` }));
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("utm=mail");
    expect(location).not.toContain("k=");
  });

  it("sets the grant cookie with the Secure ATTRIBUTE in production", async () => {
    // Same prod-only blind spot as the unlock cookie: a __Secure- prefixed
    // cookie sent without the attribute is dropped by the browser outright, so
    // the grant would never stick and every recipient would still see /unlock.
    // Matched as an attribute (`; Secure`), never as a substring — the cookie is
    // NAMED __Secure-pub_receipt, so toContain("Secure") passes on the name.
    vi.stubEnv("NODE_ENV", "production");
    const res = await run(request({ path: `/receipts/${HR}?k=${await link()}` }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(receiptGrantCookieName(true));
    expect(setCookie).toContain("; Secure");
    expect(setCookie).toContain("HttpOnly");
  });

  it("admits the receipt page and its PDF on the grant cookie alone", async () => {
    expect((await run(request({ path: `/receipts/${HR}`, cookies: await grant() })))
      .headers.get("location")).toBeNull();
    expect((await run(request({ path: `/receipts/${HR}/pdf`, cookies: await grant() })))
      .headers.get("location")).toBeNull();
  });

  it("REFUSES another receipt on that grant", async () => {
    const res = await run(request({ path: "/receipts/HR-000456", cookies: await grant() }));
    expect(res.headers.get("location")).toContain("/unlock");
  });

  it("REFUSES an item page on that grant", async () => {
    // A receipt grant must never reach the device catalog.
    const res = await run(request({ path: "/i/abc", cookies: await grant() }));
    expect(res.headers.get("location")).toContain("/unlock");
  });

  it("refuses a token minted for a different receipt", async () => {
    const res = await run(request({ path: `/receipts/${HR}?k=${await link("HR-000456")}` }));
    expect(res.headers.get("location")).toContain("/unlock");
  });

  it("refuses a forged token and sets no cookie", async () => {
    const res = await run(request({ path: `/receipts/${HR}?k=not-a-signature` }));
    expect(res.headers.get("location")).toContain("/unlock");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not let a link token unlock the receipt BUILDER", async () => {
    // /receipts/new is staff-only and is deliberately outside the PIN gate; it
    // must keep falling through to the login redirect, not the unlock page.
    const res = await run(request({ path: `/receipts/new?k=${await link("new")}` }));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("leaves a logged-in user alone", async () => {
    const req = request({ path: `/receipts/${HR}?k=${await link()}` });
    Object.defineProperty(req, "auth", { value: { user: { id: "u1" } }, configurable: true });
    const res = await run(req);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("leaves a PIN-unlocked visitor alone rather than narrowing them to one receipt", async () => {
    const res = await run(
      request({
        path: `/receipts/${HR}?k=${await link()}`,
        cookie: await signUnlockValue(Date.now() + UNLOCK_TTL_MS, SECRET),
      }),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
```

Add to the imports at the top of `src/proxy.test.ts`:

```ts
import {
  receiptGrantCookieName,
  receiptGrantValue,
  signReceiptLinkToken,
} from "@/lib/receipt-link-token";
```

- [ ] **Step 2: Write the failing guard test**

Append to `src/lib/public-access-guard.test.ts`, inside the existing `describe("publicAccessAllowed", ...)` block:

```ts
  it("is NOT satisfied by a receipt grant cookie", async () => {
    // The grant opens one receipt page. It must never reach this function,
    // which is the entire gate on liveSearchAction — i.e. on the searchable
    // item and receipt catalog.
    const token = await signReceiptLinkToken("HR-000123", SECRET);
    cookieJar[receiptGrantCookieName(false)] = receiptGrantValue("HR-000123", token);
    expect(await publicAccessAllowed()).toBe(false);
  });
```

Add to that file's imports:

```ts
import {
  receiptGrantCookieName,
  receiptGrantValue,
  signReceiptLinkToken,
} from "@/lib/receipt-link-token";
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npx vitest run src/proxy.test.ts src/lib/public-access-guard.test.ts`
Expected: the new `proxy — scoped receipt link` tests FAIL (every `?k=` and grant case redirects to `/unlock`). The guard test should already PASS — `publicAccessAllowed` reads only the unlock cookie, and this test exists to keep it that way. Confirm that is why it passes before moving on.

- [ ] **Step 4: Capture the receipt number from the path**

In `src/proxy.ts`, replace the `isPinGatedPath` definition (lines 91–93) with:

```ts
// One regex, two uses: the gate membership test and the receipt number the
// scoped-link branch needs. Splitting them into two patterns would let the set
// of gated paths and the set of link-openable paths drift apart.
const RECEIPT_PATH = /^\/receipts\/(?!new(?:\/|$))([^/]+)(?:\/pdf)?$/;

const isPinGatedPath = (pathname: string) =>
  pathname.startsWith("/i/") || RECEIPT_PATH.test(pathname);

/**
 * The receipt number a path is asking for, or null when the path names no
 * single receipt (every `/i/*` page, and the staff builder at `/receipts/new`).
 *
 * Deliberately NOT decoded. The token is signed over the receipt number exactly
 * as `receiptUrl()` writes it into the link, and receipt numbers are
 * `HR-<digits>` — nothing that needs escaping. Decoding would add a throw on
 * malformed input (`%zz`) inside the proxy for no gain.
 */
function receiptNumberFromPath(pathname: string): string | null {
  return RECEIPT_PATH.exec(pathname)?.[1] ?? null;
}
```

- [ ] **Step 5: Add the gate branch**

In `src/proxy.ts`, inside the `if (isPinGatedPath(pathname))` block, insert this immediately after the existing `if (shouldAllowPublic({...})) { return NextResponse.next(); }` and before `const url = new URL("/unlock", req.url);`:

```ts
    // A link WE generated for ONE receipt admits its holder to that receipt
    // without the shared PIN — the notification emails and the QR printed on the
    // DA 2062 both carry one. See docs/SECURITY.md §3.
    //
    // ORDER IS LOAD-BEARING: this runs AFTER the logged-in and unlock-cookie
    // decision above, never before. Those are the broad grants; a technician or
    // a visitor who already typed the PIN must not be narrowed to a single
    // receipt by clicking a link in their inbox.
    //
    // Scope is enforced by the signature, not by this branch: a token verifies
    // against exactly the receipt number it was minted for, and `/i/*` yields no
    // receipt number at all, so nothing here can reach the device catalog.
    const linkedReceipt = flagEnabled && !loggedIn ? receiptNumberFromPath(pathname) : null;
    if (linkedReceipt) {
      const presentedToken = req.nextUrl.searchParams.get(RECEIPT_LINK_PARAM);
      if (await verifyReceiptLinkToken(linkedReceipt, presentedToken, secret)) {
        // Redirect to the same page without the token, remembering the grant in
        // a cookie. Three things this buys, all of which break without it: the
        // token leaves the address bar (so it is not copied out of a shared
        // screen, or leaked in a Referer), the PDF download link on the page
        // works without carrying it, and a refresh does not depend on it.
        const clean = req.nextUrl.clone();
        clean.searchParams.delete(RECEIPT_LINK_PARAM);
        const res = NextResponse.redirect(clean);
        res.cookies.set(
          receiptGrantCookieName(secure),
          receiptGrantValue(linkedReceipt, presentedToken as string),
          {
            httpOnly: true,
            secure,
            sameSite: "lax",
            path: "/",
            // NOT the link's lifetime — the link never expires. This only has to
            // outlive one sitting; re-clicking the emailed link re-grants.
            maxAge: UNLOCK_MAX_AGE_SECONDS,
          },
        );
        return res;
      }
      // No token, or a bad one: fall back to a grant already in the jar. It is
      // re-verified against THIS path's receipt number, so a grant for another
      // receipt simply does not apply and drops through to /unlock below.
      const grant = req.cookies.get(receiptGrantCookieName(secure))?.value;
      if (await verifyReceiptGrantValue(grant, linkedReceipt, secret)) {
        return NextResponse.next();
      }
    }
```

Add to the imports at the top of `src/proxy.ts`:

```ts
import { UNLOCK_MAX_AGE_SECONDS } from "@/lib/public-access-cookie";
import {
  RECEIPT_LINK_PARAM,
  receiptGrantCookieName,
  receiptGrantValue,
  verifyReceiptGrantValue,
  verifyReceiptLinkToken,
} from "@/lib/receipt-link-token";
```

`UNLOCK_MAX_AGE_SECONDS` may be merged into the existing `@/lib/public-access-cookie` import statement rather than added as a second one.

Note on the `as string` cast: `verifyReceiptLinkToken` returns true only for a non-empty token, so `presentedToken` is non-null inside that branch, but TypeScript cannot narrow through the call.

Also update the proxy's header comment — gate 1's description (around line 28) currently reads "A logged-in user OR a valid unlock cookie passes". Extend it:

```ts
//  1. Public PII surface (`/i/*`, `/receipts/*` — NOT `/`): the shared 8-digit PIN
//     gate, active only when PUBLIC_ACCESS_PIN_ENABLED is on. A logged-in user,
//     a valid unlock cookie, OR a signed link token naming that one receipt
//     passes; otherwise redirect to /unlock. This is NOT an authz boundary —
//     real authz stays per-route (requireUser/requireAdmin).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/proxy.test.ts src/lib/public-access-guard.test.ts src/lib/receipt-link-token.test.ts`
Expected: PASS, including every pre-existing PIN-gate test.

Run: `npx tsc --noEmit && npx eslint src/proxy.ts`
Expected: clean.

- [ ] **Step 7: Put both new files under the CI guardrail**

In `scripts/check-security-docs.mjs`, add these two entries to `WATCHED`, immediately after the existing `public-access` entry (line 52):

```js
  // The scoped receipt link: its signing scope, its domain separator, and the
  // fact that it does not expire ARE the posture. The grant it mints is the one
  // way into the PII surface that needs neither a session nor the PIN.
  [/^src\/lib\/receipt-link-token\.ts$/, "the scoped receipt-link bypass (§3)"],
  // The HMAC + constant-time compare behind BOTH the unlock cookie and the
  // receipt link token. A change here changes both at once.
  [/^src\/lib\/web-hmac\.ts$/, "the Web-Crypto primitives behind the PIN gate (§3)"],
```

In `scripts/check-security-docs.test.mjs`, add to the `introducedThisBranch` array (line 24):

```js
    // The scoped receipt-link bypass and the shared crypto primitives under it.
    "src/lib/receipt-link-token.ts",
    "src/lib/web-hmac.ts",
```

Run: `npx vitest run scripts/check-security-docs.test.mjs`
Expected: PASS.

- [ ] **Step 8: Update `docs/SECURITY.md`**

Three edits:

1. Line 6 — set `**Last reviewed: 2026-08-04**` (already today's date; leave it if unchanged).
2. In `## 3. Public surface & the PIN gate`, add a subsection documenting the control. It must state: what the token covers (`hmac(AUTH_SECRET, "rl:" + receiptNumber)`), that it is checked *after* the session and unlock-cookie checks, that it grants exactly one receipt page plus its PDF and nothing else, that `publicAccessAllowed()` (and therefore the public search) is deliberately not widened by it, the cookie's name/flags/12-hour life, and that the cookie's life is not the link's.
3. In `## Known gaps & accepted risks`, add an entry covering: the link does not expire, so a forwarded email or a photographed QR opens that receipt until the 90-day purge removes a closed receipt (an open one, indefinitely); and there is no per-receipt revocation — the only lever is rotating `AUTH_SECRET`, which also invalidates every session and every unlock cookie. Note that adding revocation means a per-receipt salt on the row, a schema change.

Run: `npm run check:security-docs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts src/lib/public-access-guard.test.ts \
  scripts/check-security-docs.mjs scripts/check-security-docs.test.mjs docs/SECURITY.md
git commit -m "feat(security): admit a signed per-receipt link past the PIN gate

The proxy now accepts ?k=<token> on /receipts/<n> and /receipts/<n>/pdf,
mints a cookie naming that one receipt, and redirects to the clean URL. It is
checked after the logged-in and unlock-cookie grants, never before, and opens
nothing else: another receipt, any /i/* page and the public search are all
still behind the PIN.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Put the token on the links we send

**Files:**
- Modify: `src/modules/items/qr.ts`
- Modify: `src/app/actions/receipts.ts:105`, `src/app/actions/receipts.ts:161`, `src/app/actions/returns.ts:78`, `src/modules/receipts/render.ts:66`
- Modify: `CHANGELOG.md`, `CLAUDE.md`
- Test: `src/modules/items/qr.test.ts`

**Interfaces:**
- Consumes: `RECEIPT_LINK_PARAM`, `signReceiptLinkToken` (Task 2); the proxy branch (Task 3) is what makes the emitted links useful.
- Produces: `receiptLinkUrl(receiptNumber: string, baseUrl?: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/items/qr.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptLinkUrl } from "./qr";
import { verifyReceiptLinkToken } from "@/lib/receipt-link-token";

describe("receiptLinkUrl", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("appends a token the proxy will accept for that receipt", async () => {
    const url = await receiptLinkUrl("HR-000123", "https://app.example");
    const token = new URL(url).searchParams.get("k") ?? "";
    expect(url.startsWith("https://app.example/receipts/HR-000123?k=")).toBe(true);
    expect(await verifyReceiptLinkToken("HR-000123", token, "test-secret")).toBe(true);
  });

  it("mints a token that does NOT open a different receipt", async () => {
    const url = await receiptLinkUrl("HR-000123", "https://app.example");
    const token = new URL(url).searchParams.get("k") ?? "";
    expect(await verifyReceiptLinkToken("HR-000456", token, "test-secret")).toBe(false);
  });

  it("falls back to the plain URL when signing throws", async () => {
    // A misconfigured deploy must not fail a receipt email or a PDF render — the
    // recipient gets the PIN prompt, which is exactly today's behavior.
    vi.stubEnv("AUTH_SECRET", "");
    expect(await receiptLinkUrl("HR-000123", "https://app.example")).toBe(
      "https://app.example/receipts/HR-000123",
    );
  });
});
```

If `src/modules/items/qr.test.ts` has no imports of `vitest` helpers beyond `expect`/`it`, merge the import line above with whatever is already at the top of that file rather than adding a duplicate import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/items/qr.test.ts`
Expected: FAIL — `receiptLinkUrl is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/modules/items/qr.ts`, add below `receiptUrl` (line 7):

```ts
/**
 * The receipt URL we SEND — `receiptUrl` plus a signed token that lets a
 * logged-out recipient past the public-access PIN gate for this one receipt.
 * Use it for every link we generate for a specific receipt (the notification
 * emails, the QR on the DA 2062); use bare `receiptUrl` for anything DISPLAYED,
 * which should stay short and typable.
 *
 * Never throws. A missing AUTH_SECRET yields the plain URL, so a misconfigured
 * deploy costs the recipient a PIN prompt rather than failing the email send or
 * the PDF render outright.
 */
export async function receiptLinkUrl(receiptNumber: string, baseUrl?: string): Promise<string> {
  const url = receiptUrl(receiptNumber, baseUrl);
  try {
    const token = await signReceiptLinkToken(receiptNumber, process.env.AUTH_SECRET ?? "");
    // base64url — URL-safe by construction, so it needs no encoding.
    return `${url}?${RECEIPT_LINK_PARAM}=${token}`;
  } catch (e) {
    console.error("[receipt-link] could not sign a receipt link token; sending the plain URL:", e);
    return url;
  }
}
```

And add the import at the top of the file:

```ts
import { RECEIPT_LINK_PARAM, signReceiptLinkToken } from "@/lib/receipt-link-token";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/items/qr.test.ts`
Expected: PASS.

- [ ] **Step 5: Switch the four call sites**

Each is already inside an `async` function, so `await` needs no signature change.

`src/app/actions/receipts.ts:105` — in `createReceiptAction`:
```ts
        receiptNumber: t.receiptNumber, receiptUrl: await receiptLinkUrl(t.receiptNumber), items,
```

`src/app/actions/receipts.ts:161` — in `notifyPickupAction`:
```ts
      receiptUrl: await receiptLinkUrl(t.receiptNumber),
```

`src/app/actions/returns.ts:78` — in `processReturnAction`:
```ts
        receiptUrl: await receiptLinkUrl(res.receiptNumber),
```

`src/modules/receipts/render.ts:66` — in `renderReceiptPdf`:
```ts
    receiptUrl: await receiptLinkUrl(t.receiptNumber),
```

Update each file's import of `receiptUrl` from `@/modules/items/qr` to import `receiptLinkUrl` instead. In `receipts.ts` and `returns.ts`, check whether `receiptUrl` is still used elsewhere in the file before removing it from the import list; in `render.ts:5` it is used only on line 66, so replace it.

Add a comment above the `render.ts` call, since that one is not obviously an outbound link:

```ts
    // Carries the scoped link token: this URL is encoded into the QR printed on
    // the receipt, and scanning the paper you are holding should not demand the
    // PIN. It is QR-only — buildHandReceiptPdf prints no text URL beside it — so
    // the token's length costs nothing legibility-wise.
```

- [ ] **Step 6: Verify no call site was missed**

Run: `npx tsc --noEmit && npx eslint src/modules/items/qr.ts src/app/actions/receipts.ts src/app/actions/returns.ts src/modules/receipts/render.ts`
Expected: clean.

Run: `npx vitest run src/modules/items/qr.test.ts src/modules/receipts src/modules/returns`
Expected: PASS.

Then confirm the only remaining `receiptUrl(` call sites are display-only:

Run: `git grep -n "receiptUrl(" -- src | grep -v test`
Expected: `src/modules/items/qr.ts` (the definition and the call inside `receiptLinkUrl`) and nothing else. Any other hit is a link we send that was missed.

- [ ] **Step 7: Update `CHANGELOG.md`**

Under the existing `## 2026-08-04` heading, in its `### Changed` section, add an entry written for a reader rather than a diff. It must say: links in receipt, pickup and return emails — and the QR printed on the hand receipt — now open that receipt directly instead of asking for the access PIN; the PIN is never included in the link; the link opens **only** that one receipt, so the rest of the property book still requires the PIN; and the link keeps working for as long as the receipt exists (closed receipts are removed after 90 days), so anyone the email is forwarded to can also open that receipt.

- [ ] **Step 8: Update `CLAUDE.md`**

In §1, the accepted-requirement block, extend the `UPDATE (2026-07-22)` paragraph about the PIN gate with a new `UPDATE (2026-08-04)` paragraph recording: links the app generates for a specific receipt carry a signed token (`src/lib/receipt-link-token.ts`) that admits the holder to that receipt only; the check lives in `src/proxy.ts` after the session/unlock-cookie grants; it deliberately does not widen `publicAccessAllowed()`, so the public search stays PIN-only; and it must not be extended to `/i/*` or to a broader grant without an explicit decision, because `receipt-link-token.ts` is on the `check-security-docs` watch list for that reason.

- [ ] **Step 9: Run the full affected set and commit**

Run: `npx vitest run src/lib src/proxy.test.ts src/modules/items scripts/check-security-docs.test.mjs`
Expected: PASS.

Run: `npm run check:security-docs && npm run lint && npm run build`
Expected: all clean. (`build` is a required CI check; it is not evidence the feature works — Task 5 is.)

```bash
git add src/modules/items/qr.ts src/modules/items/qr.test.ts src/app/actions/receipts.ts \
  src/app/actions/returns.ts src/modules/receipts/render.ts CHANGELOG.md CLAUDE.md
git commit -m "feat(receipts): emailed and printed receipt links skip the PIN prompt

The three notification emails and the QR on the DA 2062 now carry the scoped
link token, so a recipient opens their own receipt directly. Signing failure
falls back to the plain URL rather than failing the send or the render.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Verify it in a real browser

`npm run build` and jsdom are not evidence — neither exercises a redirect, a `Set-Cookie`, or a browser's cookie-prefix rules. This task is the proof.

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server with the gate on**

Confirm `.env.local` has `PUBLIC_ACCESS_PIN_ENABLED=true` and a non-empty `AUTH_SECRET`, then run `npm run dev`. Next 16 allows one dev server at a time — stop any other before starting.

- [ ] **Step 2: Mint a link for a real receipt**

Pick an existing receipt number from `/receipts` or the database. In a Node REPL at the repo root:

```bash
node --input-type=module -e "
const s = process.env.AUTH_SECRET;
const enc = new TextEncoder();
const key = await crypto.subtle.importKey('raw', enc.encode(s), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('rl:HR-000123')));
let bin=''; for (const b of sig) bin += String.fromCharCode(b);
console.log('http://localhost:3000/receipts/HR-000123?k=' + btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));
"
```

Substitute the real receipt number in **both** places. Load `AUTH_SECRET` from `.env.local` into the environment first.

- [ ] **Step 3: Check each case in a private window**

Use a fresh private window per case so no cookie carries over. Confirm:

1. The generated link opens the receipt with **no** PIN prompt, and the address bar shows the clean URL with no `?k=`.
2. The receipt's PDF download link works in that same window.
3. Refreshing the clean URL still works.
4. A different receipt's clean URL in that same window redirects to `/unlock`.
5. `/i/<some-item-id>` in that same window redirects to `/unlock`.
6. The home page search box in that same window reports locked rather than returning results.
7. Editing one character of the token in the link gives `/unlock`.
8. In a window where you have entered the PIN normally, opening the link keeps you unlocked everywhere (it does not narrow you to one receipt).

- [ ] **Step 4: Check a real generated email and PDF**

Create a test hand receipt through `/receipts/new` addressed to an inbox you control. Confirm the emailed link contains `?k=`, and that opening it from the mail client — not from the browser's history — lands on the receipt with no prompt. Then open the attached PDF and scan its QR with a phone that has never unlocked the site: it must open that receipt directly.

- [ ] **Step 5: Record the result**

If every case behaves as listed, the feature is verified. If any does not, fix it and re-run this whole task — a partial pass is not a pass. Do not report the work complete on Tasks 1–4 alone.

---

### Task 6: Ship it

- [ ] **Step 1: Review the branch**

Run `/code-review xhigh`. It is a convention rather than an enforced gate, but this change alters who can read PII without authenticating, which is the case it exists for.

- [ ] **Step 2: Open the PR**

The branch is `feat/receipt-link-pin-bypass`, stacked on `f4fa580` from `feat/search-progress-and-receipt-form`. If that branch's PR has merged, rebase onto `main` first so the diff is only this work:

```bash
git fetch origin && git rebase origin/main
```

Then open the PR. All three required checks must pass: `Semgrep SAST`, `Build (next build)`, `Security docs current`.

- [ ] **Step 3: Confirm there is no migration**

There is none — this change adds no table, column, seed or env var. Nothing to apply to Supabase before the merge deploys.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Token module, `"rl:"` separator, no expiry, `?k=` | 2 |
| Proxy branch, ordering after the broad grants | 3, Step 5 |
| Grant cookie name/flags/12h, one receipt not a list | 3, Step 5 |
| Link generation + four call sites | 4, Steps 3 and 5 |
| PDF QR is safe to lengthen | 4, Step 5 comment |
| `publicAccessAllowed` unaffected | 3, Steps 2 and 8 |
| Flag off ⇒ inert | 3, Step 5 (`flagEnabled &&` guard) |
| Error handling: fall through, no logging, signing fallback | 2 Step 3, 3 Step 5, 4 Step 3 |
| All listed tests | 2, 3, 4 |
| SECURITY.md, watch list, CHANGELOG, CLAUDE.md | 3 Steps 7–8, 4 Steps 7–8 |

**Deviation from the spec, deliberate:** the spec says `receipt-link-token.ts` has "zero imports". It imports `@/lib/web-hmac`, which is itself zero-import and Web-Crypto-only. The constraint the spec was protecting — no Prisma, bcrypt, `node:crypto` or `server-only` in the proxy bundle — is preserved; sharing one constant-time compare between the two token schemes is worth the single import. Task 1 exists for this.

**Names used consistently across tasks:** `RECEIPT_LINK_PARAM`, `receiptGrantCookieName`, `receiptGrantValue`, `signReceiptLinkToken`, `verifyReceiptLinkToken`, `verifyReceiptGrantValue`, `receiptLinkUrl`, `receiptNumberFromPath`, `RECEIPT_PATH`.
