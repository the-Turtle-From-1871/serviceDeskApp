# Multiple Named Signatures (Admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin store several named signatures and pick which technician signs a property return, so the DA 2062 records who actually signed instead of the shared account holder.

**Architecture:** A new `Signature` table (name + PNG data URL, unique per admin). The return form posts a `signatureId`, and the server resolves it scoped to the acting admin — so the signer's name and image are read from the database, never trusted from the client. `processReturn` already accepts `processedBy: { id, name, email }`, so the technician's name flows in by passing a different `name` while `id` stays the real admin.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19, Prisma 7 over PostgreSQL, Zod, Vitest, TypeScript 5.

## Global Constraints

- **Auth first in every Server Action.** All new signature actions and the return action use `requireAdmin()` as their first statement (`src/lib/authz.ts`). `SessionUser = { id, role, name, email }`.
- **Never trust client-supplied signer identity.** A saved signature is selected by `signatureId` only; the server loads `{ name, image }` from the DB scoped to the acting admin's `userId`. The client never supplies a signer name or a saved image.
- **`processedByUserId` always remains the real acting admin**, while `processedByName` may be a different technician. That divergence is the point of the feature — do not "fix" it.
- Zod-validate input before use. Generic client-facing errors; `console.error` details server-side.
- Reuse `signatureError(s)` from `src/lib/signature.ts` for image validation — do NOT re-implement it. (It enforces the `data:image/png;base64,` prefix and `MAX_SIGNATURE_LEN = 250_000`.)
- Standard Prisma methods only. **No new npm packages.** No React component tests (no jsdom/testing-library in this project).
- **Test convention — `src/modules/**` uses REAL-DB integration tests**: `migrateTestDb()` in `beforeAll`, `resetDb()` in `beforeEach`, real `@/lib/prisma` (see `src/modules/items/units.service.test.ts`). Do NOT introduce `vi.mock` for Prisma in these. `migrateTestDb()` runs `prisma migrate deploy`, so a new migration reaches `handreceipt_test` automatically.
- `resetDb()` truncates `"Transfer","Item","User","Unit"` **CASCADE**; `Signature` (FK → User, `onDelete: Cascade`) is cleared automatically. Do NOT edit `tests/helpers/db.ts`.
- **`prisma migrate dev` CANNOT run here** (Prisma 7.8 hard-fails non-interactively). Author migrations via `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` → hand-made `prisma/migrations/<ts>_<name>/migration.sql` → `npx prisma migrate deploy` → `npx prisma generate`.
- **Do NOT touch the production database.** Prod is a separate, explicitly-confirmed step outside this plan.
- Run one test file with `npx vitest run <path>`. Full gates: `npx vitest run`, `npm run build`, `npm run lint` (0 errors; ~19 pre-existing warnings in unrelated test files are expected).

---

## File Structure

**Prisma**
- Modify: `prisma/schema.prisma` — new `Signature` model; `User.signatures` relation. `User.signatureImage` is **retained** (non-admin single signature).
- Create: `prisma/migrations/<ts>_named_signatures/migration.sql`.

**Signatures module** (`src/modules/signatures/`, new)
- Create: `signatures.errors.ts` — `SignatureError` (`"NOT_FOUND" | "DUPLICATE_NAME"`).
- Create: `signatures.schema.ts` (+ `signatures.schema.test.ts`) — `newSignatureSchema`.
- Create: `signatures.service.ts` (+ `signatures.service.test.ts`) — CRUD, owner-scoped.

**Actions**
- Create: `src/app/actions/signatures.ts` — `createSignatureAction`, `deleteSignatureAction` (admin-only).
- Modify: `src/app/actions/returns.ts` — resolve `signatureId`; drop the `saveSignature` write-back.

**UI**
- Create: `src/app/account/SignatureManager.tsx` — admin multi-signature manager.
- Modify: `src/app/account/page.tsx` — branch on role.
- Modify: `src/components/TechnicianSignatureField.tsx` — select-of-names + draw.
- Modify: `src/app/receipts/[receiptNumber]/return/ReturnForm.tsx` — pass `signatures`.
- Modify: `src/app/receipts/[receiptNumber]/return/page.tsx` — load `listSignatures`.

---

