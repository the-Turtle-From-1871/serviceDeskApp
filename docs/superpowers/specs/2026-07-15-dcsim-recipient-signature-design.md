# DCSIM Recipient Signature Picker — Design

**Date:** 2026-07-15
**Status:** Approved (design), ready for implementation plan

## Summary

When the **recipient of a new hand receipt is DCSIM**, let the user pick one of
their saved named signatures — the same control the return flow already offers —
instead of drawing one by hand. The picked signature's name becomes the
recipient's name on the DA 2062.

Every other recipient case is unchanged: an outside recipient still draws their
signature in person, every time.

## The problem this solves

A DCSIM-recipient hand receipt is a **turn-in**: property is coming back to the
service desk, and the DCSIM technician receiving it is the person at the desk
operating the app. That is the same person, in the same posture, as the return
flow — which already lets them pick which technician signed
([[2026-07-15-named-signatures-design]]).

Today `ReceiptBuilderForm.tsx:148` renders an unconditional
`<SignaturePad name="receiverSignature" />`, so that technician must re-draw
their signature on every turn-in, and the printed name comes from a free-text
field that nothing ties to the ink.

## Relationship to the named-signatures spec's decision 6

[[2026-07-15-named-signatures-design]] decision 6 says:

> Do not "fix" this by prefilling a recipient signature: a signature applied
> without the recipient drawing it in person weakens the DA 2062's evidentiary
> value.

**That decision stands, and this change does not cross it.** It protects the
*outside* recipient — a soldier signing for property they are taking. This change
adds the picker **only when the recipient is DCSIM**, i.e. our own technician
signing on their own screen. When the recipient is not DCSIM (the common case:
DCSIM issuing property out), the pad is the only option, exactly as today.

Both specs are consistent on the underlying rule: **a signature may be picked only
by the person it belongs to, for themselves.**

## Key decisions

1. **The signature's name wins.** Picking a signature sets the recipient's name
   from the `Signature` row server-side. The technician-name field is hidden while
   a signature is picked, so the printed name and the ink can never disagree.
   Mirrors decision 1 of [[2026-07-15-named-signatures-design]]: the name is an
   identity, not a label.
2. **DCSIM-only, enforced on both ends.** The picker renders only when the
   recipient DCSIM box is checked, and the server **rejects a `signatureId` on a
   non-DCSIM recipient**. This mirrors `notifyPickupAction`
   (`app/actions/receipts.ts:105`) and satisfies the CLAUDE.md DCSIM rule: UI
   hides, backend rejects.
3. **Drawing stays available.** A DCSIM technician with no saved signature — or
   one who just wants to draw — picks "Draw a new one…", which restores the
   technician-name field and the pad. Requiring pre-registration would block
   receipt creation.
4. **Non-admins are unchanged.** Named signatures are admin-only, and
   `/receipts/new` is `requireUser()`, so a regular user has none.
   `TechnicianSignatureField` already degrades correctly (`signatures.length === 0`
   → pad immediately). This does **not** wire in the non-admin
   `User.signatureImage`; it stays the deliberate no-op decision 6 describes.
5. **Reuse `TechnicianSignatureField`, don't fork it.** It is already generic
   except for two strings. A second copy of a security-sensitive pattern would
   have to stay in sync forever.
6. **Resolve before validating.** The action swaps in the name and image *before*
   `receiptSchema.safeParse`, so the schema is untouched and still sees a normal
   name + PNG data URL.

## Current state (verified)

- `ReceiptBuilderForm.tsx:148` — `<SignaturePad name="receiverSignature" />`,
  unconditional, in a sibling fieldset to `PartyFields`.
- `PartyFields` (`ReceiptBuilderForm.tsx:12`) owns `isDcsim` in **local** state
  (`useState(prefill?.isDcsim ?? false)`) and renders the name input, labeled
  **"DCSIM technician name"** when checked.
