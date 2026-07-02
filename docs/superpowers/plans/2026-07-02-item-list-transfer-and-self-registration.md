# Item-List Transfers + Self-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move transfer initiation onto a shared item list, re-enable self-registration for peer (two-non-DCSIM) transfers, and print unit+contact on the receipt name line sized to fit.

**Architecture:** Replace the standalone `/new` kiosk page with a shared `/items` list (transfer for all logged-in users; log/edit/retire admin-only) and an item-scoped transfer form at `/items/[id]/transfer`. Re-add `/register` (active USER accounts). Extend the DA 2062 FROM/TO line with unit+contact, shrunk to fit the box.

**Tech Stack:** Next.js 16.2.9 (App Router, `proxy.ts`, Server Actions, Route Handlers), Prisma 7 + PostgreSQL, next-auth v5, pdf-lib, qrcode, Zod v4, Vitest.

## Global Constraints

- **Next.js 16 is non-standard.** Mirror existing repo patterns: route/page `params` and `searchParams` are `Promise<…>` and must be `await`ed; server actions are `"use server"` files returning `{ error }`/`{ receiptNumber }`/`{ ok }` shapes consumed by `useActionState`; middleware is `src/proxy.ts`.
- **Account model:** a login is required only to *reach the transfer form and initiate*. The counterparty is always typed and never needs an account. DCSIM-involved transfers run from the DCSIM/admin login; two-non-DCSIM transfers need the initiator to have a (possibly self-registered) login.
- **Access:** `/items` and `/items/[id]/transfer` require `requireUser()` (any role). Logging a new item, editing, and retiring stay admin-only (`requireAdmin()` / existing admin routes). `/register`, `/`, `/login`, `/receipts/*` are public.
- **Name-line format:** a non-DCSIM party prints as `RANK Name, Unit, Contact` (commas; omit any missing field). DCSIM prints `DCSIM · <name>`.
- **Party rules unchanged** (from `transfers.schema.ts`): DCSIM side needs only `name`; non-DCSIM needs rank+name+unit+contact+email; both-DCSIM rejected; recipient signature required.
- **Commit** after each task's tests pass. Don't push unless asked. Trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Gates:** `npm test` (Vitest), `npx tsc --noEmit`, `npm run lint`, `npm run build`. Docker Postgres is up on `localhost:5435`.

---

## File Structure

**Created**
- `src/app/items/page.tsx` — shared item list (all roles; admin gets manage actions)
- `src/app/items/[id]/transfer/page.tsx` — item-scoped transfer (server component)
- `src/app/items/[id]/transfer/ItemTransferForm.tsx` — item-scoped two-party form (client)
- `src/app/register/page.tsx` — public self-registration form (client)
- Tests: `src/modules/users/register.schema.test.ts` (or extend users.schema.test)

**Modified**
- `src/modules/receipts/hand-receipt.ts` — comma name line + fit-to-box; export `partyHeader`
- `src/modules/receipts/hand-receipt.test.ts` — partyHeader cases
- `src/modules/users/users.schema.ts` — add `registerSchema`/`RegisterInput`
- `src/modules/users/users.service.ts` — add `registerUser`
- `src/app/actions/auth.ts` — add `registerAction`; `loginAction` redirect `/new`→`/items`
- `src/app/actions/transfers.ts` — simplify `createTransferAction` (item-scoped); remove `lookupLastHolderAction`
- `src/app/actions/transfers.parse.ts` — simplify `parseTransferForm` (fixed item)
- `src/app/actions/transfers.parse.test.ts` — update for fixed-item shape
- `src/app/login/page.tsx` — link to `/register`
- `src/app/page.tsx` — header "New receipt"→ Items link to `/items`
- `src/app/admin/layout.tsx` — nav "Items" → `/items`
- `src/proxy.ts` — add `register` to public matcher

