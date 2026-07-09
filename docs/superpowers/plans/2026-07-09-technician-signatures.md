# Technician Signatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a required drawn technician signature on every return (saveable to the technician's profile and reusable with one click), show the closing technician's printed name + signature + date on the closed receipt and PDF, and rename the closed-out banner from "VOID / CLEARED" to "CLOSED".

**Architecture:** A nullable `User.signatureImage` holds a reusable saved signature managed on the Account page; a reusable `TechnicianSignatureField` lets a tech use their saved signature or draw a new one. The return flow requires a signature, stores it on the `ReturnTransaction` (`processedBySignature`), and the closing (FULL) return's block renders parallel to the "CLOSED" banner on the receipt page and in the PDF.

**Tech Stack:** Next.js 16 (App Router, React 19 Server Components + Server Actions), Prisma 7 + PostgreSQL/Supabase, `pdf-lib`, Vitest.

## Global Constraints

- Signatures are PNG **data URLs** (`data:image/png;base64,…`). Validate format + size server-side (`signatureError`, `MAX_SIGNATURE_LEN = 250000`).
- A technician signature is **required on every return** (partial and full) — the third submit safeguard alongside anti-blank (≥1 serial) and the serial-verify checkbox.
- Banner text is exactly **"CLOSED"** (replacing "VOID / CLEARED") on both the web receipt-page banner and the diagonal PDF watermark.
- The attestation block (printed name + drawn signature + date) shown on a closed receipt is the **closing (FULL) return's** technician.
- Auth: return flow stays admin-only (`requireAdmin`); account signature is self-service (`requireUser`). `SessionUser = { id, role, name, email }` (does NOT include the signature — fetch it explicitly).
- Security: Prisma methods only; generic client errors + `console.error`; signature validated server-side in both the account and return actions. A signature `<img>` uses a `data:` URL (add `// eslint-disable-next-line @next/next/no-img-element` if flagged).
- Existing `SignaturePad` usage (`name="receiverSignature"` in `ReceiptBuilderForm`) must keep working unchanged (make `name` optional, add `onChange`).
- **Deploy:** one additive migration (two nullable columns) applied to Supabase **before** push. **`prisma migrate deploy` MUST use `DIRECT_URL` (5432); it hangs silently through the 6543 transaction pooler.**
- Dates render via `formatDateHST`/`formatDateTimeHST` from `@/lib/datetime`. Real-DB tests use `migrateTestDb`/`resetDb` from `tests/helpers/db`.

---

### Task 1: Data model, migration, signature validation, saved-signature service

**Files:**
- Modify: `prisma/schema.prisma` (`User` model ~14-30; `ReturnTransaction` ~135-151)
- Create: `prisma/migrations/20260709170000_technician_signatures/migration.sql`
- Create: `src/lib/signature.ts`
- Test: `src/lib/signature.test.ts`
- Modify: `src/modules/users/users.service.ts` (add `updateUserSignature`)

**Interfaces:**
- Produces: `User.signatureImage: String?`; `ReturnTransaction.processedBySignature: String?`; `MAX_SIGNATURE_LEN`, `signatureError(s: string): string | null`; `updateUserSignature(id: string, signature: string | null): Promise<void>`.

- [ ] **Step 1: Schema — add `User.signatureImage`**

In `model User`, add after `passwordHash` (keep formatting aligned; run `npx prisma format` after all schema edits):

```prisma
  passwordHash  String
  signatureImage String?
```

- [ ] **Step 2: Schema — add `ReturnTransaction.processedBySignature`**

In `model ReturnTransaction`, add after `processedByEmail`:

```prisma
  processedByEmail  String
  processedBySignature String?
```

- [ ] **Step 3: Hand-author the migration** (Prisma's `--create-only` hangs in this non-interactive shell; write the folder + file directly, then apply)

Create `prisma/migrations/20260709170000_technician_signatures/migration.sql` with exactly:

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN "signatureImage" TEXT;

-- AlterTable
ALTER TABLE "ReturnTransaction" ADD COLUMN "processedBySignature" TEXT;
```

- [ ] **Step 4: Apply to the LOCAL dev DB + regenerate client** (never production; never `migrate reset`)

Run: `npx prisma migrate dev`
Expected: "Applying migration `20260709170000_technician_signatures`" then "in sync" and client regenerates.

- [ ] **Step 5: Write the failing test for `signature.ts`**

Create `src/lib/signature.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signatureError, MAX_SIGNATURE_LEN } from "./signature";

