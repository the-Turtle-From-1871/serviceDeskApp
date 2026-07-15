# Multiple Named Signatures (Admin) — Design

**Date:** 2026-07-15
**Status:** Approved (design), ready for implementation plan

## Summary

Let an ADMIN account store **several signatures, each with a name**, and pick which
one signs when processing a property return. The picked signature's name is
printed on the DA 2062 as the signer, so a shared service-desk account can record
**which technician actually signed** — instead of stamping every return with the
account holder's name.

Regular (non-admin) users keep exactly one saved signature, as today.

## The problem this solves

`returns.service.ts:78-80` writes:

```ts
processedByName: processedBy.name,
processedByEmail: processedBy.email,
processedBySignature: signature,
```

`processedByName` is the **logged-in account's** name, and `render.ts:43,57-59`
prints it (with the signature) onto the DA 2062. So when the service desk shares
one admin account, **every return is signed "Administrator"** regardless of who did
the work. Named signatures fix exactly that.

## Key decisions (resolved during brainstorming)

1. **The name IS the signer's identity** — not a label. Picking a signature sets
   the technician name printed on the DA 2062.
2. **Multiple named signatures are ADMIN-only.** This is not a special case: the
   only consumer of a saved signature is the returns flow, and
   `processReturnAction` is already `requireAdmin()`-guarded.
3. **Regular users keep exactly one saved signature** (`User.signatureImage`
   retained, `/account` unchanged for them).
4. **Existing saved signatures are discarded** — admins re-save as named ones.
5. **Ad-hoc drawing keeps today's behavior**: a freshly drawn signature is
   attributed to the account holder's own name.
6. **A non-admin's saved signature stays wired to nothing** — deliberately. It was
   already consumed nowhere, and prefilling a recipient's signature without them
   drawing it in person would weaken the "they signed for it" evidence on a DA
   2062. Kept as a save-only capability; see *Known no-op* below.
7. **Signatures stay PNG data URLs in the database.** Measured against production:
   avg receipt signature **6 KB**, largest ever **8.7 KB**, avg saved user
   signature **13 KB**, whole DB **11 MB** (Supabase free tier: 500 MB). 100 named
   signatures ≈ 1 MB — under 1% of current usage. No object storage, no vector
   rewrite, no change to PDF rendering.

## Current state (verified)

- `User.signatureImage String?` — one signature per account, a PNG data URL.
- `/account` → `SignatureSettings` (any user): draw / replace / remove one.
- `TechnicianSignatureField` — used in **exactly one place**:
  `ReturnForm.tsx:81`. Offers "use my saved signature" vs "draw a new one", with an
  optional `saveSignature` checkbox that writes back to `User.signatureImage`
  (`app/actions/returns.ts:34,45`).
- `return/page.tsx:22` loads the admin's `signatureImage` and passes it in.
- `processReturnAction` (`app/actions/returns.ts:18`) → `requireAdmin()`.
- `lib/signature.ts` → `signatureError(raw)` validates a signature data URL.
- `transfers.schema.ts` → `MAX_SIGNATURE_BYTES = 5_000_000` (5 MB).

## Data model

```prisma
model Signature {
  id        String   @id @default(cuid())
  user      User     @relation("UserSignatures", fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  // The technician this signature belongs to. Printed on the DA 2062 as the
  // signer when this signature is chosen, so it is an identity, not a label.
  name      String
  image     String   // PNG data URL
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId])
}
```

- `User` gains `signatures Signature[] @relation("UserSignatures")`.
- **`User.signatureImage` is retained** for non-admin accounts.
- `@@unique([userId, name])` — one signature per technician name, per admin.

### Migration

Additive: `CREATE TABLE "Signature"` + index + FK. No column dropped.

Separately, a **data step discards superseded signatures**:
`UPDATE "User" SET "signatureImage" = NULL WHERE role = 'ADMIN'` — admins now use
named signatures, so their old single signature is inert. Non-admin rows are left
alone (they keep the single-signature model). Production currently has 2 users,
both ADMIN, exactly 1 with a saved signature.

Per [[live-hosting]]: `prisma migrate dev` cannot run in this environment — author
via `migrate diff --script` + `migrate deploy`, and apply to prod only as an
explicitly-confirmed step (out of scope for the implementation plan itself).

## Components

### A. Signatures module — `src/modules/signatures/`

- `signatures.schema.ts` — `newSignatureSchema`: `name` (trimmed, min 1),
  `image` (validated through the existing `signatureError` from `lib/signature.ts`
  — do not re-implement signature validation).