**Deleted**
- `src/app/new/` (page + `NewTransferForm.tsx`)
- `src/app/admin/items/page.tsx` (list moves to `/items`)

---

## Task 1: Receipt name line — unit + contact, sized to fit

**Files:**
- Modify: `src/modules/receipts/hand-receipt.ts`
- Modify: `src/modules/receipts/hand-receipt.test.ts`

**Interfaces:**
- Produces: exported `partyHeader(p: ReceiptParty): string`. `buildHandReceiptPdf` unchanged signature.

- [ ] **Step 1: Write failing partyHeader tests**

Add to `src/modules/receipts/hand-receipt.test.ts` (import `partyHeader`):
```ts
import { buildHandReceiptPdf, partyHeader, type ReceiptData } from "./hand-receipt";

describe("partyHeader", () => {
  it("comma-joins rank, name, unit, contact for a full non-DCSIM party", () => {
    expect(partyHeader({ isDcsim: false, name: "Jane Soldier", rank: "SGT", unit: "A Co 1-1 IN", contact: "808-555-0134", email: "j@u.mil" }))
      .toBe("SGT Jane Soldier, A Co 1-1 IN, 808-555-0134");
  });
  it("omits missing unit/contact", () => {
    expect(partyHeader({ isDcsim: false, name: "Jane Soldier", rank: "SGT", unit: null, contact: null, email: null }))
      .toBe("SGT Jane Soldier");
  });
  it("omits rank when absent", () => {
    expect(partyHeader({ isDcsim: false, name: "Jane Soldier", rank: null, unit: "A Co", contact: null, email: null }))
      .toBe("Jane Soldier, A Co");
  });
  it("renders DCSIM parties unchanged", () => {
    expect(partyHeader({ isDcsim: true, name: "SSG Tech", rank: null, unit: null, contact: null, email: null }))
      .toBe("DCSIM · SSG Tech");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- hand-receipt`
Expected: FAIL — `partyHeader` is not exported / old format.

- [ ] **Step 3: Implement comma name line + export**

In `src/modules/receipts/hand-receipt.ts`, replace `partyHeader`:
```ts
// FROM/TO line: DCSIM shows "DCSIM · <name>"; a non-DCSIM party shows
// "RANK Name, Unit, Contact" with any missing field omitted.
export function partyHeader(p: ReceiptParty): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  const nameLine = p.rank ? `${p.rank} ${p.name}` : p.name;
  return [nameLine, p.unit ?? undefined, p.contact ?? undefined].filter(Boolean).join(", ");
}
```

- [ ] **Step 4: Size the FROM/TO fields to fit the box**