describe("signatureError", () => {
  it("requires a value", () => {
    expect(signatureError("")).toMatch(/required/i);
  });
  it("rejects a non-PNG-data-url", () => {
    expect(signatureError("hello")).toMatch(/invalid/i);
    expect(signatureError("data:image/jpeg;base64,xxxx")).toMatch(/invalid/i);
  });
  it("rejects an over-length value", () => {
    const big = "data:image/png;base64," + "a".repeat(MAX_SIGNATURE_LEN);
    expect(signatureError(big)).toMatch(/too large/i);
  });
  it("accepts a valid PNG data url", () => {
    expect(signatureError("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/signature.test.ts`
Expected: FAIL — cannot resolve `./signature`.

- [ ] **Step 7: Implement `src/lib/signature.ts`**

```ts
// Shared validation for drawn signatures (PNG data URLs). Pure — used by the
// account action and the return action to gate/persist a signature server-side.
export const MAX_SIGNATURE_LEN = 250_000;

export function signatureError(s: string): string | null {
  if (!s) return "A signature is required.";
  if (!s.startsWith("data:image/png;base64,")) return "Invalid signature format.";
  if (s.length > MAX_SIGNATURE_LEN) return "Signature image is too large.";
  return null;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/lib/signature.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Add `updateUserSignature` to `users.service.ts`**

Append:

```ts
// Sets or clears the caller's reusable saved signature (a PNG data URL, or null
// to remove it). Validation of the data URL happens at the action layer.
export function updateUserSignature(id: string, signature: string | null): Promise<void> {
  return prisma.user.update({ where: { id }, data: { signatureImage: signature } }).then(() => undefined);
}
```

- [ ] **Step 10: Run the full suite**

Run: `npx vitest run`
Expected: PASS (all green; the new signature test included, real-DB suites re-apply migrations).

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/signature.ts src/lib/signature.test.ts src/modules/users/users.service.ts
git commit -m "feat(sig): signatureImage + processedBySignature columns, signature validation, updateUserSignature"
```

---

### Task 2: `SignaturePad` refactor + reusable `TechnicianSignatureField`

**Files:**
- Modify: `src/components/SignaturePad.tsx`
- Create: `src/components/TechnicianSignatureField.tsx`
- Modify: `src/app/globals.css` (add a `.sig-preview` rule)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SignaturePad({ name?, onChange? })`; `TechnicianSignatureField({ name, saveOptName?, savedSignature?, onChange? })`.

- [ ] **Step 1: Refactor `SignaturePad.tsx` (backward compatible)**

Replace the file with:

```tsx
"use client";
import { useRef, useEffect, useState } from "react";

// `name` (optional) renders a hidden input carrying the PNG data URL (existing
// usage). `onChange` (optional) reports the data URL to a parent on each
// stroke-end and on clear, so a composite field can gate submission on it.
export function SignaturePad({ name, onChange }: { name?: string; onChange?: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState("");
  const drawing = useRef(false);
  const emit = (u: string) => { setDataUrl(u); onChange?.(u); };
  const emitRef = useRef(emit);
  emitRef.current = emit;

  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#111";
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
    };
    const down = (e: PointerEvent) => { drawing.current = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
    const move = (e: PointerEvent) => { if (!drawing.current) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
    const up = () => { if (drawing.current) { drawing.current = false; emitRef.current(c.toDataURL("image/png")); } };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { c.removeEventListener("pointerdown", down); c.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const clear = () => {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    emit("");
  };

  return (
    <div className="stack-sm">
      <canvas ref={canvasRef} width={360} height={140} className="sigpad" />
      <div>
        <button type="button" onClick={clear} className="btn btn-secondary btn-sm">Clear</button>
      </div>
      {name && <input type="hidden" name={name} value={dataUrl} />}
    </div>
  );
}
```

- [ ] **Step 2: Create `TechnicianSignatureField.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

// Reusable technician signing control. If the tech has a saved signature it is
// pre-selected ("use saved"); otherwise they draw, with an optional "save to my
// profile" checkbox. Owns the hidden input `name` (the effective PNG data URL)
// and reports the current value via `onChange` so a parent form can gate submit.
export function TechnicianSignatureField({
  name, saveOptName, savedSignature, onChange,
}: { name: string; saveOptName?: string; savedSignature?: string | null; onChange?: (value: string) => void }) {
  const [mode, setMode] = useState<"saved" | "draw">(savedSignature ? "saved" : "draw");
  const [drawn, setDrawn] = useState("");
  const value = mode === "saved" && savedSignature ? savedSignature : drawn;

  useEffect(() => { onChange?.(value); }, [value, onChange]);

  return (
    <div className="stack-sm">
      {savedSignature && (
        <div className="row">
          <label className="row"><input type="radio" checked={mode === "saved"} onChange={() => setMode("saved")} /> Use my saved signature</label>
          <label className="row"><input type="radio" checked={mode === "draw"} onChange={() => setMode("draw")} /> Draw a new one</label>
        </div>
      )}
      {mode === "saved" && savedSignature ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={savedSignature} alt="Saved signature" className="sig-preview" />
      ) : (
        <>
          <SignaturePad onChange={setDrawn} />
          {saveOptName && !savedSignature && (
            <label className="row"><input type="checkbox" name={saveOptName} /> Save this signature to my profile for next time</label>
          )}
        </>
      )}
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
```

- [ ] **Step 3: Add `.sig-preview` CSS**

In `src/app/globals.css`, add near the existing `.sigpad` rule:

```css
.sig-preview { max-width: 360px; max-height: 140px; border: 1px solid var(--border, #ccc); border-radius: 6px; background: #fff; }
```
(Match the surrounding CSS conventions; if `.sigpad` uses different tokens/vars, mirror those.)

- [ ] **Step 4: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: lint clean (no NEW errors); build succeeds. The existing `ReceiptBuilderForm` `<SignaturePad name="receiverSignature" />` still compiles (name is optional now).

- [ ] **Step 5: Commit**

```bash
git add src/components/SignaturePad.tsx src/components/TechnicianSignatureField.tsx src/app/globals.css
git commit -m "feat(sig): SignaturePad onChange + reusable TechnicianSignatureField"
```

---

### Task 3: Account page — manage saved signature

**Files:**
- Modify: `src/app/actions/account.ts` (add `saveSignatureAction`)
- Create: `src/app/account/SignatureSettings.tsx`
- Modify: `src/app/account/page.tsx`

**Interfaces:**
- Consumes: `signatureError` (Task 1), `updateUserSignature` (Task 1), `SignaturePad` (Task 2), `requireUser`, `getCurrentUser`/prisma.
- Produces: `saveSignatureAction(prev, formData): Promise<{ ok: true } | { error: string }>`.

- [ ] **Step 1: Add `saveSignatureAction` to `src/app/actions/account.ts`**

Add these imports at the top (alongside the existing ones):

```ts
import { updateUserSignature } from "@/modules/users/users.service";
import { signatureError } from "@/lib/signature";
```

Append the action:

```ts
export async function saveSignatureAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = String(formData.get("signature") ?? "");
  const clear = formData.get("clear") === "1";

  if (clear) {
    try {
      await updateUserSignature(user.id, null);
    } catch (e) {
      console.error("[saveSignatureAction] clear failed:", e);
      return { error: "Something went wrong. Please try again." };
    }
    return { ok: true as const };
  }

  const err = signatureError(raw);
  if (err) return { error: err };
  try {
    await updateUserSignature(user.id, raw);
  } catch (e) {
    console.error("[saveSignatureAction] save failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  return { ok: true as const };
}
```

- [ ] **Step 2: Create `src/app/account/SignatureSettings.tsx`**

```tsx
"use client";
import { useActionState, useState } from "react";
import { saveSignatureAction } from "@/app/actions/account";
import { SignaturePad } from "@/components/SignaturePad";

export function SignatureSettings({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(saveSignatureAction, undefined);
  const [drawn, setDrawn] = useState("");
  const saved = state && "ok" in state && state.ok;

  return (
    <div className="stack-sm">
      {current && (
        <div className="stack-sm">
          <div className="subtle">Current saved signature:</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={current} alt="Your saved signature" className="sig-preview" />
        </div>
      )}
      <form action={action} className="stack-sm">
        <div className="subtle">{current ? "Draw a new signature to replace it:" : "Draw your signature:"}</div>
        <SignaturePad name="signature" onChange={setDrawn} />
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={pending || drawn.length === 0}>
            {pending ? "Saving…" : "Save signature"}
          </button>
        </div>
      </form>
      {current && (
        <form action={action}>
          <input type="hidden" name="clear" value="1" />
          <button className="btn btn-secondary btn-sm" type="submit" disabled={pending}>Remove saved signature</button>
        </form>
      )}
      {saved && <p className="alert-success">Signature updated.</p>}
      {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Add the Signature card to `src/app/account/page.tsx`**

Add an import and a query for the current user's signature, then render the card. Replace the file with:

```tsx
import { redirect } from "next/navigation";
import { requireUser, AuthError } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { SiteHeader } from "@/components/SiteHeader";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { SignatureSettings } from "./SignatureSettings";

export default async function AccountPage() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) redirect("/login");
    throw e;
  }
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { signatureImage: true } });

  return (
    <>
      <SiteHeader />
      <main className="container container-narrow stack">
        <div>
          <h1 className="page-title">Account</h1>
          <p className="subtle">{user.name} · {user.email}</p>
        </div>
        <div className="card stack">
          <div className="card__title">Signature</div>
          <p className="subtle">Save a signature to reuse it with one click when you accept returns.</p>
          <SignatureSettings current={me?.signatureImage ?? null} />
        </div>
        <div className="card stack">
          <div className="card__title">Change password</div>
          <ChangePasswordForm />
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: lint clean (no new errors); build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/account.ts src/app/account/SignatureSettings.tsx src/app/account/page.tsx
git commit -m "feat(sig): account page saved-signature management"
```

---

### Task 4: Return service + action — require + persist signature, save-to-profile, closing-return query

**Files:**
- Modify: `src/modules/returns/returns.service.ts` (`ProcessReturnInput.signature`, store `processedBySignature`, add `getClosingReturn`)
- Modify: `src/modules/returns/returns.service.test.ts` (pass a signature; assert it persists)
- Modify: `src/app/actions/returns.ts` (validate signature; save-to-profile; pass signature through)

**Interfaces:**
- Consumes: `signatureError`, `updateUserSignature` (Task 1).
- Produces: `ProcessReturnInput.signature: string`; `getClosingReturn(transferId: string)` → the FULL `ReturnTransaction` (or null).

- [ ] **Step 1: Update the real-DB test first** (add signature to the input and assert persistence)

In `src/modules/returns/returns.service.test.ts`, change the `processedBy()` helper usage so every `processReturn` call includes a signature, and add an assertion. Concretely: define a constant `const SIG = "data:image/png;base64,iVBORw0KGgo=";` near the top, add `signature: SIG` to every `processReturn({ ... })` call in the file, and in the PARTIAL test add:

```ts
  expect(ledger[0].processedBySignature).toBe(SIG);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/returns/returns.service.test.ts`
Expected: FAIL — `signature` not accepted by `ProcessReturnInput` / `processedBySignature` not stored.

- [ ] **Step 3: Update `returns.service.ts`**

Add `signature` to the input type:

```ts
export type ProcessReturnInput = {
  receiptNumber: string;
  selectedItemIds: string[];
  signature: string;
  processedBy: { id: string; name: string; email: string };
};
```

Destructure it and store it in the ledger create. Change the destructure line to include `signature`, and add `processedBySignature: signature` to the `returnTransaction.create` data:

```ts
  const { receiptNumber, selectedItemIds, signature, processedBy } = input;
```
```ts
      await tx.returnTransaction.create({
        data: {
          transferId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          kind: plan.kind,
          processedByUserId: processedBy.id,
          processedByName: processedBy.name,
          processedByEmail: processedBy.email,
          processedBySignature: signature,
          returned: plan.returned.map((r) => ({ serialNumber: r.serialNumber, make: r.make, model: r.model })),
          returnedCount: plan.returned.length,
          remainingCount: plan.remaining.length,
        },
      });
```

Append the closing-return query at the end of the file:

```ts
// The single FULL return that closed a receipt (its technician's name/signature/
// date is the closed-out attestation shown on the receipt page and PDF).
export function getClosingReturn(transferId: string) {
  return prisma.returnTransaction.findFirst({
    where: { transferId, kind: "FULL" },
    orderBy: { createdAt: "desc" },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/returns/returns.service.test.ts`
Expected: PASS (4 tests; PARTIAL test now also asserts the stored signature).

- [ ] **Step 5: Update `src/app/actions/returns.ts`**

Add imports:

```ts
import { updateUserSignature } from "@/modules/users/users.service";
import { signatureError } from "@/lib/signature";
```

After the existing `verified` and `selectedItemIds` checks, add signature validation, read the save flag, pass the signature into `processReturn`, and save-to-profile on success. The updated body between the checks and the return:

```ts
  const selectedItemIds = formData.getAll("itemId").map(String).filter(Boolean);
  if (selectedItemIds.length === 0) return { error: "Select at least one serial number to return." };

  const signature = String(formData.get("signature") ?? "");
  const sigErr = signatureError(signature);
  if (sigErr) return { error: sigErr };
  const saveSignature = formData.get("saveSignature") === "on";

  try {
    const res = await processReturn({
      receiptNumber,
      selectedItemIds,
      signature,
      processedBy: { id: admin.id, name: admin.name, email: admin.email },
    });
    if ("error" in res) return { error: res.error };

    if (saveSignature) {
      try { await updateUserSignature(admin.id, signature); }
      catch (err) { console.error("[processReturnAction] save signature failed:", err); }
    }

    revalidatePath(`/receipts/${res.receiptNumber}`);
    revalidatePath("/admin/audit");
    // ...existing email block and return unchanged...
```

(Keep the existing best-effort email block and the final `return { ok: true, ... }` exactly as-is.)

- [ ] **Step 6: Run the covering tests + lint**

Run: `npx vitest run src/modules/returns/returns.service.test.ts && npm run lint`
Expected: tests PASS; lint clean (no new errors).

- [ ] **Step 7: Commit**

```bash
git add src/modules/returns/returns.service.ts src/modules/returns/returns.service.test.ts src/app/actions/returns.ts
git commit -m "feat(sig): returns require + persist technician signature, save-to-profile, getClosingReturn"
```

---

### Task 5: Return form — signature field + submit gating

**Files:**
- Modify: `src/app/receipts/[receiptNumber]/return/ReturnForm.tsx`
- Modify: `src/app/receipts/[receiptNumber]/return/page.tsx`

**Interfaces:**
- Consumes: `TechnicianSignatureField` (Task 2); the return page passes the admin's `signatureImage`.

- [ ] **Step 1: Add the signature field + gating to `ReturnForm.tsx`**

Add the import:

```ts
import { TechnicianSignatureField } from "@/components/TechnicianSignatureField";
```

Change the component signature to accept `savedSignature`, add signature state, extend `canSubmit`, and render the field. Specifically:

- Signature line: `export function ReturnForm({ receiptNumber, held, savedSignature }: { receiptNumber: string; held: HeldItem[]; savedSignature?: string | null }) {`
- Add state near the other `useState`s: `const [signature, setSignature] = useState(savedSignature ?? "");`
- Change `canSubmit`: `const canSubmit = checked.size > 0 && verified && signature.length > 0 && !pending;`
- Add this fieldset immediately BEFORE the final submit `<div className="row">` (after the verify-checkbox `<label>`):

```tsx
      <fieldset className="card stack-sm">
        <legend className="card__title">Technician signature</legend>
        <p className="subtle">Sign to confirm you accepted these items.</p>
        <TechnicianSignatureField name="signature" saveOptName="saveSignature" savedSignature={savedSignature} onChange={setSignature} />
      </fieldset>
```

(Do not change the success-state UI, the checkbox rendering, or the hidden `receiptNumber` input. Pass `setSignature` — a stable `useState` setter — as `onChange`.)

- [ ] **Step 2: Pass the admin's saved signature from `return/page.tsx`**

The page currently discards the `requireAdmin()` result and does not import prisma. Update it to capture the admin, fetch their `signatureImage`, and pass it to the form:

- Change `try { await requireAdmin(); }` to `let admin;` + `try { admin = await requireAdmin(); }` (keep the same catch).
- Add `import prisma from "@/lib/prisma";` at the top.
- After the `if (t.status !== "OPEN") redirect(...)` guard, add:
  ```ts
  const me = await prisma.user.findUnique({ where: { id: admin.id }, select: { signatureImage: true } });
  ```
- Change the render to `<ReturnForm receiptNumber={t.receiptNumber} held={held} savedSignature={me?.signatureImage ?? null} />`.

- [ ] **Step 3: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: lint clean (no new errors); build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "src/app/receipts/[receiptNumber]/return"
git commit -m "feat(sig): return form technician signature field + required-to-submit gating"
```

---

### Task 6: Receipt page — "CLOSED" rename + closing-technician attestation block

**Files:**
- Modify: `src/app/receipts/[receiptNumber]/page.tsx`

**Interfaces:**
- Consumes: `getClosingReturn` (Task 4); `formatDateTimeHST`.

- [ ] **Step 1: Fetch the closing return and render the block**

In `src/app/receipts/[receiptNumber]/page.tsx`:

- Add the import: `import { getClosingReturn } from "@/modules/returns/returns.service";`
- After `const closed = t.status === "CLOSED";`, add: `const closing = closed ? await getClosingReturn(t.id) : null;`
- Replace the existing closed banner block with the renamed "CLOSED" text plus the attestation block:

```tsx
        {closed && (
          <div className="card alert-error stack-sm" role="status">
            <div><strong>CLOSED</strong> — all equipment returned. This receipt is closed and read-only.</div>
            {closing && (
              <div className="stack-sm">
                <div className="subtle">Accepted by {closing.processedByName} · {formatDateTimeHST(closing.createdAt)}</div>
                {closing.processedBySignature && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={closing.processedBySignature} alt={`Signature of ${closing.processedByName}`} className="sig-preview" />
                )}
              </div>
            )}
          </div>
        )}
```

(Leave the items/redline, party, status, and button rows unchanged.)

- [ ] **Step 2: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: lint clean (no new errors); build succeeds.

- [ ] **Step 3: Commit**

```bash
git add "src/app/receipts/[receiptNumber]/page.tsx"
git commit -m "feat(sig): receipt page CLOSED banner + accepting-technician attestation"
```

---

### Task 7: PDF — "CLOSED" watermark + closing-technician attestation on the custody page

**Files:**
- Modify: `src/modules/receipts/hand-receipt.ts` (`ReceiptData.closedBy`, rename watermark, page-2 block)
- Modify: `src/app/receipts/[receiptNumber]/pdf/route.ts` (pass `closedBy`)
- Modify: `src/modules/receipts/hand-receipt.test.ts` (extend the CLOSED smoke with a `closedBy`)

**Interfaces:**
- Consumes: `getClosingReturn` (Task 4).
- Produces: `ReceiptData.closedBy?: { name: string; signature: string; date: Date }`.

- [ ] **Step 1: Add `closedBy` to `ReceiptData`**

In `hand-receipt.ts`, add to the `ReceiptData` type (after `receiver: ReceiptParty;`):

```ts
  closedBy?: { name: string; signature: string; date: Date };
```

- [ ] **Step 2: Rename the page-1 watermark to "CLOSED"**

In the `if (t.status === "CLOSED") { ... }` overlay block on page 1, change the watermark text from `"VOID / CLEARED"` to `"CLOSED"`. Because "CLOSED" is a shorter string, also nudge its x so it stays centered — change the `drawText` for the watermark to:

```ts
    page1.drawText("CLOSED", {
      x: width * 0.24,
      y: height * 0.42,
      size: 72,
      font: bold,
      color: red,
      rotate: degrees(35),
      opacity: 0.28,
    });
```
(Leave the strike-through `drawLine` over the signature block unchanged.)

- [ ] **Step 3: Render the closing-technician block on the custody page (page 2)**

In the custody-record section, AFTER the `meta` loop that prints `Date`/`Status` (right before the `y -= 16;` that precedes the FROM/TO loop), insert:

```ts
  if (t.closedBy) {
    y -= 6;
    page.drawText("Accepted / closed by", { x: 56, y, size: 11, font: bold, color: muted });
    y -= 16;
    page.drawText(`${t.closedBy.name} · ${formatDateHST(t.closedBy.date)}`, { x: 66, y, size: 11, font: helv, color: ink });
    y -= 6;
    if (t.closedBy.signature && t.closedBy.signature.startsWith("data:image/png;base64,")) {
      try {
        const csig = await pdf.embedPng(Buffer.from(t.closedBy.signature.split(",")[1], "base64"));
        const w = 180, h = Math.min((csig.height / csig.width) * w, 70);
        page.drawImage(csig, { x: 66, y: y - h, width: w, height: h });
        y -= h + 6;
      } catch { y -= 6; }
    }
    y -= 10;
  }
```

- [ ] **Step 4: Pass `closedBy` from the PDF route**

In `src/app/receipts/[receiptNumber]/pdf/route.ts`:

- Add the import: `import { getClosingReturn } from "@/modules/transfers/../returns/returns.service";` — use the correct path `@/modules/returns/returns.service`.
- After computing `t` (and before/around building `ReceiptData`), add:
  ```ts
  let closedBy: { name: string; signature: string; date: Date } | undefined;
  if (t.status === "CLOSED") {
    const cr = await getClosingReturn(t.id);
    if (cr) closedBy = { name: cr.processedByName, signature: cr.processedBySignature ?? "", date: cr.createdAt };
  }
  ```
- Add `closedBy,` to the object passed to `buildHandReceiptPdf({ ... })`.

- [ ] **Step 5: Extend the CLOSED PDF smoke test**

In `src/modules/receipts/hand-receipt.test.ts`, update the existing CLOSED test (or add one) to pass a `closedBy` and assert it still renders:

```ts
  const bytes = await buildHandReceiptPdf({
    ...base,
    status: "CLOSED",
    closedBy: { name: "SPC Tech", signature: "data:image/png;base64,iVBORw0KGgo=", date: base.createdAt },
  });
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(bytes.length).toBeGreaterThan(1000);
```
(Use whatever fixture the file already calls `base`; if the signature data URL fails to embed as a real PNG, the code's try/catch swallows it — the test still asserts a successful render. If you want the embed path exercised, use a minimal valid 1×1 PNG data URL.)

- [ ] **Step 6: Run the PDF test + build**

Run: `npx vitest run src/modules/receipts/hand-receipt.test.ts && npm run build`
Expected: tests PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/modules/receipts/hand-receipt.ts "src/app/receipts/[receiptNumber]/pdf/route.ts" src/modules/receipts/hand-receipt.test.ts
git commit -m "feat(sig): CLOSED PDF watermark + accepting-technician attestation on custody page"
```

---

### Task 8: Verify, migrate production, release, smoke

**Files:** none (release task).

- [ ] **Step 1: Full verification**

Run: `npm run lint && npx vitest run && npm run build`
Expected: lint clean (no new errors); all vitest green; build succeeds.

- [ ] **Step 2: Apply the migration to production Supabase BEFORE pushing**

Apply `20260709170000_technician_signatures` to prod. **Use `DIRECT_URL` (5432)** from `.env.production.local` — `prisma migrate deploy` HANGS through the 6543 pooler. Confirm with `prisma migrate status` first (should list it pending), apply, then confirm "successfully applied". Do NOT print secrets; do NOT touch the local/test DB.

- [ ] **Step 3: Push**

```bash
git push origin feat/hand-receipt-app
```

- [ ] **Step 4: Verify live + smoke**

After the Vercel deploy: confirm home returns 200. Then run an end-to-end smoke on the DEV server (Playwright): save a signature on the Account page; process a return using the saved signature (assert submit is blocked until a signature is present); confirm the closed receipt page shows the "CLOSED" banner with the accepting technician's name + signature + date; open the CLOSED PDF and confirm the "CLOSED" watermark and the custody-page attestation. Capture a screenshot of the closed receipt page.

- [ ] **Step 5: Update the ledger**

Append a "SHIPPED" entry to `.superpowers/sdd/progress.md` (range + that the migration was applied to prod via DIRECT_URL before push).

---

## Self-Review

**Spec coverage:** saved signature (User column + Account UI: Tasks 1,3) ✓; reusable field (Task 2) ✓; required-on-every-return (Task 4 action + Task 5 form gating) ✓; persisted per return (Task 4) ✓; CLOSED rename page + PDF (Tasks 6,7) ✓; closing-technician attestation page + PDF (Tasks 6,7 via getClosingReturn Task 4) ✓; validation (Task 1) ✓; migration before push via DIRECT_URL (Task 8) ✓.

**Placeholder scan:** the only fixture-name reference is Task 7's `base` (the existing hand-receipt test fixture) — flagged. No TBD/"handle errors" left.

**Type consistency:** `signatureError`/`updateUserSignature` (Task 1) consumed in Tasks 3,4. `ProcessReturnInput.signature` (Task 4) supplied by the action (Task 4) and required by the form value (Task 5). `getClosingReturn` (Task 4) consumed by Tasks 6,7. `ReceiptData.closedBy` (Task 7) supplied by the route (Task 7). `TechnicianSignatureField` props (Task 2) match the return-form call site (Task 5) and imply `SignaturePad`'s new optional `name`/`onChange` (Task 2). Banner string is `"CLOSED"` in both Task 6 and Task 7.