- `signatures.service.ts`:
  - `listSignatures(userId): Promise<{ id, name, image }[]>` — ordered by `name`.
  - `createSignature(userId, { name, image }): Promise<Signature>` — unique
    `(userId, name)`; a duplicate name is a domain error, not a 500.
  - `deleteSignature(id, userId): Promise<void>` — **scoped by `userId`** so one
    admin can never delete another's.
  - `getOwnedSignature(id, userId): Promise<{ name, image } | null>` — the
    authoritative lookup used when signing (see D).
- `signatures.errors.ts` — `SignatureError` with `"NOT_FOUND" | "DUPLICATE_NAME"`
  (mirrors `service-queue.errors.ts` / `items.errors.ts`).

### B. Actions — `src/app/actions/signatures.ts`

- `createSignatureAction`, `deleteSignatureAction` — **`requireAdmin()` first**;
  Zod-validate; pass `admin.id` as the owner (never a client-supplied userId);
  generic client errors + `console.error` server-side; `revalidatePath("/account")`.

### C. Account page — `src/app/account/`

- `page.tsx` branches on role: **admin** → new `SignatureManager`; **non-admin** →
  the existing `SignatureSettings`, unchanged.
- `SignatureManager.tsx` (new, client): lists saved signatures (name + preview),
  an add form (name + `SignaturePad`), and a delete button per row. Add/delete
  only — renaming is out of scope.

### D. Returns flow — sign as the technician who did the work

**The security-relevant design point:** the form posts a **`signatureId`**, never
the name or image of a saved signature. The server resolves it via
`getOwnedSignature(signatureId, admin.id)` and takes the name **and** image from
the database row. This means a client cannot forge a signer name, cannot inject an
arbitrary image, and cannot use another admin's signature.

- `TechnicianSignatureField`: its `savedSignature?: string | null` prop is
  **replaced** by `signatures: { id, name, image }[]`, and its saved/draw radio
  pair becomes a **select of names** plus a "Draw a new one" option. Choosing a
  saved one posts `signatureId`; drawing posts the image in the existing hidden
  field. The image preview is client-side only.
- Its `saveOptName` prop and the "save this signature to my profile" checkbox are
  **removed outright** — saving now requires a name and belongs on `/account`.
  Nothing else renders this component (`ReturnForm` is its only consumer, and that
  page is admin-only), so no other caller regresses.
- `return/page.tsx` loads `listSignatures(admin.id)` instead of `signatureImage`.
- `processReturnAction` / `processReturn`:
  - `signatureId` present → look it up scoped to `admin.id`; use its `image` as
    `processedBySignature` and its `name` as `processedByName`.
  - otherwise (ad-hoc drawn) → validate the drawn image via `signatureError`; use
    `admin.name` as `processedByName` (today's behavior).
  - **`processedByUserId` always remains the real admin account**, and
    `processedByEmail` remains the account's email. The DA 2062 shows *who signed*;
    the audit trail keeps *who did it*. These are deliberately allowed to differ.
- `returns.ts:34,45`'s `saveSignature` write-back to `User.signatureImage` is
  removed (superseded by `/account`).

### E. PDF

No change. `render.ts` already reads `processedByName` / `processedBySignature`.

## Testing

- **Real-DB integration** (this repo's `src/modules/**` convention:
  `migrateTestDb()` + `resetDb()` + real `@/lib/prisma` — NOT `vi.mock`):
  `createSignature` / `listSignatures` ordering / `deleteSignature`; duplicate
  `(userId, name)` → `DUPLICATE_NAME`; `deleteSignature` and `getOwnedSignature`
  refuse another user's row.
- **Returns:** choosing a signature sets `processedByName` to that signature's name
  while `processedByUserId` stays the admin; an ad-hoc drawn signature falls back
  to the admin's name; a `signatureId` belonging to another admin is rejected.
- **Pure:** `newSignatureSchema`.
- No React component tests (no jsdom/testing-library; no new packages).

## Known no-op (deliberate)

A non-admin's saved signature is consumed by nothing — `TechnicianSignatureField`'s
only consumer is the admin-only returns flow. It is kept as a save-only capability
by explicit decision (see decision 6). Do not "fix" this by prefilling a recipient
signature: a signature applied without the recipient drawing it in person weakens
the DA 2062's evidentiary value.

## Out of scope

- Wiring non-admin signatures into any flow.
- Renaming an existing signature (add/delete only).
- Tightening `MAX_SIGNATURE_BYTES` from 5 MB to ~100 KB. This is the *actual*
  storage exposure (~800× larger than any real signature) and is worth a
  follow-up, but it touches receipt validation and is unrelated to named
  signatures.
- Multiple named signatures for non-admin accounts.
- Applying the migration to production (separate, explicitly-confirmed step).
