# Emailed / printed receipt links that skip the PIN prompt — design

**Date:** 2026-08-04
**Status:** Approved design, pending implementation plan
**Author:** ops@turtolabs.com (Turto Labs) + Claude

## Problem

A recipient who is sent a hand receipt gets an email containing
`https://www.dcsim.us/receipts/HR-000123`. Since the public-access PIN gate
shipped (2026-07-22, see `2026-07-21-public-pin-gate-design.md`), following that
link lands on `/unlock` and demands the shared 8-digit PIN. The same is true of
the QR code printed on the DA 2062 itself: scanning the paper receipt you are
holding produces a PIN prompt.

Both are legitimate arrivals — we sent the person the link, or handed them the
paper. Making them find and type a shared org secret to read their own receipt
is friction that also encourages the worst possible mitigation: circulating the
PIN itself.

**Goal:** a recipient who arrives from a link we generated for a specific
receipt sees that receipt immediately, with no PIN prompt and without the PIN
ever appearing in an email, a URL, or a browser history.

This is a **deliberate feature change** to the accepted-requirement block in
`CLAUDE.md` §1, not a security auto-remediation.

## Decisions (locked)

| Decision | Choice |
|---|---|
| What an emailed link unlocks | **Only the receipt it names.** Any other `/receipts/*` page, every `/i/*` item page, and the home-page search all still require the PIN. |
| Link lifetime | **No expiry.** The link works as long as the receipt exists; the 90-day purge of closed receipts ends it naturally (the page 404s once the record is gone). |
| Surfaces | **Both** the three notification emails and the QR printed on the hand-receipt PDF. |
| Mechanism | An **HMAC token in the URL** (`?k=…`), verified by the proxy with Web Crypto. Never the PIN itself. |
| Grant persistence | A **scoped cookie naming one receipt**, set by the proxy, so the token can be stripped from the address bar. |

## Non-goals

- Putting the literal PIN in a link (`?pin=12345678`). It publishes the org-wide
  shared secret into every inbox, browser history, and forwarded email — and the
  proxy could not verify it anyway, because the PIN is a bcrypt hash and
  `src/proxy.ts` must not import bcrypt or Prisma.
- Per-recipient identity. The token names a *receipt*, not a person. Anyone
  holding the link holds the capability.
- Extending this to item QR labels on devices (`/i/<id>`). Considered and
  deliberately left out of this change.
- Any change to how a logged-in user or a PIN holder is treated.

## Architecture

### 1. `src/lib/receipt-link-token.ts` (new)

A leaf module under the same rule as `public-access-cookie.ts`: **zero imports,
Web Crypto globals only** (`crypto.subtle`, `btoa`, `TextEncoder`). `src/proxy.ts`
imports it, and the proxy bundle must stay free of Prisma, bcrypt, `node:crypto`
and `server-only`.

```ts
export const RECEIPT_LINK_PARAM = "k";

// token = base64url(hmac(secret, "rl:" + receiptNumber))
export async function signReceiptLinkToken(receiptNumber: string, secret: string): Promise<string>
export async function verifyReceiptLinkToken(receiptNumber: string, token: string | undefined, secret: string): Promise<boolean>
```

The `"rl:"` **domain separator is load-bearing.** The unlock cookie signs
`String(expMs)` with the same `AUTH_SECRET`; without a prefix the two signature
namespaces overlap and a value minted for one purpose could be presented for the
other. Prefixing keeps them disjoint.

There is no expiry component, per the locked decision. Comparison is
constant-time and length-checked, mirroring `safeEqual` in
`public-access-cookie.ts`.

### 2. Proxy branch — `src/proxy.ts`

Inside the existing `isPinGatedPath` block (currently `src/proxy.ts:203`),
**after** the logged-in / unlock-cookie decision and **before** the `/unlock`
redirect:

1. Parse the receipt number from the path. Only `/receipts/<n>` and
   `/receipts/<n>/pdf` yield one; `/i/*` yields nothing and skips this branch
   entirely.
2. If `?k=` is present and verifies against **that** receipt number: set the
   grant cookie and `NextResponse.redirect` to the same path with `k` removed.
3. Else if the grant cookie is present and its token verifies against **this
   path's** receipt number: `NextResponse.next()`.
4. Else: the existing `/unlock` redirect, unchanged.

Ordering matters. The logged-in and unlock-cookie checks stay first — they are
the broad grants, and a PIN holder must never be narrowed to a single receipt by
clicking an emailed link. The redirect in step 2 is what gets the token out of
the address bar; every subsequent request (refresh, the PDF download link, the
back button within that receipt) is served by the cookie.

### 3. Grant cookie

Name `__Secure-pub_receipt` in production, `pub_receipt` otherwise — mirroring
`unlockCookieName`'s convention. Value is `<receiptNumber>.<sig>`, self-contained
and self-verifying with no DB lookup, exactly like the unlock cookie. Flags:
`httpOnly`, `secure` in production, `sameSite: "lax"`, `path: "/"`,
`maxAge` = 12h (`UNLOCK_MAX_AGE_SECONDS`).

The cookie's lifetime is **not** the link's lifetime. The link never expires; the
cookie only has to survive one browsing session, and re-clicking the emailed link
re-grants instantly.