- `parseReceiptForm` (`actions/receipts.parse.ts:16`) returns a **plain mutable
  object** — `{ itemIds, lines, sender, receiver, receiverSignature }` — before
  any validation. This is the seam the resolve step uses.
- `receiptSchema` (`transfers.schema.ts:53`) requires `receiverSignature` to start
  with `SIGNATURE_PREFIX`, and `partySchema` requires `name` min 1. A DCSIM party
  needs *only* a name (`transfers.schema.ts:31`).
- `receiptSchema` already rejects sender+receiver both DCSIM
  (`transfers.schema.ts:65`).
- `getOwnedSignature(id, userId)` (`modules/signatures/signatures.service.ts:43`)
  → `{ name, image } | null`, scoped by `userId`.
- `createReceiptAction` (`actions/receipts.ts:15`) → `requireUser()` (not admin).
- `TechnicianSignatureField` (`components/TechnicianSignatureField.tsx`) — posts
  only `signatureId` for a picked signature; hardcodes that field name and the
  hint copy *"This will be recorded under your own name."*
- Its only consumer is `ReturnForm.tsx:81`.

## Components

### A. `TechnicianSignatureField` — three new props

All three default to today's behavior, so `ReturnForm` needs **no change**:

- `label?: string` — the select's prompt. Default `"Who signed?"`; the receipt
  form passes `"Who received it?"`.
