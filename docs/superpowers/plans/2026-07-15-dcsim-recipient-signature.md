# DCSIM Recipient Signature Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the recipient of a new hand receipt is DCSIM, let the user pick one of their saved named signatures instead of drawing one — and take the recipient's name from that signature.

**Architecture:** Reuse the existing `TechnicianSignatureField` (three new props, all defaulting to today's behavior so `ReturnForm` is untouched). The receipt builder lifts both parties' DCSIM flags into `ReceiptBuilderForm` so the signature fieldset can react to the recipient's. The form posts only a `signatureId`; `createReceiptAction` resolves the name and image from the DB **before** `receiptSchema.safeParse`, so the schema needs no change.

**Tech Stack:** Next.js 16 (App Router, RSC, Server Actions), React 19, TypeScript 5, Prisma 7, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-dcsim-recipient-signature-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Auth first.** Server Actions call `requireUser()` before anything else. The owner id used for lookups is **`user.id` from the session — NEVER from `formData`**.
- **Never trust the client for the signer's identity.** A picked signature posts only `signatureId`. The name and image come from `getOwnedSignature(signatureId, user.id)`. A posted `receiverName` / `receiverSignature` must be **overwritten**, not merged or preferred.
- **A `signatureId` is valid ONLY when `receiver.isDcsim` is true.** Reject otherwise, server-side. The UI hiding the picker is not the guard. (CLAUDE.md DCSIM rule: hide in UI, reject in backend. Mirrors `notifyPickupAction` at `src/app/actions/receipts.ts:105`.)
- **`ReturnForm.tsx` must not change.** All three new `TechnicianSignatureField` props default to today's values. If a task needs to edit `ReturnForm`, something is wrong — stop and report.
- **No schema or migration change in this plan.** `Signature` and `getOwnedSignature` already exist.
- Server Actions return generic client errors and `console.error`/`console.warn` details server-side.
- **No React component tests.** This repo has no jsdom/testing-library and adding one is out of scope. Action tests mock the service layer — follow `src/app/actions/returns.test.ts` exactly.
- **Do not install any package.**
- Verify with: `npm test` (whole suite), `npm run lint` (0 errors; 19 pre-existing warnings in unrelated `*email*.test.ts` / `authz.test.ts` files are expected), `npm run build`.

## File Structure

| File | Responsibility |
|---|---|
| `src/components/TechnicianSignatureField.tsx` (modify) | The pick-or-draw control. Gains `label`, `drawHint`, `onPickedChange`. |
| `src/app/actions/receipts.ts` (modify) | `createReceiptAction` resolves `signatureId` → name + image, guarded to DCSIM recipients. |
| `src/app/actions/receipts.test.ts` (create) | The security tests for that resolution. |
| `src/app/receipts/new/ReceiptBuilderForm.tsx` (modify) | Lifts both DCSIM flags; swaps the signature fieldset on the recipient's. |
| `src/app/receipts/new/page.tsx` (modify) | Loads the acting user's signatures and passes them down. |

---

### Task 1: `TechnicianSignatureField` — parameterize copy, report the pick

**Files:**
- Modify: `src/components/TechnicianSignatureField.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TechnicianSignatureField` accepting `label?: string`, `drawHint?: string | null`, `onPickedChange?: (pickedId: string | null) => void`, in addition to today's `name`, `signatures`, `onChange`. Exports `PickableSignature` unchanged.

**Context:** Its only consumer today is `ReturnForm.tsx:81`, which passes `name` + `signatures` + `onChange`. Task 3 adds a second consumer that needs different copy and needs to know *whether a saved signature is picked* (to hide its own name field).

**Why `onPickedChange` rather than reusing `onChange`:** `onChange` reports the image *value*, which is non-empty for **both** a picked and a drawn signature. It cannot express "a saved signature is picked", which is what Task 3 branches on.

**Why it reports an `id` (a string) and not the object:** a primitive keeps the effect dependency stable. Reporting the found object would make the effect fire whenever the parent re-created its `signatures` array, and if the callback set parent state that would loop. (This deviates from the spec's `{ id, name } | null` — the parent only needs to know *whether* something is picked, so the narrower primitive is both safer and sufficient.)

- [ ] **Step 1: Replace the file's component with the parameterized version**

```tsx
"use client";
import { useEffect, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

export type PickableSignature = { id: string; name: string; image: string };

// Sentinel for the "draw a new one" option — distinct from the unselected
// placeholder (which is value=""), so the two are never confused. Real
// signature ids never collide with this.
const DRAW_NEW = "__draw__";

const DEFAULT_DRAW_HINT = "This will be recorded under your own name.";

// Signature picking control. The user picks WHICH person signed from their saved
// named signatures, or draws an ad-hoc one.
//
// A saved pick posts only `signatureId` — never the name or the image. The
// server re-reads both from the DB scoped to the acting user, so a client
// cannot forge a signer name, inject an image, or use another user's
// signature. The image here is preview-only.
//
// Nothing is preselected: the user must actively pick who signed (or choose to
// draw one) before either hidden input renders, so the form cannot be submitted
// attributed to whoever happens to sort first alphabetically.
//
// `drawHint` is a default PARAMETER, not `?? DEFAULT_DRAW_HINT`: a caller passes
// null to render no hint at all, and `??` would resurrect the default for it.
export function TechnicianSignatureField({
  name, signatures, onChange, onPickedChange,
  label = "Who signed?",
  drawHint = DEFAULT_DRAW_HINT,
}: {
  name: string;
  signatures: PickableSignature[];
  onChange?: (value: string) => void;
  onPickedChange?: (pickedId: string | null) => void;
  label?: string;
  drawHint?: string | null;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [drawn, setDrawn] = useState("");
  const picked = signatures.find((s) => s.id === selectedId);
  // No saved signatures at all: keep the original behavior of showing the pad
  // immediately. Otherwise only draw once the user explicitly chose to.
  const drawing = signatures.length === 0 || selectedId === DRAW_NEW;
  // Reported upward only so the parent can gate submit; not what gets posted.
  const value = picked ? picked.image : drawing ? drawn : "";
  const pickedId = picked?.id ?? null;

  useEffect(() => { onChange?.(value); }, [value, onChange]);
  useEffect(() => { onPickedChange?.(pickedId); }, [pickedId, onPickedChange]);

  return (
    <div className="stack-sm">
      {signatures.length > 0 && (
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>{label}</span>
          <select
            className="select"
            style={{ width: "auto", minWidth: 180 }}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <option value="" disabled>— Select who signed —</option>
            {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value={DRAW_NEW}>Draw a new one…</option>
          </select>
        </label>
      )}

      {picked && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picked.image} alt={`Signature for ${picked.name}`} className="sig-preview" />
          <input type="hidden" name="signatureId" value={picked.id} />
        </>
      )}
      {drawing && (
        <>
          <SignaturePad onChange={setDrawn} />
          {drawHint && <p className="subtle">{drawHint}</p>}
          <input type="hidden" name={name} value={drawn} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Confirm `ReturnForm` still compiles unchanged and the suite is green**

Run: `npx tsc --noEmit` then `npm test`
Expected: no type errors; 291 passed. `ReturnForm.tsx` must appear in **no** diff.

- [ ] **Step 3: Commit**

```bash
git add src/components/TechnicianSignatureField.tsx
git commit -m "feat(signatures): parameterize TechnicianSignatureField copy + report the pick"
```

---

### Task 2: `createReceiptAction` — resolve a picked signature, DCSIM-guarded

**Files:**
- Modify: `src/app/actions/receipts.ts`
- Test: `src/app/actions/receipts.test.ts` (create)

**Interfaces:**
- Consumes: `getOwnedSignature(id, userId): Promise<{ name: string; image: string } | null>` from `@/modules/signatures/signatures.service`.
- Produces: `createReceiptAction` accepting an optional `signatureId` form field.

**Context:** `parseReceiptForm(fd)` (`src/app/actions/receipts.parse.ts:16`) returns a **plain mutable object** `{ itemIds, lines, sender, receiver, receiverSignature }` before any validation. That is the seam: mutate it, then let `receiptSchema.safeParse` see a normal name + PNG data URL. **Do not change `receiptSchema` or `parseReceiptForm`.**

This is the security core of the feature. Write the tests first.

- [ ] **Step 1: Write the failing tests**

Create `src/app/actions/receipts.test.ts`. Model it on `src/app/actions/returns.test.ts` — mock the service layer, assert on what the action passes down.

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const getOwnedSignature = vi.fn();
const createTransfer = vi.fn();
const getTransferByReceiptNumber = vi.fn();
const sendReceiptEmails = vi.fn();
const renderReceiptPdf = vi.fn();
const upsertServiceRequest = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/signatures/signatures.service", () => ({
  getOwnedSignature: (id: string, userId: string) => getOwnedSignature(id, userId),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  createTransfer: (input: unknown) => createTransfer(input),
  getTransferByReceiptNumber: (n: string) => getTransferByReceiptNumber(n),
}));
vi.mock("@/modules/receipts/send-receipt-email", () => ({
  sendReceiptEmails: (args: unknown) => sendReceiptEmails(args),
}));
vi.mock("@/modules/receipts/render", () => ({
  renderReceiptPdf: (n: string) => renderReceiptPdf(n),
}));
vi.mock("@/modules/service-queue/service-queue.service", () => ({
  upsertServiceRequest: (input: unknown) => upsertServiceRequest(input),
}));
vi.mock("@/modules/items/qr", () => ({
  receiptUrl: (n: string) => `https://example.test/receipts/${n}`,
}));