In `buildHandReceiptPdf`, extend the `set` helper with a width-fit option and apply it to FROM/TO. Replace the `set` definition and the FROM/TO calls:
```ts
  const set = (
    name: string,
    value: string,
    opts: { multiline?: boolean; size?: number; center?: boolean; fitWidth?: boolean } = {}
  ) => {
    try {
      const field = form.getTextField(name);
      if (opts.multiline) field.enableMultiline();
      if (opts.center) field.setAlignment(TextAlignment.Center);
      let size = opts.size ?? 10;
      if (opts.fitWidth) {
        // Shrink the font until the value fits the widget's inner width, so a
        // long "RANK Name, Unit, Contact" line never overflows the box.
        const rect = field.acroField.getWidgets()[0].getRectangle();
        const maxW = rect.width - 6;
        while (size > 6 && helv.widthOfTextAtSize(value, size) > maxW) size -= 0.5;
      }
      field.setFontSize(size);
      field.setText(value);
    } catch {
      /* field not present in this template revision — ignore */
    }
  };

  set("FROM", partyHeader(t.sender), { size: 10, fitWidth: true, multiline: true });
  set("TO", partyHeader(t.receiver), { size: 10, fitWidth: true, multiline: true });
  set("HAND RECEIPT IDENTIFIER", t.receiptNumber, { size: 11 });
```
(Leave the rest of the function, including the ITEM/UI/QTY `set` calls and `partyBlock`, unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- hand-receipt`
Expected: PASS (partyHeader cases + existing PDF-bytes tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/receipts/hand-receipt.ts src/modules/receipts/hand-receipt.test.ts
git commit -m "feat(receipts): unit+contact on the FROM/TO name line, sized to fit the box"
```

---

## Task 2: Self-registration

**Files:**
- Modify: `src/modules/users/users.schema.ts`
- Modify: `src/modules/users/users.service.ts`
- Modify: `src/app/actions/auth.ts`
- Create: `src/app/register/page.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `src/proxy.ts`
- Create: `src/modules/users/users.schema.test.ts` (register cases) — if a users.schema test already exists, add to it instead.

**Interfaces:**
- Produces: `registerSchema` (`newUserSchema` minus `role`), `RegisterInput`; `registerUser(input: RegisterInput): Promise<User>` (active USER, persists unit/contactNumber); `registerAction(_prev, formData)` → `{ error }` or redirect to `/items`.

- [ ] **Step 1: Write failing registerSchema test**

Create `src/modules/users/users.schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { registerSchema } from "./users.schema";

const base = { name: "Jane Soldier", email: "Jane@Unit.Mil", password: "TempPass123" };

describe("registerSchema", () => {
  it("accepts rank/unit/contact and lowercases email; has no role field", () => {
    const r = registerSchema.parse({ ...base, rank: "SGT", unit: "A Co", contactNumber: "808-555-0134" });
    expect(r.email).toBe("jane@unit.mil");
    expect(r.unit).toBe("A Co");
    expect(r.contactNumber).toBe("808-555-0134");
    expect("role" in r).toBe(false);
  });
  it("requires name, email, and an 8+ char password", () => {
    expect(registerSchema.safeParse({ ...base, password: "short" }).success).toBe(false);
    expect(registerSchema.safeParse({ email: base.email, password: base.password }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- users.schema`
Expected: FAIL — `registerSchema` not exported.

- [ ] **Step 3: Add registerSchema**

In `src/modules/users/users.schema.ts`, append:
```ts
// Public self-registration: same fields as admin create, minus role (always USER).
export const registerSchema = newUserSchema.omit({ role: true });
export type RegisterInput = z.infer<typeof registerSchema>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- users.schema`
Expected: PASS.

- [ ] **Step 5: Add registerUser to the service**

In `src/modules/users/users.service.ts`, add (import `RegisterInput`, `registerSchema`):
```ts
// Public self-registration — always creates an active standard (USER) account.
export async function registerUser(input: RegisterInput): Promise<User> {
  const data = registerSchema.parse(input);
  return prisma.user.create({
    data: {
      rank: data.rank,
      name: data.name,
      email: data.email,
      unit: data.unit,
      contactNumber: data.contactNumber,
      role: "USER",
      passwordHash: await hashPassword(data.password),
    },
  });
}
```
Update the import line to: `import { newUserSchema, registerSchema, type NewUserInput, type RegisterInput } from "./users.schema";`

- [ ] **Step 6: Add registerAction to auth.ts**

In `src/app/actions/auth.ts`, add imports and the action (keep `loginAction`/`logoutAction`):
```ts
import { registerUser } from "@/modules/users/users.service";
import { registerSchema } from "@/modules/users/users.schema";

export async function registerAction(_prev: unknown, formData: FormData) {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await registerUser(parsed.data);
  } catch {
    return { error: "Could not create account — that email may already be registered." };
  }
  try {
    await signIn("credentials", { email: parsed.data.email, password: parsed.data.password, redirectTo: "/items" });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Account created — please sign in." };
    throw error; // re-throw Next.js redirect
  }
}
```
Note: `AuthError` is imported from `next-auth` at the top of this file already; if not, add `import { AuthError } from "next-auth";`.

- [ ] **Step 7: Create the register page**

Create `src/app/register/page.tsx`:
```tsx
"use client";
import Link from "next/link";
import { useActionState } from "react";
import { registerAction } from "@/app/actions/auth";

export default function RegisterPage() {
  const [state, action, pending] = useActionState(registerAction, undefined);
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 420 }}>
        <div className="stack-sm">
          <div className="brand"><span className="brand__mark">HR</span>Hand Receipt</div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Create account</h1>
          <p className="subtle">For transfers between two non-DCSIM parties. Your details appear on receipts you send.</p>
        </div>
        <form action={action} className="stack">
          <div className="form-grid">
            <div className="field"><label className="label" htmlFor="r-rank">Rank</label><input id="r-rank" className="input" name="rank" placeholder="e.g. SGT (optional)" autoComplete="off" /></div>
            <div className="field"><label className="label" htmlFor="r-name">Name</label><input id="r-name" className="input" name="name" required /></div>
            <div className="field"><label className="label" htmlFor="r-unit">Unit</label><input id="r-unit" className="input" name="unit" placeholder="e.g. A Co, 1-1 IN" /></div>
            <div className="field"><label className="label" htmlFor="r-contact">Contact number</label><input id="r-contact" className="input" name="contactNumber" /></div>
            <div className="field"><label className="label" htmlFor="r-email">Email</label><input id="r-email" className="input" name="email" type="email" required autoComplete="email" /></div>
            <div className="field"><label className="label" htmlFor="r-pw">Password</label><input id="r-pw" className="input" name="password" type="password" placeholder="8+ characters" required autoComplete="new-password" /></div>
          </div>
          {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
          <button disabled={pending} type="submit" className="btn btn-primary btn-block">{pending ? "Creating…" : "Create account"}</button>
          <p className="subtle">Already have an account? <Link href="/login">Sign in</Link></p>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Link login → register and open the route**

In `src/app/login/page.tsx`, add below the sign-in button's form (after the closing `</form>`, before the card closes):
```tsx
        <p className="subtle">No account? <Link href="/register">Create one</Link></p>
```
Add `import Link from "next/link";` at the top.

In `src/proxy.ts`, add `register` to the public matcher:
```ts
  matcher: ["/((?!api/auth|login|register|receipts/|_next/static|_next/image|favicon.ico|$).*)"],
```

- [ ] **Step 9: Verify build + tests**

Run: `npx tsc --noEmit` (0 errors) and `npm test` (all pass). Manual: `/register` is reachable logged-out; submitting creates a USER and lands on `/items` (once Task 3 exists — until then it lands on `/items` 404/redirect; that's fine for this task's gate, which is tsc+unit tests).

- [ ] **Step 10: Commit**

```bash
git add src/modules/users/ src/app/actions/auth.ts src/app/register src/app/login/page.tsx src/proxy.ts
git commit -m "feat(auth): re-enable self-registration (active USER accounts) with unit/contact"
```

---

## Task 3: Relocate transfers onto the item list

This task moves the transfer flow off `/new` and onto `/items` + `/items/[id]/transfer`, simplifies the transfer action to a fixed item, and rewires all `/new` references. It is done as one task because the pieces must change together to keep the build green.

**Files:**
- Create: `src/app/items/page.tsx`
- Create: `src/app/items/[id]/transfer/page.tsx`
- Create: `src/app/items/[id]/transfer/ItemTransferForm.tsx`
- Modify: `src/app/actions/transfers.ts`, `src/app/actions/transfers.parse.ts`, `src/app/actions/transfers.parse.test.ts`
- Modify: `src/app/actions/auth.ts` (`loginAction` redirect `/new`→`/items`)
- Modify: `src/app/page.tsx` (header link `/new`→`/items`), `src/app/admin/layout.tsx` (nav Items→`/items`)
- Delete: `src/app/new/` (page + `NewTransferForm.tsx`), `src/app/admin/items/page.tsx`

**Interfaces:**
- Consumes: `requireUser` (SessionUser has `id/role/name/email`); `listItems({search?})`, `getItem(id)` (returns `{id,make,model,serialNumber,homeUnit,notes,status,...}` or null); `getLastReceiver(itemId)` → `PartyInput | null`; `createTransfer`, `transferSchema`, `sendReceiptEmails`, `receiptUrl`, `SignaturePad`, `StatusBadge`, `SignOutButton`, `toggleItemStatusAction`.
- Produces: `parseTransferForm(fd)` → `{ itemId, sender, receiver, receiverSignature }`; `createTransferAction(_prev, formData)` → `{ receiptNumber }` / `{ error }`.

- [ ] **Step 1: Update the parser test for a fixed item**

Replace `src/app/actions/transfers.parse.test.ts` body:
```ts
import { describe, it, expect } from "vitest";
import { parseTransferForm } from "./transfers.parse";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("parseTransferForm", () => {
  it("reads the fixed itemId and both parties (DCSIM sender)", () => {
    const out = parseTransferForm(fd({
      itemId: "itm1",
      senderIsDcsim: "on", senderName: "Tech",
      receiverIsDcsim: "", receiverName: "Jane", receiverRank: "SGT", receiverUnit: "A Co", receiverContact: "808", receiverEmail: "j@u.mil",
      receiverSignature: "data:image/png;base64,AAAA",
    }));
    expect(out.itemId).toBe("itm1");
    expect(out.sender.isDcsim).toBe(true);
    expect(out.receiver.isDcsim).toBe(false);
    expect(out.receiver.email).toBe("j@u.mil");
    expect(out.receiverSignature.startsWith("data:image/png;base64,")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- transfers.parse`
Expected: FAIL (old parser returns `itemMode`/`newItem`; `itemId` is `undefined` for non-"existing" or the test references removed shape).

- [ ] **Step 3: Simplify the parser**

Replace `src/app/actions/transfers.parse.ts`:
```ts
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const bool = (fd: FormData, k: string) => {
  const v = s(fd, k);
  return v === "on" || v === "true";
};

function party(fd: FormData, prefix: "sender" | "receiver") {
  return {
    isDcsim: bool(fd, `${prefix}IsDcsim`),
    name: s(fd, `${prefix}Name`),
    rank: s(fd, `${prefix}Rank`) || undefined,
    unit: s(fd, `${prefix}Unit`) || undefined,
    contact: s(fd, `${prefix}Contact`) || undefined,
    email: s(fd, `${prefix}Email`) || undefined,
  };
}

export function parseTransferForm(fd: FormData) {
  return {
    itemId: s(fd, "itemId"),
    sender: party(fd, "sender"),
    receiver: party(fd, "receiver"),
    receiverSignature: String(fd.get("receiverSignature") ?? ""),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- transfers.parse`
Expected: PASS.

- [ ] **Step 5: Simplify the transfer action; remove lookupLastHolderAction**

Replace `src/app/actions/transfers.ts`:
```ts
"use server";
import { requireUser } from "@/lib/authz";
import { createTransfer } from "@/modules/transfers/transfers.service";
import { transferSchema } from "@/modules/transfers/transfers.schema";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { sendReceiptEmails } from "@/modules/receipts/send-receipt-email";
import { receiptUrl } from "@/modules/items/qr";
import { parseTransferForm } from "./transfers.parse";

export async function createTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = parseTransferForm(formData);

  const parsed = transferSchema.safeParse({
    itemId: raw.itemId,
    sender: raw.sender,
    receiver: raw.receiver,
    receiverSignature: raw.receiverSignature,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  let receiptNumber: string;
  let t: Awaited<ReturnType<typeof createTransfer>>;
  try {
    t = await createTransfer({ ...parsed.data, createdByUserId: user.id });
    receiptNumber = t.receiptNumber;
  } catch (e) {
    if (e instanceof TransferError) {
      const map: Record<string, string> = {
        ITEM_NOT_FOUND: "That item no longer exists.",
        ITEM_RETIRED: "That item is retired and cannot be transferred.",
        RECEIPT_COLLISION: "Could not allocate a receipt number — please retry.",
      };
      return { error: map[e.code] ?? "Could not create the receipt." };
    }
    throw e;
  }

  try {
    await sendReceiptEmails({
      sender: parsed.data.sender,
      receiver: parsed.data.receiver,
      receiptNumber: t.receiptNumber,
      receiptUrl: receiptUrl(t.receiptNumber),
      itemSummary: t.itemSummary,
    });
  } catch (err) {
    console.error("[createTransferAction] receipt email failed:", err);
  }

  return { receiptNumber };
}
```
(`createItem`, `newItemSchema`, `getLastReceiver`, and `lookupLastHolderAction` are intentionally gone from this file.)

- [ ] **Step 6: Create the item-scoped transfer form**

Create `src/app/items/[id]/transfer/ItemTransferForm.tsx`:
```tsx
"use client";
import { useActionState, useState } from "react";
import { createTransferAction } from "@/app/actions/transfers";
import { SignaturePad } from "@/components/SignaturePad";

type Prefill = { isDcsim?: boolean; name?: string; rank?: string; unit?: string; contact?: string; email?: string };

function PartyFields({ role, prefill }: { role: "sender" | "receiver"; prefill?: Prefill }) {
  const [isDcsim, setIsDcsim] = useState(prefill?.isDcsim ?? false);
  const cap = role === "sender" ? "Sender" : "Recipient";
  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => setIsDcsim(e.target.checked)} />
        This side is DCSIM
      </label>
      <div className="field">
        <label className="label">{isDcsim ? "DCSIM technician name" : "Name"}</label>
        <input className="input" name={`${role}Name`} defaultValue={prefill?.name ?? ""} required />
      </div>
      {!isDcsim && (
        <div className="form-grid">
          <div className="field"><label className="label">Rank</label><input className="input" name={`${role}Rank`} defaultValue={prefill?.rank ?? ""} required /></div>
          <div className="field"><label className="label">Unit</label><input className="input" name={`${role}Unit`} defaultValue={prefill?.unit ?? ""} required /></div>
          <div className="field"><label className="label">Contact number</label><input className="input" name={`${role}Contact`} defaultValue={prefill?.contact ?? ""} required /></div>
          <div className="field"><label className="label">Email</label><input className="input" type="email" name={`${role}Email`} defaultValue={prefill?.email ?? ""} required /></div>
        </div>
      )}
    </fieldset>
  );
}

export function ItemTransferForm({ itemId, senderPrefill }: { itemId: string; senderPrefill?: Prefill }) {
  const [state, action, pending] = useActionState(createTransferAction, undefined);
  const receipt = state && "receiptNumber" in state ? state.receiptNumber : undefined;

  if (receipt) {
    return (
      <div className="card stack-sm">
        <h2 className="page-title">Receipt {receipt} created</h2>
        <div className="row">
          <a className="btn btn-primary" href={`/receipts/${receipt}/pdf`}>Download PDF</a>
          <a className="btn btn-secondary" href={`/receipts/${receipt}`}>View receipt</a>
          <a className="btn btn-ghost" href="/items">Back to items</a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      <input type="hidden" name="itemId" value={itemId} />
      <PartyFields role="sender" prefill={senderPrefill} />
      <PartyFields role="receiver" />
      <fieldset className="card stack-sm">
        <legend className="card__title">Recipient signature</legend>
        <SignaturePad name="receiverSignature" />
      </fieldset>
      <div className="row">
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Creating…" : "Create hand receipt"}</button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
```

- [ ] **Step 7: Create the item-scoped transfer page**

Create `src/app/items/[id]/transfer/page.tsx`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { getItem } from "@/modules/items/items.service";
import { getLastReceiver } from "@/modules/transfers/transfers.service";
import { SignOutButton } from "@/components/SignOutButton";
import { ItemTransferForm } from "./ItemTransferForm";

export default async function ItemTransferPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const item = await getItem(id);
  if (!item) notFound();

  const [dbUser, last] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { rank: true, name: true, unit: true, contactNumber: true, email: true, role: true } }),
    getLastReceiver(id),
  ]);

  // Sender pre-fill precedence: item's last-known holder > non-admin operator's
  // own account > empty (admin/DCSIM operators type the sender).
  const isAdmin = dbUser?.role === "ADMIN";
  const senderPrefill = last
    ? (last.isDcsim
        ? { isDcsim: true, name: last.name }
        : { isDcsim: false, name: last.name, rank: last.rank ?? "", unit: last.unit ?? "", contact: last.contact ?? "", email: last.email ?? "" })
    : (isAdmin ? undefined : { isDcsim: false, name: dbUser?.name ?? user.name, rank: dbUser?.rank ?? "", unit: dbUser?.unit ?? "", contact: dbUser?.contactNumber ?? "", email: dbUser?.email ?? user.email });

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
          <SignOutButton />
        </div>
      </header>
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Transfer: {item.make} {item.model}</h1>
          <p className="subtle">Serial {item.serialNumber}</p>
        </div>
        {item.status === "RETIRED" ? (
          <div className="card empty">This item is retired and cannot be transferred.</div>
        ) : (
          <ItemTransferForm itemId={item.id} senderPrefill={senderPrefill} />
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 8: Create the shared items list**

Create `src/app/items/page.tsx`:
```tsx
import Link from "next/link";
import { requireUser } from "@/lib/authz";
import { listItems } from "@/modules/items/items.service";
import { StatusBadge } from "@/components/StatusBadge";
import { SignOutButton } from "@/components/SignOutButton";
import { toggleItemStatusAction } from "@/app/admin/actions/items";

export default async function ItemsListPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const { q } = await searchParams;
  const items = await listItems({ search: q });

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          {isAdmin && <Link href="/admin/items/new" className="btn btn-ghost btn-sm">Log new item</Link>}
          {isAdmin && <Link href="/admin/users" className="btn btn-ghost btn-sm">Users</Link>}
          {isAdmin && <Link href="/admin/audit" className="btn btn-ghost btn-sm">Audit</Link>}
          <SignOutButton />
        </div>
      </header>
      <main className="container stack">
        <div className="row">
          <div>
            <h1 className="page-title">Items</h1>
            <p className="subtle">{items.length} item{items.length === 1 ? "" : "s"}</p>
          </div>
          {isAdmin && <Link href="/admin/items/new" className="btn btn-primary spacer">+ Log new item</Link>}
        </div>

        <form className="row" style={{ gap: 8 }}>
          <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search make, model, or serial number" style={{ maxWidth: 360 }} />
          <button className="btn btn-secondary">Search</button>
        </form>

        {items.length === 0 ? (
          <div className="card empty">No items match your search.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Make</th><th>Model</th><th>Serial</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.make}</td>
                    <td>{it.model}</td>
                    <td className="mono">{it.serialNumber}</td>
                    <td><StatusBadge status={it.status} /></td>
                    <td>
                      <div className="actions" style={{ justifyContent: "flex-end" }}>
                        {it.status === "ACTIVE" && <Link href={`/items/${it.id}/transfer`} className="btn btn-primary btn-sm">Transfer</Link>}
                        {isAdmin && <Link href={`/admin/items/${it.id}/edit`} className="btn btn-ghost btn-sm">Edit</Link>}
                        {isAdmin && (
                          <form action={toggleItemStatusAction}>
                            <input type="hidden" name="id" value={it.id} />
                            <input type="hidden" name="status" value={it.status === "RETIRED" ? "ACTIVE" : "RETIRED"} />
                            <button type="submit" className={`btn btn-sm ${it.status === "RETIRED" ? "btn-secondary" : "btn-danger"}`}>
                              {it.status === "RETIRED" ? "Reactivate" : "Retire"}
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 9: Rewire `/new` references and remove the old flow**

- In `src/app/actions/auth.ts`, `loginAction`: change `redirectTo: "/new"` → `redirectTo: "/items"`.
- In `src/app/page.tsx`, change the logged-in header link from `<Link href="/new" …>New receipt</Link>` to `<Link href="/items" …>Items</Link>`.
- **Repoint every bare `/admin/items` (list-route) reference to `/items`** — the list index page is being removed, so those would 404. Keep `/admin/items/new` and `/admin/items/[id]/edit` intact. Run `git grep -n "/admin/items\"" -- src` and update each hit:
  - `src/app/admin/layout.tsx`: the brand `<Link href="/admin/items" className="brand">` → `href="/items"`, and the nav `<Link href="/admin/items">Items</Link>` → `<Link href="/items">Items</Link>`.
  - `src/app/admin/page.tsx`: change its `redirect("/admin/items")` → `redirect("/items")`.
  - Any post-submit redirect or `revalidatePath("/admin/items")` targeting the list route in the admin item new/edit pages or `src/app/admin/actions/items.ts`: repoint the *redirect* targets to `/items` (a `revalidatePath("/admin/items")` may stay or be changed to `revalidatePath("/items")` — prefer `/items` since that's the live list now).
- Delete the old flow and admin list:
```bash
git rm -r src/app/new src/app/admin/items/page.tsx
```

- [ ] **Step 10: Full verification**

Run:
```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```
Expected: all green. Grep to confirm no live references remain to the removed symbols: `lookupLastHolderAction`, `NewTransferForm`, `/new`, `itemMode`, `parseTransferForm(`’s old shape. (`git grep -n "lookupLastHolderAction\|NewTransferForm\|\"/new\"\|itemMode"` → only matches in docs/plan files, none in `src/`.)

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(items): transfer from a shared item list; item-scoped form; retire /new"
```

---

## Task 4: Final verification & manual smoke checklist

**Files:** none (verification only), optional `docs/ARCHITECTURE.md` note.

- [ ] **Step 1: Full gates**

Run `npm test`, `npm run build` — both green.

- [ ] **Step 2: Document the manual smoke checklist** (record in the task report; a human runs it after deploy):
1. Logged out, open `/register` → create an account → lands on `/items`.
2. On `/items`, a non-admin sees Transfer buttons but no Log-new/Edit/Retire.
3. Click Transfer on an item → fill recipient (or DCSIM) → sign → receipt created; Download PDF opens a PDF whose FROM/TO line shows `RANK Name, Unit, Contact` within the box.
4. As admin, `/items` shows Log-new/Edit/Retire; logging a new item still works via `/admin/items/new`.
5. Login (`loginAction`) lands on `/items`; the `/new` route no longer exists.

- [ ] **Step 3: Commit any doc change** (skip if none).

---

## Self-Review (coverage map)

- **Transfer from item list** → Task 3 (`/items` + `/items/[id]/transfer`, `Transfer` per row).
- **Transfer-only for non-admins; log/edit/retire admin-only** → Task 3 (`isAdmin` gating on `/items`; admin routes unchanged).
- **Self-registration, active USER accounts, with unit/contact** → Task 2.
- **Account model (counterparty always typed; register only for peer initiator)** → no code needed beyond Task 2 (register) + existing typed-party form; enforced by "any login reaches the form."
- **Name line `RANK Name, Unit, Contact`, sized to fit** → Task 1 (`partyHeader` + `fitWidth`).
- **Remove `/new`; repoint redirect + headers + admin nav to `/items`** → Task 3 Step 9.
- **`/register` public** → Task 2 (proxy matcher).
