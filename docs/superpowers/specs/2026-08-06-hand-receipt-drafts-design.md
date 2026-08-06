# Hand receipt drafts

**Date:** 2026-08-06
**Status:** Approved, not yet implemented
**Verified against:** `main` at `bacdf4a`

## Problem

The hand receipt builder is all-or-nothing. A technician opens `/receipts/new`,
scans devices, types both parties, sets quantities, flags service, and signs —
and until the moment "Create hand receipt" succeeds, none of it is saved
anywhere durable.

The only persistence today is `?items=` in the URL
(`ReceiptBuilderForm.tsx:274-277`), which survives a reload but carries the item
list and nothing else. Every typed field — sender, recipient, rank, unit, phone,
email, quantity overrides, return timer, per-item service selections — lives in
React state and dies with the tab.

That is a poor fit for how the desk actually works. A handoff gets interrupted:
the recipient is not at their desk, a serial will not scan, the customer has to
come back after lunch. The technician either holds the tab open for hours on a
phone that iOS is free to evict, or throws the work away and retypes it later.

## Goal

Let a technician save an in-progress hand receipt from the builder, see their
saved drafts in their account, and resume one where they left off.

## Non-goals

- **No auto-save.** Saving is an explicit act with an explicit button. A form
  that writes itself to the database on every keystroke creates rows nobody
  asked for and a privacy surface nobody reasoned about.
- **No stored signature.** See §1.
- **No sharing.** A draft is private to the technician who saved it (§6). This
  is deliberately unlike a filed receipt.
- **No change to the filed-receipt path.** `receiptSchema`, `createTransfer`,
  the DA 2062 renderer, the emails, and the service-queue enqueue are untouched.
  A draft that is never resumed has no effect on anything.
- **No draft for returns.** `/receipts/<n>/return` is a different, short form.
- **No offline support.** Saving requires a working connection, like every other
  write in this app.

---

## 1. The core mechanic: a second submit button on the same form

"Save draft" is **not** a parallel state-capture path. It is a second submit
button on the existing `<form>`:

```tsx
<button
  type="submit"
  formAction={saveDraft}
  formNoValidate
  className="btn btn-secondary spacer"
>
  Save draft
</button>
```

Two attributes do all the work:

- **`formAction={saveDraft}`** posts the *same* `FormData` the Create button
  would post, to a different Server Action. `formAction` on a `<button>` is a
  supported way to invoke a Server Action in this Next version — see
  `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:24`.
  Every field the builder already renders is therefore captured for free: the
  hidden `itemId` inputs, both parties' fields, `senderIsDcsim` /
  `receiverIsDcsim`, `line[i][make|model|qtyAuth|qtyIssued]`, `returnDays`, and
  every `service[<itemId>][needs|type|days|note]` key.
- **`formNoValidate`** skips HTML5 constraint validation. Without it the browser
  refuses to submit a form whose `required` recipient name is blank — which is
  the exact state a draft exists to capture.

**Why this and not lifting state up.** The alternative is to hoist the builder's
state into a serializable object and post that. It would create a second
definition of "what is on this receipt" that must be kept in step with the form
by hand. `ReceiptBuilderForm.tsx` already carries four separate comments about
fields that silently lost their values through remounts and form resets
(lines 40-44, 70-79, 145-156, 180-181); a hand-maintained mirror of the form is
the same bug class with a new surface. Reusing the browser's own serialization
means the draft cannot drift from what the form would submit, because it *is*
what the form would submit.

**The signature is never read.** `parseReceiptForm` already isolates it as
`receiverSignature`; `saveDraftAction` drops it on the floor and it is not part
of the payload schema. This is a rule, not an oversight:

- The builder already discards a drawn signature whenever the item list changes
  (`ReceiptBuilderForm.tsx:416-442`), because ink attests to a *specific* list.
  A signature persisted for days and restored onto a since-edited draft is that
  same defect with a much longer fuse.
- A signature is the legally meaningful part of a DA 2062. It belongs on a filed
  receipt, not in a mutable scratch record.

Resuming a draft therefore always requires signing again, and says so.

## 2. Data model

```prisma
model ReceiptDraft {
  id            String   @id @default(cuid())
  user          User     @relation("ReceiptDrafts", fields: [userId], references: [id], onDelete: Cascade)
  userId        String
  // Denormalized so the /account list never has to parse `payload`.
  recipientName String?
  itemCount     Int      @default(0)
  // The builder form's fields, minus the signature. Validated by
  // receiptDraftSchema on every write AND on every read.
  payload       Json
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([userId, updatedAt])  // the account list
  @@index([updatedAt])          // the purge sweep
}
```

`User` gains `receiptDrafts ReceiptDraft[] @relation("ReceiptDrafts")`.
`onDelete: Cascade` means the account purge worker already cleans these up.

**`payload` is validated on read as well as write.** A `Json` column is untyped
at the database level, and a payload written by an older deploy must not be able
to crash the builder. `getDraft` parses through the schema and treats a failure
as a corrupt draft — reported to the user, not thrown.

