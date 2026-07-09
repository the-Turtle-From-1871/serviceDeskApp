# Design: Technician signatures + "CLOSED" rename

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation plan
**Builds on:** the shipped property-returns feature (`2026-07-09-property-returns-design.md`).

## Problem

When a technician accepts a return, the closed receipt must show a formal
attestation — the accepting technician's **printed name, drawn signature, and
date** — parallel to the closed-out banner (on both the web page and the PDF).
Technicians should be able to **save a signature to their profile once** and
reuse it with one click anywhere they sign, rather than redrawing every time.
Separately, the closed-out banner wording changes from "VOID / CLEARED" to
**"CLOSED"** on both surfaces.

## Decisions (locked with the user)

1. **Drawn signature** (not typed). Reuse the existing `SignaturePad`.
2. **Saveable + reusable:** a technician can save one signature on their Account
   page and reuse it; the signing field offers "use my saved signature" vs "draw
   a new one." Built as a reusable field for any future technician sign point.
3. **Required on EVERY return** (partial and full), not just the closing one.
4. Banner text becomes **"CLOSED"** on both the web receipt page and the diagonal
   PDF watermark.
5. The attestation block shown parallel to the banner/watermark is the
   **closing technician's** (the FULL return that closed the receipt).
6. The **recipient's** signature on issuance is a different party (the customer)
   and is unchanged.

## Data model

- `User.signatureImage String?` — the technician's saved signature
  (`data:image/png;base64,…`), nullable.
- `ReturnTransaction.processedBySignature String?` — the signature captured for
  that specific return, nullable (existing rows have none).
- **Migration:** one additive migration (two nullable columns). Applied to
  Supabase before push (standing deploy rule; **use `DIRECT_URL`/5432 — `migrate
  deploy` hangs through the 6543 pooler**).

## Validation — `src/lib/signature.ts` (pure)

- `MAX_SIGNATURE_LEN = 250_000`
- `signatureError(s: string): string | null` — returns an error message or null:
  empty → "A signature is required."; not `data:image/png;base64,` prefixed →
  "Invalid signature format."; longer than `MAX_SIGNATURE_LEN` → "Signature image
  is too large." Used by both the account action and the return action.

## Saved signatures — service + account UI

- `updateUserSignature(id: string, signature: string | null): Promise<void>` in
  `users.service.ts` — sets/clears `User.signatureImage`.
- `saveSignatureAction` in `src/app/actions/account.ts` (`requireUser`): parse a
  `signature` field; `""`/absent → clear; otherwise validate via
  `signatureError` and store. Generic error + `console.error` on unexpected
  failure.
- Account page (`src/app/account/page.tsx`): load the current user's
  `signatureImage`; add a **"Signature"** card with a client `SignatureSettings`
  component — shows the saved signature (if any), a `SignaturePad` to set/replace
  it, a Save button, and a Remove button.

## Reusable signing field

- Extend `SignaturePad` (`src/components/SignaturePad.tsx`) — backward compatibly
  — with optional `value?: string`, `onChange?: (dataUrl: string) => void`, and
  make `name?` optional (still renders the hidden input when `name` is given, so
  the existing `receiverSignature` usage is unchanged). `onChange` fires on
  stroke-end and clear.
- New `src/components/TechnicianSignatureField.tsx` (client):
  props `{ name: string; saveOptName?: string; savedSignature?: string | null;
  onChange?: (value: string) => void }`.
  - If `savedSignature` is present: default to "Use my saved signature" (renders
    the saved image), with a radio toggle to "Draw a new one" (a `SignaturePad`).
  - If none: draw mode, plus (when `saveOptName` given) a checkbox "Save this
    signature to my profile for next time."
  - Owns a hidden input `name` carrying the effective value; calls `onChange`
    with the current value on mount and on every change so a parent can gate
    submit on signature presence.

## Return flow changes

- `ProcessReturnInput` gains `signature: string`; `processReturn` stores it as
  `processedBySignature` on the `ReturnTransaction`.
- `processReturnAction`: read `signature` and reject via `signatureError` (the
  third safeguard, alongside anti-blank + serial-verify); read a `saveSignature`
  checkbox and, when set with a valid signature, best-effort
  `updateUserSignature(admin.id, signature)`. Pass `signature` into
  `processReturn`.
- `ReturnForm`: render `TechnicianSignatureField` (`name="signature"`,
  `saveOptName="saveSignature"`, `savedSignature` from the server) and extend
  `canSubmit` to also require a non-empty signature. The return page passes the
  admin's `signatureImage` to the form.

## "CLOSED" banner + attestation block

- **Receipt page** (`src/app/receipts/[receiptNumber]/page.tsx`): rename the
  banner text to **"CLOSED"**; when closed, fetch the closing return and render,
  parallel to the banner, an **"Accepted by"** block — printed name, the drawn
  signature image, and the date (HST).
- **PDF** (`hand-receipt.ts`): rename the diagonal watermark to **"CLOSED"**;
  when `closedBy` is present, draw an "Accepted by (closed): name / signature /
  date" block on the form page near the watermark. `ReceiptData` gains
  `closedBy?: { name: string; signature: string; date: Date }`.
- **PDF route** (`pdf/route.ts`): when the receipt is CLOSED, fetch the closing
  return and pass `closedBy`.
- **Closing-return query:** `getClosingReturn(transferId)` in
  `returns.service.ts` → `prisma.returnTransaction.findFirst({ where: {
  transferId, kind: "FULL" }, orderBy: { createdAt: "desc" } })` (exactly one
  FULL return exists per closed receipt).

## Error handling / security

- Admin-only return flow unchanged; account signature is self-service
  (`requireUser`). Signature is validated (format + size) server-side in both
  actions. Prisma methods only; generic client errors + `console.error`.
- The signature `<img>` uses a `data:` URL (a plain `<img>`; add an eslint-disable
  for `@next/next/no-img-element` if the linter flags it).

## Testing

- **Unit `signature.ts`:** empty → required; bad prefix → invalid; over-length →
  too large; valid PNG data URL → null.
- **Service:** `updateUserSignature` sets and clears (real-DB or mocked, matching
  the module's existing test style). `processReturn` stores `processedBySignature`
  (extend the existing real-DB return tests to pass a signature and assert it
  persists).
- **Action:** `processReturnAction` rejects a missing/invalid signature.
- **Build/lint** for the UI-only pieces (field, account settings, page, PDF).

## Out of scope

- Signature on issuance by the DCSIM technician (only returns sign today).
- Multiple saved signatures per user (one is enough).
- Showing per-partial-return signatures in the audit table (the closing one is
  what appears on the closed receipt).