## Task 1: Prisma schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (`User` model ~line 14)
- Create: `prisma/migrations/<timestamp>_named_signatures/migration.sql`

**Interfaces:**
- Produces: model `Signature { id, userId, name, image, createdAt, updatedAt }` with `@@unique([userId, name])`; `User.signatures Signature[]`.

- [ ] **Step 1: Add the `User` back-relation**

In `prisma/schema.prisma`, inside `model User`, add to its relation list (next to `itemEdits`):

```prisma
  signatures       Signature[]          @relation("UserSignatures")
```

Leave `signatureImage String?` exactly as it is — non-admin accounts still use it.

- [ ] **Step 2: Add the `Signature` model**

Append to `prisma/schema.prisma`:

```prisma
// A named signature belonging to an ADMIN account. `name` is the technician the
// signature belongs to — it is printed on the DA 2062 as the signer when this
// signature is chosen on a return, so it is an identity, not a label.
// Non-admin accounts keep the single `User.signatureImage` instead.
model Signature {
  id        String   @id @default(cuid())
  user      User     @relation("UserSignatures", fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  name      String
  image     String   // PNG data URL
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId])
}
```

- [ ] **Step 3: Generate the migration SQL**

Run: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
Expected: DDL creating table `"Signature"`, a unique index on `("userId","name")`, an index on `("userId")`, and one FK to `"User"` with `ON DELETE CASCADE`.

- [ ] **Step 4: Save it as a migration and append the data step**

Create `prisma/migrations/<timestamp>_named_signatures/` (timestamp from `date -u +%Y%m%d%H%M%S`) and save the Step 3 output as `migration.sql`. Then **append** this data step to the end of that file:

```sql
-- Discard superseded single signatures for ADMIN accounts: admins now use named
-- signatures (table "Signature"). Non-admin rows are deliberately left alone —
-- they keep the single-signature model on User.signatureImage.
UPDATE "User" SET "signatureImage" = NULL WHERE "role" = 'ADMIN';
```

- [ ] **Step 5: Apply and generate**

Run: `npx prisma migrate deploy`
Expected: `All migrations have been successfully applied.`
Run: `npx prisma generate`
Run: `npx prisma migrate status`
Expected: `Database schema is up to date!`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(signatures): Signature model + migration"
```

---

## Task 2: Signatures module (schema, errors, service)

**Files:**
- Create: `src/modules/signatures/signatures.errors.ts`
- Create: `src/modules/signatures/signatures.schema.ts`
- Test: `src/modules/signatures/signatures.schema.test.ts`
- Create: `src/modules/signatures/signatures.service.ts`
- Test: `src/modules/signatures/signatures.service.test.ts`

**Interfaces:**
- Consumes: `signatureError` from `@/lib/signature`; Prisma `Signature` (Task 1).
- Produces:
  - `class SignatureError` with `code: "NOT_FOUND" | "DUPLICATE_NAME"`
  - `newSignatureSchema` → `{ name: string; image: string }`; `type NewSignatureInput`
  - `listSignatures(userId): Promise<{ id: string; name: string; image: string }[]>`
  - `createSignature(userId, input): Promise<Signature>`
  - `deleteSignature(id, userId): Promise<void>`
  - `getOwnedSignature(id, userId): Promise<{ name: string; image: string } | null>`

- [ ] **Step 1: Create the error type**

Create `src/modules/signatures/signatures.errors.ts`:

```typescript
export class SignatureError extends Error {
  constructor(public code: "NOT_FOUND" | "DUPLICATE_NAME", message?: string) {
    super(message ?? code);
    this.name = "SignatureError";
  }
}
```

- [ ] **Step 2: Write the failing schema test**

Create `src/modules/signatures/signatures.schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { newSignatureSchema } from "./signatures.schema";

const PNG = "data:image/png;base64,AAAA";