**Denormalized `recipientName` / `itemCount`** exist so `/account` can list
drafts without deserializing every payload. They are written from the payload on
each save, so they cannot drift.

## 3. Draft-lenient validation

New file `src/modules/receipts/drafts.schema.ts` — pure Zod, no `server-only`,
so it can be imported by both the action and any client-side code that needs the
type.

It is deliberately **separate from `receiptSchema`**, which requires a complete,
valid, filable receipt. `receiptDraftSchema` accepts blanks and partials, but
still bounds everything a client can write:

- every string capped (names/units/emails at the same lengths the receipt
  schema uses; the service note at its existing cap)
- `itemIds` capped at `MAX_RECEIPT_ROWS * MAX_ITEMS_PER_ROW`
- `lines` capped at `MAX_RECEIPT_ROWS`
- unknown keys stripped by `z.object()`

Without these caps, `payload` is an unbounded user-writable `Json` column.

**Per-user cap: 25 drafts.** Exceeding it is refused with a message ("You have
25 saved drafts — delete one before saving another"), not resolved by silently
pruning the oldest. Silent deletion of the technician's own work is worse than a
refusal they can act on.

## 4. Save, resume, and the two traps in resuming

### Save

`saveDraftAction(prev, formData)`:

1. `requireUser()`
2. `parseReceiptForm(formData)`, discard `receiverSignature`
3. `receiptDraftSchema.safeParse` → on failure, `{ error }`
4. read `draftId` from the form (hidden input, blank on a fresh builder)
5. blank → `create` (after the 25-draft cap check); present → `update` scoped
   `where: { id, userId }`, so a forged id cannot touch another user's row
6. return `{ draftId, savedAt }` so the button can render "Saved ✓" inline

The action returns state through its own `useActionState`, separate from the one
driving `createReceiptAction`. A failed draft save must never look like a failed
receipt creation.

### Resume

`/receipts/new?draft=<id>` — `page.tsx` branches before its existing `?items=`
path:

1. `getDraft(id, user.id)` — `notFound()` if missing or not theirs
2. resolve the payload's item ids, keep those that still exist and are `ACTIVE`
3. anything dropped is passed to the form as a warning naming the serial
4. if **nothing** survives, render a card saying so with a Delete button —
   never an empty builder
5. pass the payload as `draftValues` and the id as `draftId`

`ReceiptBuilderForm` seeds its state from `draftValues` when present, falling
back to today's `senderPrefill` behaviour otherwise, and renders two notices:
the dropped-items warning, and "Draft restored — please sign before filing."

### Trap 1: `replaceState` eats the draft binding

`ReceiptBuilderForm.tsx:274-277` rewrites the URL to `?items=…` on every change
to the item list. On a resumed draft that **drops `&draft=`**. The consequence
is not cosmetic: an iOS tab reload — the exact scenario that effect was written
to survive — would silently unbind the draft, and the next "Save draft" would
create a *second* draft instead of updating the first. The effect must preserve
the param when one is present.

### Trap 2: filing a receipt must delete its draft

The Create button carries `draftId` as a hidden input. After `createTransfer`
succeeds, `createReceiptAction` deletes the draft scoped to the acting user.

This is **best-effort**, in the same style as the existing email block
(`receipts.ts:97-108`): the receipt already exists and is authoritative, so a
failed cleanup is logged, never surfaced as a failed receipt. A stale draft is
harmless; a receipt that reports failure after being filed is not.

## 5. Where it appears

### The builder

The `<h1>New hand receipt</h1>` moves **into** `ReceiptBuilderForm`, inside a
`.row` header with the button carrying `.spacer` — the established
title-left/action-right idiom from `items/page.tsx:67-77`. The button must live
inside the `<form>` for `formAction` to apply, so the title comes to it.
`page.tsx` keeps a bare `<h1>` for its two "too many items" branches, which do
not render the form.

### The account page

A "Draft hand receipts" card on `/account`, alongside Signature and Change
password. Each row shows the auto-label — recipient name (or "No recipient
yet"), item count, and relative save time — with **Resume** and **Delete**.
Empty state: "No saved drafts."

There is no user-supplied name. The label is derived, so there is no extra field
to fill on a phone mid-scan.

**Delete uses an inline form button, not a `<dialog>`.** A draft is low-stakes
and recoverable by retyping, and the native-dialog trap documented in CLAUDE.md
(a layout class on `<dialog>` defeats `dialog:not([open])`) is not worth
courting for this.

### Mobile

- The header `.row` wraps, so the button drops below the title at narrow widths
  rather than crushing the heading.
- The button carries the 44px `--tap` floor.
- The account list is a stacked card list, not a table — it is 0-3 rows inside
  `container-narrow`.
- Per CLAUDE.md, this is verified in a real browser at 390px. `npm run build`
  and jsdom have no layout engine and are not evidence for any of it.

## 6. Authorization — a deliberate ownership exception

Every draft query is scoped `where: { id, userId: user.id }`, and both actions
begin with `requireUser()`.

**This departs from the repo's standing rule that authorization is role-based
and inventory/receipts/queue are shared org-wide.** The departure is
intentional: a filed receipt is a shared organizational record, but a
half-finished form is personal working state, and one technician resuming
another's partly-typed handoff is confusing at best. Drafts also hold party PII
— names, ranks, units, phone numbers, emails — with none of the signature that
makes a filed receipt a document.

Because it is an exception, it gets written down rather than left for the next
auditor to "correct":

- `docs/SECURITY.md` gains an entry for the draft surface, with its *Last
  reviewed* date bumped.
- `src/modules/receipts/drafts.service.ts` and `src/app/actions/drafts.ts` go on
  the watch list at the top of `scripts/check-security-docs.mjs`, so future
  changes to them cannot skip the doc.
- The CLAUDE.md authorization section records the exception and its reasoning.

The `Security docs current` CI job will otherwise block the PR, correctly.

## 7. Retention

`purgeStaleDrafts(now)` deletes drafts whose `updatedAt` is older than 30 days,
added as a fourth sweep to the existing nightly worker
(`src/app/api/cron/purge/route.ts`) alongside transfers, users, and the two
alert sweeps. It reports `deletedCount` in the same response shape and fails
independently of the others.

Thirty days rather than the receipts' 90: an abandoned draft is scratch work,
and its device list goes stale much faster than a filed record.

## 8. Files

| File | Change |
|---|---|
| `prisma/schema.prisma` | new `ReceiptDraft` model, `User` back-relation |
| `prisma/migrations/<ts>_add_receipt_draft/` | new migration |
| `src/modules/receipts/drafts.schema.ts` | **new** — lenient Zod + label formatter, pure |
| `src/modules/receipts/drafts.errors.ts` | **new** — `DraftError` (`TOO_MANY` \| `CORRUPT`) |
| `src/modules/receipts/drafts.form.ts` | **new** — pure `FormData` → payload; drops the signature. Separate from the action because a file-level `"use server"` makes every export an async Server Function |
| `src/modules/receipts/drafts.resume.ts` | **new** — pure `splitDraftItems`, decides what survived |
| `src/modules/receipts/drafts.service.ts` | **new** — `server-only`; save/list/get/delete/purge |
| `src/app/actions/drafts.ts` | **new** — `saveDraftAction`, `deleteDraftAction` |
| `src/app/receipts/new/ReceiptBuilderForm.tsx` | header row + button; `draftId`; seed from `draftValues`; notices; `replaceState` fix |
| `src/app/receipts/new/page.tsx` | `?draft=` branch, stale-item filtering |
| `src/app/actions/receipts.ts` | delete the draft after a receipt is filed |
| `src/app/account/page.tsx` | drafts card |
| `src/app/account/DraftList.tsx` | **new** — list + Resume/Delete |
| `src/app/api/cron/purge/route.ts` | fourth sweep |
| `scripts/check-security-docs.mjs` | two new watched files |
| `docs/SECURITY.md`, `CLAUDE.md`, `CHANGELOG.md` | same-commit doc updates |

## 9. Testing

**Integration (Vitest, DB-backed)**

- round-trip: save a payload, read it back unchanged
- **cross-user isolation**: user B cannot `getDraft`, `deleteDraft`, or
  overwrite user A's draft by posting its id
- update-vs-create: saving with a `draftId` updates in place; without one
  creates. Saving twice on a resumed draft leaves exactly one row
- the 25-draft cap refuses rather than pruning
- `purgeStaleDrafts` deletes past the cutoff and spares a draft inside it
- filing a receipt deletes its draft; a delete failure does not fail the receipt

**Unit**

- `receiptDraftSchema` accepts an empty form, strips unknown keys, and rejects
  over-long strings and over-large arrays
- a corrupt/legacy payload is reported, not thrown

**Component (jsdom)**

- the Save draft button renders in the header and carries `formNoValidate`
- a resumed draft renders the "please sign" notice and the dropped-item warning
- **the signature is never in the saved payload** — the invariant most likely to
  be broken later by someone adding a helpful restore

**Browser (required, not optional)**

- 390px: header wraps, button meets 44px, account list is readable
- the full loop: scan → save → close tab → resume from `/account` → sign → file
  → draft is gone from `/account`

## 10. Migration and deploy notes

- One new table, no changes to existing columns; nothing to backfill.
- **Migrate before the merge deploys.** `next build` never runs
  `migrate deploy`, so the Supabase migration must be applied before `main`
  deploys code that selects from `ReceiptDraft`.
- `prisma migrate dev` cannot run in this shell — author via
  `migrate diff --script` + `migrate deploy` (see the project memory note).
- The new table inherits RLS-enabled from the `rls_auto_enable` event trigger
  and must get **no** policy, like every other table.
- No new environment variables.