**The grant is one receipt, not a list.** Opening receipt B's link overwrites A's
grant, so hitting Back to A's clean URL re-prompts. Accepted: it matches the
locked "only the receipt it names" scope, and the fix from the recipient's side
is clicking the original link again. A capped list would avoid it at the cost of
read-modify-re-sign logic in the proxy.

### 4. Link generation

`receiptUrl()` in `src/modules/items/qr.ts` stays clean and synchronous — it is
used for display too (`src/app/i/[itemId]/page.tsx:263` prints an item URL as
text). A new async sibling appends the token, falling back to the clean URL if
signing throws.

Four call sites:

| Site | Purpose |
|---|---|
| `src/app/actions/receipts.ts:105` | new-receipt email |
| `src/app/actions/receipts.ts:161` | pickup-notice email |
| `src/app/actions/returns.ts:78` | return-confirmation email |
| `src/modules/receipts/render.ts:66` | the QR on the DA 2062 PDF |

The PDF is safe to lengthen: `buildHandReceiptPdf` uses `receiptUrl` **only** to
encode the QR image (`src/modules/receipts/hand-receipt.ts:249`) and prints no
human-readable URL beside it, so nobody has to type the token.

## Interaction with the existing gates

- **`publicAccessAllowed()`** (`src/lib/public-access-guard.ts`) reads only the
  *unlock* cookie, so it is unaffected: the home-page type-ahead
  (`liveSearchAction`) stays PIN-only. A receipt grant must never make the item
  catalog searchable. This is asserted by a test rather than left to inspection.
- **`shouldAllowPublic`** is untouched. The receipt grant is a *separate,
  narrower* decision evaluated after it, not a new input to it — so the shared
  "flag off = open, logged in = bypass" rule cannot drift between the proxy and
  the guard.
- **Flag off** (`PUBLIC_ACCESS_PIN_ENABLED !== "true"`): everything public is
  already open, the branch is never reached, and the token is inert. Tokens are
  emitted anyway so links stay stable if the flag is later turned on.
- **Rate limiting** is unchanged. A token-bearing request is still anonymous and
  still pays the 300/min `API_POLICY` budget in gate 0b.

## Error handling

| Case | Behavior |
|---|---|
| `?k=` absent, malformed, or fails verification | Fall through to the `/unlock` redirect. No error page. |
| Token valid for a different receipt | Same — fall through. |
| Grant cookie for a different receipt | Same — fall through; the cookie is left in place (it is still valid for its own receipt). |
| `AUTH_SECRET` missing | Signing throws. The email senders and the PDF builder catch it and emit the clean URL, so a send or a render never fails over this. Verification returns false, so the gate stays closed. |

Nothing is logged on a refused token. `verifyUnlockValue` logs on its ceiling
check only because a genuine signature is required to reach it; here there is no
expiry and therefore no `retire` concept, so a log line would be unauthenticated
amplification anyone could drive.

## Tradeoffs and accepted risks

- **A link is a permanent capability.** Anyone who receives, forwards, or
  photographs it can open that receipt until the 90-day purge removes the record.
  This is the direct consequence of the locked "no expiry" decision.
- **There is no revocation lever.** Invalidating issued tokens means rotating
  `AUTH_SECRET`, which also signs every user out and retires every unlock cookie.
  If per-receipt revocation is ever wanted, the token needs a per-receipt salt
  stored on the row — a schema change, not a tweak.
- **Scope is narrower than the PIN, not wider.** A leaked link exposes one
  receipt; a leaked PIN exposes the whole catalog. Compared with today's practice
  of telling recipients the PIN over the phone, this reduces exposure.

## Testing

- `src/lib/receipt-link-token.test.ts` — round-trip; a token for `HR-000123`
  rejected for `HR-000456`; tampered signature rejected; empty/missing token
  rejected; missing secret rejected; **domain separation** (an unlock-cookie
  value cannot pass as a link token and vice versa).
- `src/proxy.test.ts` — valid `?k=` redirects to the clean path and sets the
  cookie; grant cookie opens `/receipts/<n>` and `/receipts/<n>/pdf`; A's grant
  does **not** open B; no grant opens any `/i/*`; a logged-in user and a valid
  unlock cookie behave exactly as before.
- `src/lib/public-access-guard.test.ts` — a receipt grant cookie does **not**
  satisfy `publicAccessAllowed()`.
- Email/PDF senders — the generated URL carries `?k=`, and falls back to the
  clean URL when signing throws.

## Documentation (same commit as the code)

- `docs/SECURITY.md` — new control entry for the scoped receipt link, plus a
  **Known gaps & accepted risks** entry covering the no-revocation and
  permanent-capability properties. Bump *Last reviewed*.
- `scripts/check-security-docs.mjs` — add `src/lib/receipt-link-token.ts` to the
  watch list (`src/proxy.ts` and `public-access-*.ts` are already on it).
- `CHANGELOG.md` — entry under `## 2026-08-04`.
- `CLAUDE.md` §1 — extend the 2026-07-22 PIN-gate update note to record that
  links we generate for a specific receipt bypass the PIN for that receipt only.

## Open questions

None. All decisions above are locked.