- `drawHint?: string | null` — the copy under the pad. Default
  `"This will be recorded under your own name."`; the receipt form passes `null`
  (that sentence is false there — a drawn recipient signature takes the typed
  technician name, not the acting user's).
  **Implement as a default parameter** (`drawHint = "This will be recorded…"`) and
  render with `{drawHint && <p className="subtle">{drawHint}</p>}`. Do **not** use
  `drawHint ?? DEFAULT` — that would resurrect the default for the deliberate
  `null`, printing the wrong sentence on the receipt form. A default parameter
  applies to `undefined` only, which is exactly the intent.
- `onPickedChange?: (pickedId: string | null) => void` — fires with the picked
  signature's id, or `null` when the selection is cleared or "Draw a new one…" is
  chosen. A **primitive, not the object**: the parent only needs to know *whether*
  something is picked (the name comes from the DB server-side), and a primitive
  keeps the reporting effect's dependency stable. Reporting the found object would
  re-fire the effect whenever the parent re-created its `signatures` array, which
  loops if the callback sets parent state — which it does.

**Why `onPickedChange` is needed, and `onChange` is not enough:** the existing
`onChange` reports the image *value*, which is non-empty for both a picked **and**
a drawn signature. The receipt form must distinguish them — it hides the
technician-name field only when a signature is *picked*. `onChange` cannot express
that, so a second signal is required rather than overloading the first.

Nothing else changes. `signatureId` stays the hidden field name: the receipt form
posts exactly one signature, so there is no collision.

### B. `ReceiptBuilderForm` — lift both DCSIM flags

`PartyFields` becomes **fully controlled** on the DCSIM flag: it takes
`isDcsim: boolean` + `onIsDcsimChange: (v: boolean) => void` and drops its
`useState`. Both parties lift to `ReceiptBuilderForm` — the sender's flag doesn't
strictly need to, but a single ownership rule beats one controlled party and one
uncontrolled one. The sender initialises from `senderPrefill?.isDcsim ?? false`,
preserving today's prefill.

`PartyFields` also gains `hideName?: boolean`: when true, the name input is not
rendered (its value comes from the DB instead).

`ReceiptBuilderForm` holds `receiverIsDcsim` and `pickedSignature`, and derives:

```
hideName = receiverIsDcsim && pickedSignature !== null
```

The signature fieldset becomes:

- **receiver is DCSIM** → `<TechnicianSignatureField name="receiverSignature"
  signatures={signatures} label="Who received it?" drawHint={null}
  onPickedChange={setPickedSignature} />`, legend **"Recipient signature (DCSIM)"**.
- **otherwise** → `<SignaturePad name="receiverSignature" />`, exactly as today.

**Unchecking the receiver's DCSIM box MUST clear `pickedSignature`** — do it in the
same handler that sets the flag, not in an effect. This is load-bearing, not
hygiene: `TechnicianSignatureField` unmounts when DCSIM is unchecked, so it never
fires `onPickedChange(null)` on the way out. Without an explicit clear, the
pick → uncheck → **recheck** sequence remounts the field with a fresh
`selectedId: ""` (posting no `signatureId`) while the parent still holds a stale
`pickedSignature` — so `hideName` stays true, the name input never renders, and the
form posts an **empty `receiverName`**, failing on `partySchema`'s "Name is
required" with no visible field to fix it.

### C. `new/page.tsx` — load the signatures

`const signatures = await listSignatures(user.id)` (capture the `requireUser()`
result, which is currently discarded) and pass it to `ReceiptBuilderForm`. A
non-admin gets `[]`, which is the pad-only path.

### D. `createReceiptAction` — resolve, then validate

Inserted between `parseReceiptForm` and `receiptSchema.safeParse`:

```ts
const signatureId = String(formData.get("signatureId") ?? "").trim();
if (signatureId) {
  // DCSIM-only, enforced server-side: the UI hides the picker otherwise, and a
  // crafted POST must not be able to stamp a saved signature on an outside
  // recipient who never signed in person.
  if (!raw.receiver.isDcsim) {
    console.warn(`[createReceiptAction] rejected signatureId on non-DCSIM recipient`);
    return { error: "A saved signature can only be used when the recipient is DCSIM." };
  }
  const owned = await getOwnedSignature(signatureId, user.id);
  if (!owned) return { error: "That signature is no longer available. Pick another or draw one." };
  // From the DB, never the client: the posted receiverName/receiverSignature are
  // overwritten, so neither a forged name nor a forged image can survive.
  raw.receiver.name = owned.name;
  raw.receiverSignature = owned.image;
}
```

`user.id` comes from the existing `requireUser()` — never from form data. A
non-admin's id owns no `Signature` rows, so `getOwnedSignature` returns null and
the request fails closed.

### E. Downstream — no changes

`createTransfer`, `receiptSchema`, `sendReceiptEmails`, and the PDF renderer all
consume `parsed.data.receiver` / `receiverSignature` and see normal values.

## Testing

New `src/app/actions/receipts.test.ts`, mirroring the existing
`src/app/actions/returns.test.ts` (real-DB integration, `migrateTestDb()` +
`resetDb()`, no `vi.mock`):

- A picked signature on a DCSIM recipient → `receiverName` and
  `receiverSignature` both come from the `Signature` row.
- **A forged `receiverSignature` and `receiverName` posted alongside a valid
  `signatureId` are both ignored** — the DB values win. (The forgery test the
  named-signatures review demanded, applied to this path.)
- A `signatureId` with a **non-DCSIM** recipient → rejected, nothing created.
- A `signatureId` belonging to **another admin** → rejected, nothing created.
- No `signatureId` → drawn `receiverSignature` + typed `receiverName` still work
  (today's behavior, DCSIM and not).

No React component tests — this repo has no jsdom/testing-library, and adding one
is out of scope.

## Out of scope

- The **sender** signature: the form has none (`receiverSignature` is the only
  signature on a hand receipt).
- Wiring non-admin `User.signatureImage` into any flow (decision 4).
- Multiple named signatures for non-admin accounts.
- Tightening `MAX_SIGNATURE_BYTES` (5 MB) in `transfers.schema.ts`. Still the one
  real storage exposure (~570× the largest signature ever stored), still its own
  change. This spec does not widen it: a picked signature already passed
  `signatureError`'s 250 KB cap on the way in.
- Applying anything to production (no migration needed — this spec adds **no
  schema change**).