import { createReceiptAction } from "./receipts";

const USER = { id: "user-1", role: "ADMIN" as const, name: "Admin Actor", email: "admin@x.mil" };
const SAVED_SIG = "data:image/png;base64,SAVED";
const DRAWN_SIG = "data:image/png;base64,DRAWN";

/** A minimal valid receipt form. `receiver.*` is overridden per test. */
function makeFormData(extra: Record<string, string>) {
  const fd = new FormData();
  fd.set("itemId", "item-1");
  fd.set("line[0][make]", "Dell");
  fd.set("line[0][model]", "5540");
  fd.set("line[0][qtyAuth]", "1");
  fd.set("line[0][qtyIssued]", "1");
  fd.set("senderName", "Jane");
  fd.set("senderRank", "SGT");
  fd.set("senderUnit", "A Co");
  fd.set("senderContact", "808");
  fd.set("senderEmail", "jane@u.mil");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue(USER);
  createTransfer.mockResolvedValue({ id: "t-1", receiptNumber: "HR-000001" });
  getTransferByReceiptNumber.mockResolvedValue({ receiptNumber: "HR-000001", lines: [] });
  renderReceiptPdf.mockResolvedValue(undefined);
  sendReceiptEmails.mockResolvedValue(undefined);
});

describe("createReceiptAction — DCSIM recipient signature", () => {
  it("resolves a picked signature's name and image from the DB, scoped to the acting user", async () => {
    getOwnedSignature.mockResolvedValue({ name: "SGT Alvarez", image: SAVED_SIG });
    const fd = makeFormData({ receiverIsDcsim: "on", signatureId: "sig-1" });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(getOwnedSignature).toHaveBeenCalledWith("sig-1", USER.id);
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverSignature: SAVED_SIG,
      receiver: expect.objectContaining({ isDcsim: true, name: "SGT Alvarez" }),
    }));
  });

  it("forgery attempt: a forged receiverName and receiverSignature posted alongside a valid signatureId are both ignored", async () => {
    getOwnedSignature.mockResolvedValue({ name: "SGT Alvarez", image: SAVED_SIG });
    const fd = makeFormData({
      receiverIsDcsim: "on",
      signatureId: "sig-1",
      receiverName: "Somebody Else",
      receiverSignature: "data:image/png;base64,FORGED",
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    const arg = createTransfer.mock.calls[0][0] as { receiverSignature: string; receiver: { name: string } };
    expect(arg.receiverSignature).toBe(SAVED_SIG);
    expect(arg.receiver.name).toBe("SGT Alvarez");
  });

  it("rejects a signatureId when the recipient is NOT DCSIM, and creates nothing", async () => {
    const fd = makeFormData({
      signatureId: "sig-1",
      receiverName: "Jane Doe",
      receiverRank: "SGT",
      receiverUnit: "B Co",
      receiverContact: "808",
      receiverEmail: "jd@u.mil",
      receiverSignature: DRAWN_SIG,
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ error: "A saved signature can only be used when the recipient is DCSIM." });
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("rejects a bogus or another user's signatureId, and creates nothing", async () => {
    getOwnedSignature.mockResolvedValue(null);
    const fd = makeFormData({ receiverIsDcsim: "on", signatureId: "not-mine" });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ error: "That signature is no longer available. Pick another or draw one." });
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it("without a signatureId, a drawn signature and typed DCSIM name still work", async () => {
    const fd = makeFormData({
      receiverIsDcsim: "on",
      receiverName: "DCSIM Tech",
      receiverSignature: DRAWN_SIG,
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverSignature: DRAWN_SIG,
      receiver: expect.objectContaining({ isDcsim: true, name: "DCSIM Tech" }),
    }));
  });

  it("without a signatureId, an ordinary non-DCSIM recipient is unaffected", async () => {
    const fd = makeFormData({
      receiverName: "Jane Doe",
      receiverRank: "SGT",
      receiverUnit: "B Co",
      receiverContact: "808",
      receiverEmail: "jd@u.mil",
      receiverSignature: DRAWN_SIG,
    });

    const res = await createReceiptAction(undefined, fd);

    expect(res).toEqual({ receiptNumber: "HR-000001" });
    expect(getOwnedSignature).not.toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverSignature: DRAWN_SIG,
      receiver: expect.objectContaining({ isDcsim: false, name: "Jane Doe" }),
    }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/actions/receipts.test.ts`
Expected: FAIL. The `signatureId` cases fail because nothing reads that field yet (the DCSIM-recipient cases fail `receiptSchema` on the missing signature; the non-DCSIM rejection returns a receiptNumber instead of the error).

- [ ] **Step 3: Add the resolve step to `createReceiptAction`**

In `src/app/actions/receipts.ts`, add the import:

```ts
import { getOwnedSignature } from "@/modules/signatures/signatures.service";
```

Then, inside `createReceiptAction`, insert between `const raw = parseReceiptForm(formData);` and `const parsed = receiptSchema.safeParse(raw);`:

```ts
  // A picked saved signature posts ONLY its id. Resolve the signer's name and
  // image from the DB, scoped to the acting user, and overwrite whatever the
  // client posted for them — so a crafted POST can forge neither the name
  // printed on the DA 2062 nor the ink under it, and cannot borrow another
  // user's signature. Runs BEFORE safeParse so receiptSchema still sees a
  // normal name + PNG data URL and needs no change.
  const signatureId = String(formData.get("signatureId") ?? "").trim();
  if (signatureId) {
    // DCSIM-only, enforced here and not merely hidden in the UI: a saved
    // signature must never land on an outside recipient, who has to sign in
    // person. Mirrors notifyPickupAction's guard below.
    if (!raw.receiver.isDcsim) {
      console.warn("[createReceiptAction] rejected signatureId on a non-DCSIM recipient");
      return { error: "A saved signature can only be used when the recipient is DCSIM." };
    }
    const owned = await getOwnedSignature(signatureId, user.id);
    if (!owned) return { error: "That signature is no longer available. Pick another or draw one." };
    raw.receiver.name = owned.name;
    raw.receiverSignature = owned.image;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/actions/receipts.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: 297 passed (291 existing + 6 new).

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/receipts.ts src/app/actions/receipts.test.ts
git commit -m "feat(receipts): resolve a picked DCSIM signature server-side"
```

---

### Task 3: Receipt builder — show the picker for a DCSIM recipient

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx`
- Modify: `src/app/receipts/new/page.tsx`

**Interfaces:**
- Consumes: `TechnicianSignatureField` with `label`, `drawHint`, `onPickedChange` (Task 1); `createReceiptAction`'s `signatureId` field (Task 2); `listSignatures(userId)` from `@/modules/signatures/signatures.service`.
- Produces: nothing downstream.

**Context:** `PartyFields` currently owns `isDcsim` in local state, and the signature fieldset is its **sibling** — so the fieldset cannot see the recipient's flag. Both parties' flags lift to `ReceiptBuilderForm`. The sender's doesn't strictly need to, but one ownership rule beats one controlled party and one uncontrolled one.

`/receipts/new` is `requireUser()`, and named signatures are admin-only, so a non-admin gets `[]` — and `TechnicianSignatureField` already renders the pad immediately for that case. That is the intended fallback; do not special-case it.

- [ ] **Step 1: Make `PartyFields` controlled and name-hideable**

Replace `PartyFields` in `src/app/receipts/new/ReceiptBuilderForm.tsx`:

```tsx
function PartyFields({ role, prefill, isDcsim, onIsDcsimChange, hideName }: {
  role: "sender" | "receiver";
  prefill?: Prefill;
  isDcsim: boolean;
  onIsDcsimChange: (v: boolean) => void;
  hideName?: boolean;
}) {
  const cap = role === "sender" ? "Sender" : "Recipient";
  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => onIsDcsimChange(e.target.checked)} />
        This side is DCSIM
      </label>
      {/* Hidden while a saved signature is picked: the name is taken from that
          signature server-side, so an editable field here could only disagree
          with the ink. Not rendered (rather than disabled) so nothing posts. */}
      {!hideName && (
        <div className="field">
          <label className="label">{isDcsim ? "DCSIM technician name" : "Name"}</label>
          <input className="input" name={`${role}Name`} defaultValue={prefill?.name ?? ""} required />
        </div>
      )}
      {!isDcsim && (
        <div className="form-grid">
          <div className="field"><label className="label">Rank</label><input className="input" name={`${role}Rank`} defaultValue={prefill?.rank ?? ""} required /></div>
          <div className="field"><label className="label">Unit</label><input className="input" name={`${role}Unit`} defaultValue={prefill?.unit ?? ""} required /></div>
          <div className="field"><label className="label">Contact number</label><PhoneInput name={`${role}Contact`} defaultValue={prefill?.contact} required /></div>
          <div className="field"><label className="label">Email</label><input className="input" type="email" name={`${role}Email`} defaultValue={prefill?.email ?? ""} required /></div>
        </div>
      )}
    </fieldset>
  );
}
```

- [ ] **Step 2: Wire the state and the picker into `ReceiptBuilderForm`**

Update the imports at the top of the same file:

```tsx
import { SignaturePad } from "@/components/SignaturePad";
import { TechnicianSignatureField, type PickableSignature } from "@/components/TechnicianSignatureField";
```

Change the signature of `ReceiptBuilderForm` and add the state (keep everything else in the function as-is):

```tsx
export function ReceiptBuilderForm({ itemIds, lines, senderPrefill, signatures }: { itemIds: string[]; lines: BuilderLine[]; senderPrefill?: Prefill; signatures: PickableSignature[] }) {
  const [state, action, pending] = useActionState(createReceiptAction, undefined);
  const [senderIsDcsim, setSenderIsDcsim] = useState(senderPrefill?.isDcsim ?? false);
  const [receiverIsDcsim, setReceiverIsDcsim] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const receipt = state && "receiptNumber" in state ? state.receiptNumber : undefined;

  // Clearing the pick here is load-bearing, not hygiene. TechnicianSignatureField
  // UNMOUNTS when DCSIM is unchecked, so it never reports null on the way out.
  // Without this, pick -> uncheck -> recheck remounts it with a fresh selection
  // (posting no signatureId) while a stale pickedId keeps the name field hidden,
  // and the form posts an empty receiverName that fails validation with no
  // visible field to fix.
  const onReceiverDcsimChange = (v: boolean) => {
    setReceiverIsDcsim(v);
    if (!v) setPickedId(null);
  };
  const hideReceiverName = receiverIsDcsim && pickedId !== null;
```

Then replace the two `PartyFields` lines and the signature fieldset:

```tsx
      <PartyFields role="sender" prefill={senderPrefill} isDcsim={senderIsDcsim} onIsDcsimChange={setSenderIsDcsim} />
      <PartyFields role="receiver" isDcsim={receiverIsDcsim} onIsDcsimChange={onReceiverDcsimChange} hideName={hideReceiverName} />
      <fieldset className="card stack-sm">
        <legend className="card__title">Recipient signature{receiverIsDcsim ? " (DCSIM)" : ""}</legend>
        {receiverIsDcsim ? (
          // A DCSIM recipient is our own technician at the desk, so they may pick
          // their saved signature. An outside recipient must always draw in person.
          <TechnicianSignatureField
            name="receiverSignature"
            signatures={signatures}
            label="Who received it?"
            drawHint={null}
            onPickedChange={setPickedId}
          />
        ) : (
          <SignaturePad name="receiverSignature" />
        )}
      </fieldset>
```

- [ ] **Step 3: Load the signatures in `page.tsx`**

In `src/app/receipts/new/page.tsx`, add the import:

```tsx
import { listSignatures } from "@/modules/signatures/signatures.service";
```

Capture the session user (the call currently discards its result) — change:

```tsx
  await requireUser();
```

to:

```tsx
  const user = await requireUser();
```

Load the signatures alongside the existing `lastReceivers` fetch — change:

```tsx
  const lastReceivers = await Promise.all(loaded.map((i) => getLastReceiver(i.id)));
```

to:

```tsx
  // A non-admin has none (named signatures are admin-only), which renders the
  // pad — the intended fallback.
  const [signatures, lastReceivers] = await Promise.all([
    listSignatures(user.id),
    Promise.all(loaded.map((i) => getLastReceiver(i.id))),
  ]);
```

And pass it to the form — add `signatures={signatures}` to the `<ReceiptBuilderForm ... />` props:

```tsx
          <ReceiptBuilderForm
            itemIds={loaded.map((i) => i.id)}
            lines={lines.map((l) => ({
              make: l.make,
              model: l.model,
              defaultQty: l.defaultQty,
              items: l.serials.map((serialNumber, k) => ({ serialNumber, itemId: l.itemIds[k] })),
            }))}
            senderPrefill={senderPrefill}
            signatures={signatures}
          />
```

- [ ] **Step 4: Verify types, tests, lint, and build**

Run: `npx tsc --noEmit && npm test && npm run lint && npm run build`
Expected: no type errors; 297 passed; 0 lint errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx src/app/receipts/new/page.tsx
git commit -m "feat(receipts): pick a saved signature when the recipient is DCSIM"
```