describe("newSignatureSchema", () => {
  it("accepts a name and a PNG data URL, trimming the name", () => {
    const parsed = newSignatureSchema.parse({ name: "  SGT Smith  ", image: PNG });
    expect(parsed).toEqual({ name: "SGT Smith", image: PNG });
  });

  it("requires a name", () => {
    expect(newSignatureSchema.safeParse({ name: "   ", image: PNG }).success).toBe(false);
  });

  it("rejects a non-PNG image via the shared signatureError validator", () => {
    const r = newSignatureSchema.safeParse({ name: "SGT Smith", image: "data:image/jpeg;base64,AAAA" });
    expect(r.success).toBe(false);
  });

  it("rejects an empty image", () => {
    expect(newSignatureSchema.safeParse({ name: "SGT Smith", image: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/modules/signatures/signatures.schema.test.ts`
Expected: FAIL — "Cannot find module './signatures.schema'".

- [ ] **Step 4: Implement the schema**

Create `src/modules/signatures/signatures.schema.ts`:

```typescript
import { z } from "zod";
import { signatureError } from "@/lib/signature";

// Image validation delegates to the shared `signatureError` (PNG data-URL prefix
// + MAX_SIGNATURE_LEN) so saved signatures obey the same rule as every other
// signature in the app.
export const newSignatureSchema = z.object({
  name: z.string().trim().min(1, "A name is required"),
  image: z.string().superRefine((v, ctx) => {
    const err = signatureError(v);
    if (err) ctx.addIssue({ code: "custom", message: err });
  }),
});

export type NewSignatureInput = z.infer<typeof newSignatureSchema>;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/modules/signatures/signatures.schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the failing service test (real DB)**

Create `src/modules/signatures/signatures.service.test.ts`:

```typescript
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { listSignatures, createSignature, deleteSignature, getOwnedSignature } from "./signatures.service";
import { SignatureError } from "./signatures.errors";

const PNG = "data:image/png;base64,AAAA";
let adminId: string;
let otherId: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const a = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  const b = await prisma.user.create({ data: { name: "Other", email: "b@x.co", passwordHash: "x", role: "ADMIN" } });
  adminId = a.id;
  otherId = b.id;
});

test("createSignature stores a named signature for the owner", async () => {
  const sig = await createSignature(adminId, { name: "SGT Smith", image: PNG });
  expect(sig.userId).toBe(adminId);
  expect(sig.name).toBe("SGT Smith");
  expect(sig.image).toBe(PNG);
});

test("createSignature rejects a duplicate name for the same admin", async () => {
  await createSignature(adminId, { name: "SGT Smith", image: PNG });
  await expect(createSignature(adminId, { name: "SGT Smith", image: PNG }))
    .rejects.toMatchObject({ code: "DUPLICATE_NAME" });
});

test("the same name is allowed for a different admin", async () => {
  await createSignature(adminId, { name: "SGT Smith", image: PNG });
  const sig = await createSignature(otherId, { name: "SGT Smith", image: PNG });
  expect(sig.userId).toBe(otherId);
});

test("listSignatures returns only the owner's, ordered by name", async () => {
  await createSignature(adminId, { name: "SSG Zulu", image: PNG });
  await createSignature(adminId, { name: "PFC Alpha", image: PNG });
  await createSignature(otherId, { name: "CPL Other", image: PNG });
  const list = await listSignatures(adminId);
  expect(list.map((s) => s.name)).toEqual(["PFC Alpha", "SSG Zulu"]);
});

test("deleteSignature removes the owner's signature", async () => {
  const sig = await createSignature(adminId, { name: "SGT Smith", image: PNG });
  await deleteSignature(sig.id, adminId);
  expect(await listSignatures(adminId)).toEqual([]);
});

test("deleteSignature refuses another admin's signature", async () => {
  const sig = await createSignature(otherId, { name: "CPL Other", image: PNG });
  await expect(deleteSignature(sig.id, adminId)).rejects.toBeInstanceOf(SignatureError);
  // still there — the other admin's row was untouched
  expect(await listSignatures(otherId)).toHaveLength(1);
});

test("getOwnedSignature returns name + image for the owner", async () => {
  const sig = await createSignature(adminId, { name: "SGT Smith", image: PNG });
  expect(await getOwnedSignature(sig.id, adminId)).toEqual({ name: "SGT Smith", image: PNG });
});

test("getOwnedSignature returns null for another admin's signature", async () => {
  const sig = await createSignature(otherId, { name: "CPL Other", image: PNG });
  expect(await getOwnedSignature(sig.id, adminId)).toBeNull();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/modules/signatures/signatures.service.test.ts`
Expected: FAIL — "Cannot find module './signatures.service'".

- [ ] **Step 8: Implement the service**

Create `src/modules/signatures/signatures.service.ts`:

```typescript
import type { Signature } from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newSignatureSchema, type NewSignatureInput } from "./signatures.schema";
import { SignatureError } from "./signatures.errors";

// Every read/write is scoped by `userId` so one admin can never see, use, or
// delete another admin's signature. Callers (server actions) pass the id from
// the authenticated session — never from client input.

export function listSignatures(userId: string): Promise<{ id: string; name: string; image: string }[]> {
  return prisma.signature.findMany({
    where: { userId },
    select: { id: true, name: true, image: true },
    orderBy: { name: "asc" },
  });
}

export async function createSignature(userId: string, input: NewSignatureInput): Promise<Signature> {
  const data = newSignatureSchema.parse(input);
  try {
    return await prisma.signature.create({ data: { ...data, userId } });
  } catch (e) {
    // P2002 = unique violation on (userId, name): this admin already has a
    // signature under that technician's name.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new SignatureError("DUPLICATE_NAME");
    }
    throw e;
  }
}

export async function deleteSignature(id: string, userId: string): Promise<void> {
  // deleteMany (not delete) so the userId scope is part of the WHERE clause —
  // a mismatched owner deletes nothing rather than throwing a Prisma error.
  const { count } = await prisma.signature.deleteMany({ where: { id, userId } });
  if (count === 0) throw new SignatureError("NOT_FOUND");
}

/** The authoritative lookup used when signing: resolves a signature the acting
 *  admin actually owns. Returns null for someone else's id or a bogus one, so a
 *  client can neither forge a signer name nor inject an image. */
export function getOwnedSignature(id: string, userId: string): Promise<{ name: string; image: string } | null> {
  return prisma.signature.findFirst({
    where: { id, userId },
    select: { name: true, image: true },
  });
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run src/modules/signatures/signatures.service.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 10: Commit**

```bash
git add src/modules/signatures
git commit -m "feat(signatures): owner-scoped named signature service"
```

---

## Task 3: Signature actions (admin-only)

**Files:**
- Create: `src/app/actions/signatures.ts`

**Interfaces:**
- Consumes: `createSignature`, `deleteSignature` (Task 2); `SignatureError` (Task 2); `requireAdmin` returning `SessionUser`.
- Produces:
  - `createSignatureAction(_prev, formData): Promise<{ ok: true } | { error: string }>`
  - `deleteSignatureAction(formData): Promise<void>`

- [ ] **Step 1: Create the actions**

Create `src/app/actions/signatures.ts`:

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createSignature, deleteSignature } from "@/modules/signatures/signatures.service";
import { newSignatureSchema } from "@/modules/signatures/signatures.schema";
import { SignatureError } from "@/modules/signatures/signatures.errors";

// Named signatures are an ADMIN capability: the only place a saved signature is
// used is the return flow, which is itself admin-only. The owner is always the
// authenticated admin — a userId is never accepted from the client.
export async function createSignatureAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newSignatureSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    image: String(formData.get("image") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await createSignature(admin.id, parsed.data);
  } catch (e) {
    if (e instanceof SignatureError && e.code === "DUPLICATE_NAME") {
      return { error: "You already have a signature saved under that name." };
    }
    console.error("[createSignatureAction] unexpected error:", e);
    return { error: "Something went wrong saving the signature. Please try again." };
  }
  revalidatePath("/account");
  return { ok: true as const };
}

export async function deleteSignatureAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  try {
    await deleteSignature(id, admin.id);
  } catch (e) {
    // A missing/foreign id is an expected no-op (double submit, stale page).
    if (!(e instanceof SignatureError)) {
      console.error("[deleteSignatureAction] unexpected error:", e);
    }
  }
  revalidatePath("/account");
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run build`
Expected: compiles with no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/actions/signatures.ts
git commit -m "feat(signatures): admin-only create/delete actions"
```

---

## Task 4: Account page — signature manager

**Files:**
- Create: `src/app/account/SignatureManager.tsx`
- Modify: `src/app/account/page.tsx` (imports 1-6; query line 16; Signature card 26-30)

**Interfaces:**
- Consumes: `createSignatureAction`, `deleteSignatureAction` (Task 3); `listSignatures` (Task 2); the existing `SignaturePad` (`@/components/SignaturePad`) and `SignatureSettings`.

- [ ] **Step 1: Create the manager**

Create `src/app/account/SignatureManager.tsx`:

```tsx
"use client";
import { useActionState, useState } from "react";
import { createSignatureAction, deleteSignatureAction } from "@/app/actions/signatures";
import { SignaturePad } from "@/components/SignaturePad";

export type SavedSignature = { id: string; name: string; image: string };

export function SignatureManager({ signatures }: { signatures: SavedSignature[] }) {
  const [state, action, pending] = useActionState(createSignatureAction, undefined);
  const [drawn, setDrawn] = useState("");

  return (
    <div className="stack-sm">
      {signatures.length === 0 ? (
        <p className="subtle">No saved signatures yet. Add one below.</p>
      ) : (
        <ul className="stack-sm">
          {signatures.map((s) => (
            <li key={s.id} className="row">
              <div>
                <div><strong>{s.name}</strong></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.image} alt={`Signature for ${s.name}`} className="sig-preview" />
              </div>
              <span className="spacer" />
              <form action={deleteSignatureAction}>
                <input type="hidden" name="id" value={s.id} />
                <button type="submit" className="btn btn-ghost btn-sm">Remove</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={action} className="stack-sm">
        <div className="field">
          <label className="label" htmlFor="sig-name">Technician name<span className="req"> *</span></label>
          <input id="sig-name" className="input" name="name" placeholder="e.g. SGT Smith" required />
        </div>
        <SignaturePad name="image" onChange={setDrawn} />
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={pending || drawn.length === 0}>
            {pending ? "Saving…" : "Add signature"}
          </button>
        </div>
        {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
        {state && "ok" in state && state.ok && <p className="alert-success">Signature added.</p>}
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Branch the account page on role**

In `src/app/account/page.tsx`:

(a) Add these imports after the existing ones (line 6):

```tsx
import { listSignatures } from "@/modules/signatures/signatures.service";
import { SignatureManager } from "./SignatureManager";
```

(b) Replace the query on line 16 with:

```tsx
  const isAdmin = user.role === "ADMIN";
  // Admins use named signatures; everyone else keeps the single saved signature.
  const [me, signatures] = await Promise.all([
    isAdmin ? Promise.resolve(null) : prisma.user.findUnique({ where: { id: user.id }, select: { signatureImage: true } }),
    isAdmin ? listSignatures(user.id) : Promise.resolve([]),
  ]);
```

(c) Replace the Signature card (lines 26-30) with:

```tsx
        <div className="card stack">
          <div className="card__title">Signature</div>
          {isAdmin ? (
            <>
              <p className="subtle">
                Save a signature for each technician. When you accept a return you pick who
                signed, and that name is printed on the hand receipt.
              </p>
              <SignatureManager signatures={signatures} />
            </>
          ) : (
            <>
              <p className="subtle">Save a signature to reuse it with one click when you accept returns.</p>
              <SignatureSettings current={me?.signatureImage ?? null} />
            </>
          )}
        </div>
```

- [ ] **Step 3: Verify build + lint**

Run: `npm run build`
Expected: compiles with no type errors.
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/account/SignatureManager.tsx src/app/account/page.tsx
git commit -m "feat(signatures): account manager for named signatures"
```

---

## Task 5: Return flow — sign as the technician who did the work

**Files:**
- Modify: `src/components/TechnicianSignatureField.tsx` (full rewrite)
- Modify: `src/app/receipts/[receiptNumber]/return/ReturnForm.tsx:9,13,81`
- Modify: `src/app/receipts/[receiptNumber]/return/page.tsx:22,36`
- Modify: `src/app/actions/returns.ts:10-11,31-34,37-48`

**Interfaces:**
- Consumes: `listSignatures`, `getOwnedSignature` (Task 2).
- Produces: the form posts `signatureId` (saved pick) OR `signature` (ad-hoc drawn image).

- [ ] **Step 1: Rewrite `TechnicianSignatureField`**

Replace the entire contents of `src/components/TechnicianSignatureField.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

export type PickableSignature = { id: string; name: string; image: string };

// Technician signing control. The admin picks WHICH technician signed from their
// saved named signatures, or draws an ad-hoc one (attributed to their own
// account name server-side).
//
// A saved pick posts only `signatureId` — never the name or the image. The
// server re-reads both from the DB scoped to the acting admin, so a client
// cannot forge a signer name, inject an image, or use another admin's
// signature. The image here is preview-only.
export function TechnicianSignatureField({
  name, signatures, onChange,
}: { name: string; signatures: PickableSignature[]; onChange?: (value: string) => void }) {
  const [selectedId, setSelectedId] = useState(signatures[0]?.id ?? "");
  const [drawn, setDrawn] = useState("");
  const picked = signatures.find((s) => s.id === selectedId);
  // Reported upward only so the parent can gate submit; not what gets posted.
  const value = picked ? picked.image : drawn;

  useEffect(() => { onChange?.(value); }, [value, onChange]);

  return (
    <div className="stack-sm">
      {signatures.length > 0 && (
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Who signed?</span>
          <select
            className="select"
            style={{ width: "auto", minWidth: 180 }}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="">Draw a new one…</option>
          </select>
        </label>
      )}

      {picked ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picked.image} alt={`Signature for ${picked.name}`} className="sig-preview" />
          <input type="hidden" name="signatureId" value={picked.id} />
        </>
      ) : (
        <>
          <SignaturePad onChange={setDrawn} />
          <p className="subtle">This will be recorded under your own name.</p>
          <input type="hidden" name={name} value={drawn} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `ReturnForm`**

In `src/app/receipts/[receiptNumber]/return/ReturnForm.tsx`:

(a) Change the import on line 5:

```tsx
import { TechnicianSignatureField, type PickableSignature } from "@/components/TechnicianSignatureField";
```

(b) Replace the signature on line 9 and the state on line 13:

```tsx
export function ReturnForm({ receiptNumber, held, signatures }: { receiptNumber: string; held: HeldItem[]; signatures: PickableSignature[] }) {
```
```tsx
  const [signature, setSignature] = useState(signatures[0]?.image ?? "");
```

(c) Replace line 81:

```tsx
        <TechnicianSignatureField name="signature" signatures={signatures} onChange={setSignature} />
```

Leave `canSubmit` (line 55) as-is — `signature.length > 0` still gates correctly, because the field reports the picked signature's image or the drawn one.

- [ ] **Step 3: Update the return page**

In `src/app/receipts/[receiptNumber]/return/page.tsx`:

(a) Replace the query on line 22:

```tsx
  const signatures = await listSignatures(admin.id);
```

(b) Replace the render on line 36:

```tsx
        <ReturnForm receiptNumber={t.receiptNumber} held={held} signatures={signatures} />
```

(c) Add this import with the others, and remove the now-unused `prisma` import if nothing else in the file uses it:

```tsx
import { listSignatures } from "@/modules/signatures/signatures.service";
```

- [ ] **Step 4: Resolve the signature server-side in the action**

In `src/app/actions/returns.ts`:

(a) Replace the two imports on lines 10-11:

```typescript
import { signatureError } from "@/lib/signature";
import { getOwnedSignature } from "@/modules/signatures/signatures.service";
```
(`updateUserSignature` is no longer used here — remove that import.)

(b) Replace lines 31-34 (the signature read + `saveSignature` flag) with:

```typescript
  // A saved pick arrives as an id only: re-read the name AND image from the DB,
  // scoped to this admin, so the signer identity cannot be forged from the
  // client. An ad-hoc drawn signature is recorded under the admin's own name.
  const signatureId = String(formData.get("signatureId") ?? "").trim();
  let signature: string;
  let signerName = admin.name;
  if (signatureId) {
    const owned = await getOwnedSignature(signatureId, admin.id);
    if (!owned) return { error: "That signature is no longer available. Pick another or draw one." };
    signature = owned.image;
    signerName = owned.name;
  } else {
    signature = String(formData.get("signature") ?? "");
    const sigErr = signatureError(signature);
    if (sigErr) return { error: sigErr };
  }
```

(c) In the `processReturn` call, replace the `processedBy` line so the technician's name is recorded while the acting account stays the admin:

```typescript
      // `id` stays the real acting admin (accountability); `name` is whoever
      // actually signed, which is what the DA 2062 prints.
      processedBy: { id: admin.id, name: signerName, email: admin.email },
```

(d) Delete the `saveSignature` write-back block (lines 45-48):

```typescript
    if (saveSignature) {
      try { await updateUserSignature(admin.id, signature); }
      catch (err) { console.error("[processReturnAction] save signature failed:", err); }
    }
```

Saving now happens on `/account` and requires a name.

- [ ] **Step 5: Verify**

Run: `npx vitest run src/modules`
Expected: PASS (no regressions; `returns.service.test.ts` is unaffected — `processReturn`'s signature did not change).
Run: `npm run build`
Expected: compiles with no type errors.
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/TechnicianSignatureField.tsx "src/app/receipts/[receiptNumber]/return/ReturnForm.tsx" "src/app/receipts/[receiptNumber]/return/page.tsx" src/app/actions/returns.ts
git commit -m "feat(signatures): pick the signing technician on a return"
```

---

## Task 6: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm no stale references to the removed paths**

Run: `npx tsc --noEmit 2>&1 | grep -iE "saveOptName|savedSignature|updateUserSignature" || echo "no stale references"`
Expected: `no stale references`.

Note: `updateUserSignature` (`src/modules/users/users.service.ts`) is still used by `saveSignatureAction` (`src/app/actions/account.ts`) for the non-admin single-signature path — it must NOT be deleted. Only the return action's call to it goes away.

- [ ] **Step 2: Full green checkpoint**

Run: `npx vitest run`
Expected: all suites pass.
Run: `npm run build`
Expected: success.
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Commit any fixes**

If Steps 1-2 required changes, commit them:

```bash
git add -A
git commit -m "fix(signatures): resolve final verification findings"
```

If nothing changed, skip this step.

---

## Self-Review

**Spec coverage:**
- `Signature` model, name + image, unique per admin → Task 1. ✓
- `User.signatureImage` retained for non-admins → Task 1 (explicitly untouched). ✓
- Existing signatures discarded for admins only → Task 1 Step 4 data step. ✓
- Owner-scoped service (list/create/delete/getOwned) → Task 2. ✓
- Duplicate name → domain error, not a 500 → Task 2 (`DUPLICATE_NAME`), surfaced in Task 3. ✓
- Admin-only actions, owner from session → Task 3 (`requireAdmin()`, `admin.id`). ✓
- Account page: manager for admins, `SignatureSettings` for others → Task 4. ✓
- Add/delete only (no rename) → Tasks 2-4. ✓
- Return form posts `signatureId`; server resolves name+image scoped to admin → Task 5 Steps 1, 4. ✓
- Ad-hoc draw → admin's own name → Task 5 Step 4 (`signerName = admin.name` default). ✓
- `processedByUserId` stays the real admin → Task 5 Step 4c (`id: admin.id`). ✓
- `saveOptName`/save-checkbox removed outright → Task 5 Steps 1-2, 4d. ✓
- Image validation reuses `signatureError` → Task 2 (schema) + Task 5 (ad-hoc path). ✓
- PDF unchanged → no task (verified: `render.ts` reads `processedByName`/`processedBySignature`). ✓
- Non-admin signature stays wired to nothing → no task (deliberate; `SignatureSettings` untouched). ✓
- Real-DB tests, no component tests → Task 2. ✓

**Placeholder scan:** No TBD/TODO. Every code step carries complete code; every test step carries real assertions. ✓

**Type consistency:** `SignatureError` codes (`NOT_FOUND`/`DUPLICATE_NAME`) defined in Task 2 are exactly the ones caught in Task 3. `listSignatures` returns `{ id, name, image }[]`, matching `SavedSignature` (Task 4) and `PickableSignature` (Task 5) field-for-field. `getOwnedSignature` returns `{ name, image } | null`, consumed as such in Task 5 Step 4b. `newSignatureSchema` keys (`name`, `image`) match the form fields in Task 4 Step 1 (`name="name"`, `SignaturePad name="image"`). `processedBy: { id, name, email }` matches `processReturn`'s existing parameter — unchanged. ✓

**Known follow-on (not in this plan):** applying the migration to production is a separate, explicitly-confirmed step. `MAX_SIGNATURE_BYTES = 5_000_000` in `transfers.schema.ts` (the *receipt* signature path) remains a separate follow-up; saved signatures already go through `signatureError`'s `MAX_SIGNATURE_LEN = 250_000`.
