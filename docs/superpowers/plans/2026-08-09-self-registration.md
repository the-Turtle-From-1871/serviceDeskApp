# Self-Registration & Scoped Receipts Implementation Plan (PR 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone create their own account, prove their email address, and land in the read-only `VIEWER` tier with a hand-receipt list scoped to receipts they are a party to.

**Architecture:** A `/register` page and `registerAction` follow the existing public-auth conventions (Turnstile, composite rate-limit keys, `after()`-deferred work for constant-time anti-enumeration). A hashed single-use `EmailVerificationToken` mirrors `PasswordResetToken` exactly. Sign-in is refused until verified via a typed `CredentialsSignin` code, so the "check your email" message is only ever shown to someone who supplied the **correct password** — it is never an enumeration oracle. A new `/receipts` list filters on the viewer's **verified** email unless they hold `VIEW_ALL_RECEIPTS`.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Auth.js v5 (Credentials, JWT), Prisma 7 + PostgreSQL 16, Zod, Vitest, Cloudflare Turnstile, Gmail OAuth sender.

## Global Constraints

- **`VIEWER` is the only role registration may create.** `registerSchema` already omits `role`; do not reintroduce it.
- **Anti-enumeration is not optional.** `registerAction` returns one generic success for every outcome, with all account work deferred through `after()` so response time reveals nothing. This is the same construction, and the same reason, as `requestPasswordResetAction`.
- **Never reveal "this address is registered but unverified" to someone who did not supply the correct password.** The distinct sign-in message is gated on a successful bcrypt compare inside `authorize`.
- **Rate limit: spend before the work, NEVER refund.** Registration and resend are volume-abuse surfaces, exactly like `requestPasswordResetAction`. Do not copy `loginAction`'s refund.
- **Charge the narrow bucket first, the shared ceiling second** (`spendAuthBudget` already does this — reuse it, do not hand-roll).
- **One capability = one scope.** New scopes are `"register"` and `"verify-resend"`. Neither may borrow `"login"`.
- **Every emailed link uses `defaultBaseUrl()`** (`APP_URL` = `https://www.dcsim.us`). A `vercel.app` link in the body is what previously broke `.mil` delivery — this is a delivery requirement, not a preference.
- **The public surface does not move.** `/receipts/<number>`, `/receipts/<number>/pdf` and `/i/<id>` stay public + PIN-gated. This PR adds a *list*; it narrows nothing that is already reachable.
- **`/receipts` list must be server-side paginated** (`take` + keyset) and must `select` only rendered columns — never signature blobs. Items is 1,200+ rows and receipts grow with it.
- **Existing accounts must not be locked out** — the migration backfills `emailVerifiedAt` for every existing row.
- **Run `npm test` alone**; concurrent runs truncate the shared test DB. CI does not run tests.
- **Docs ship in the same commit as the code** (Task 10 is not optional).

## Reference

Spec: `docs/superpowers/specs/2026-08-08-capability-permissions-and-self-registration-design.md` §3, §4, §7.
PR 1 (merged, `adebad8`) provides `Capability`, `VIEWER`, `requireCapability`, `capabilities.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` *(modify)* | `User.emailVerifiedAt`, `EmailVerificationToken` model. |
| `prisma/migrations/20260809120000_email_verification/migration.sql` *(create)* | DDL + backfill. |
| `src/lib/email-verification.ts` *(create)* | Create/consume a hashed single-use token. Mirrors `password-reset.ts`. |
| `src/lib/email-verification.test.ts` *(create)* | Its tests. |
| `src/modules/auth/send-verification-email.ts` *(create)* | The verification email. Mirrors `send-password-reset-email.ts`. |
| `src/modules/users/users.service.ts` *(modify)* | `createSelfRegisteredUser`. |
| `src/app/actions/auth.ts` *(modify)* | `registerAction`, `resendVerificationAction`, unverified branch in `loginAction`. |
| `src/auth.ts` *(modify)* | `authorize` refuses unverified with a typed code. |
| `src/app/register/page.tsx` + `RegisterForm.tsx` *(create)* | The sign-up surface. |
| `src/app/verify-email/page.tsx` *(create)* | Consumes the token. |
| `src/modules/transfers/transfers.service.ts` *(modify)* | `listReceipts({ viewerEmail, all, cursor })`. |
| `src/app/receipts/page.tsx` *(create)* | The scoped list. |
| `src/components/nav.ts` *(modify)* | Copy + a Receipts entry. |
| `src/app/page.tsx`, `src/app/login/page.tsx` *(modify)* | Copy + "Create account". |
| `CLAUDE.md`, `docs/SECURITY.md`, `CHANGELOG.md` *(modify)* | Documentation. |

---

## Task 1: Schema and migration

**Files:** Modify `prisma/schema.prisma`; create `prisma/migrations/20260809120000_email_verification/migration.sql`

**Interfaces:** Produces `User.emailVerifiedAt` and `prisma.emailVerificationToken`.

- [ ] **Step 1: Add the column and model**

In the `User` model, after `passwordChangedAt`:

```prisma
  // Set when the address is proved by clicking the emailed link. NULL means
  // unproved: sign-in is refused (src/auth.ts) and the address is never used to
  // scope the hand-receipt list, because an unproved address is a claim about
  // someone else's mail, not evidence.
  emailVerifiedAt   DateTime?
```

Add to the `User` relation block:

```prisma
  emailVerifications  EmailVerificationToken[] @relation("EmailVerifications")
```

And the model, beside `PasswordResetToken`:

```prisma
// Proves control of an email address at sign-up. Only the SHA-256 hash of the
// emailed token is stored, so a DB leak cannot be used to verify someone else's
// address. Single-use (usedAt) + expiry, exactly like PasswordResetToken.
model EmailVerificationToken {
  id        String    @id @default(cuid())
  user      User      @relation("EmailVerifications", fields: [userId], references: [id], onDelete: Cascade)
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260809120000_email_verification/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- Backfill: every EXISTING account was provisioned by an administrator, so its
-- address is already trusted. Without this they would all be refused sign-in on
-- deploy, waiting for a verification email they never received — an outage.
UPDATE "User" SET "emailVerifiedAt" = now() WHERE "emailVerifiedAt" IS NULL;

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerificationToken_userId_idx" ON "EmailVerificationToken"("userId");

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

> The `mdm-import@service.invalid` row is backfilled too. That is correct and changes nothing: it is `isActive: false`, which is what makes it non-loginable, and `deactivatedAt` stays NULL so the purge worker keeps ignoring it.

- [ ] **Step 3: Normalize line endings BEFORE applying**

The checksum `migrate deploy` records must match the file's final on-disk form, and git rewrites LF to CRLF on checkout in this repo:

```bash
git add prisma/migrations/20260809120000_email_verification/migration.sql
rm prisma/migrations/20260809120000_email_verification/migration.sql
git checkout -- prisma/migrations/20260809120000_email_verification/migration.sql
```

- [ ] **Step 4: Apply and generate**

```bash
npx prisma migrate deploy
npx prisma generate
```

Expected: `1 migration applied`, then a successful generation.

- [ ] **Step 5: Verify the backfill left nobody unverified**

```bash
npx prisma migrate diff --from-config-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script
```

Expected: `-- This is an empty migration.`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260809120000_email_verification
git commit -m "feat(auth): add emailVerifiedAt and EmailVerificationToken"
```

---

## Task 2: The verification token module

**Files:** Create `src/lib/email-verification.ts`, `src/lib/email-verification.test.ts`

**Interfaces:**
- Consumes: `generateResetToken`, `hashToken` from `@/lib/reset-token` (already generic — 32 random bytes + SHA-256).
- Produces:
  - `createEmailVerificationToken(userId: string): Promise<string>` — returns the RAW token
  - `verifyEmailWithToken(rawToken: string): Promise<{ ok: true; userId: string } | { ok: false }>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/email-verification.test.ts`. Match the mocking style of `src/lib/password-reset.test.ts` — read it first and follow it rather than inventing a second style:

```ts
import { describe, expect, test, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const create = vi.fn();
const userUpdate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: {
    emailVerificationToken: {
      create: (a: unknown) => create(a),
      findUnique: (a: unknown) => findUnique(a),
      updateMany: (a: unknown) => updateMany(a),
    },
    user: { update: (a: unknown) => userUpdate(a) },
  },
}));

import { createEmailVerificationToken, verifyEmailWithToken } from "./email-verification";
import { hashToken } from "./reset-token";

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 1 });
  userUpdate.mockResolvedValue({});
});

test("stores only the HASH of the token, never the raw value", async () => {
  const raw = await createEmailVerificationToken("u1");
  const arg = create.mock.calls[0][0];
  expect(arg.data.tokenHash).toBe(hashToken(raw));
  expect(JSON.stringify(arg)).not.toContain(raw);
});

test("refuses an unknown token", async () => {
  findUnique.mockResolvedValue(null);
  expect(await verifyEmailWithToken("nope")).toEqual({ ok: false });
  expect(userUpdate).not.toHaveBeenCalled();
});

test("refuses an expired token", async () => {
  findUnique.mockResolvedValue({
    id: "t1", userId: "u1", usedAt: null,
    expiresAt: new Date(Date.now() - 1000),
  });
  expect(await verifyEmailWithToken("x")).toEqual({ ok: false });
  expect(userUpdate).not.toHaveBeenCalled();
});

test("refuses an already-used token", async () => {
  findUnique.mockResolvedValue({
    id: "t1", userId: "u1", usedAt: new Date(),
    expiresAt: new Date(Date.now() + 1000),
  });
  expect(await verifyEmailWithToken("x")).toEqual({ ok: false });
  expect(userUpdate).not.toHaveBeenCalled();
});

// Two clicks on the same emailed link must not both verify. The claim is a
// compare-and-set, so the loser sees count === 0 and bails.
test("refuses when a concurrent request already claimed the token", async () => {
  findUnique.mockResolvedValue({
    id: "t1", userId: "u1", usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  updateMany.mockResolvedValue({ count: 0 });
  expect(await verifyEmailWithToken("x")).toEqual({ ok: false });
  expect(userUpdate).not.toHaveBeenCalled();
});

test("stamps emailVerifiedAt and returns the user id on success", async () => {
  findUnique.mockResolvedValue({
    id: "t1", userId: "u1", usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(await verifyEmailWithToken("x")).toEqual({ ok: true, userId: "u1" });
  const arg = userUpdate.mock.calls[0][0];
  expect(arg.where).toEqual({ id: "u1" });
  expect(arg.data.emailVerifiedAt).toBeInstanceOf(Date);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run email-verification.test`
Expected: FAIL — `Failed to resolve import "./email-verification"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/email-verification.ts`:

```ts
import "server-only";
import prisma from "@/lib/prisma";
import { generateResetToken, hashToken } from "@/lib/reset-token";

// 24 hours. Longer than a password reset's hour: a reset is a response to
// something the user is doing right now, while a sign-up confirmation is often
// opened the next morning, and an expired link there reads as a broken product.
const EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Creates a single-use verification token and returns the RAW value to email.
 *  Only its hash is stored, so a DB leak cannot be used to verify an address. */
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const raw = generateResetToken();
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + EXPIRY_MS) },
  });
  return raw;
}

/** Validates and consumes the token, stamping the user's emailVerifiedAt.
 *  Returns `{ ok: false }` for a token that is unknown, expired, already used,
 *  or lost the race to a concurrent claim. */
export async function verifyEmailWithToken(
  rawToken: string,
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return { ok: false };

  // Claim it BEFORE the user write (compare-and-set), so two clicks on the same
  // link cannot both proceed — the loser gets count === 0. Same shape as
  // resetPasswordWithToken.
  const claim = await prisma.emailVerificationToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false };

  await prisma.user.update({
    where: { id: row.userId },
    data: { emailVerifiedAt: new Date() },
  });
  return { ok: true, userId: row.userId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run email-verification.test`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-verification.ts src/lib/email-verification.test.ts
git commit -m "feat(auth): add single-use hashed email verification tokens"
```

---

## Task 3: The verification email

**Files:** Create `src/modules/auth/send-verification-email.ts`, `src/modules/auth/send-verification-email.test.ts`

**Interfaces:** Produces `sendVerificationEmail({ to, name, verifyUrl }, { sender? })`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test, vi } from "vitest";
import { sendVerificationEmail } from "./send-verification-email";

function fakeSender() {
  const send = vi.fn().mockResolvedValue(undefined);
  return { sender: { send }, send };
}

test("sends a multipart message carrying the verification link", async () => {
  const { sender, send } = fakeSender();
  await sendVerificationEmail(
    { to: "a@b.mil", name: "Jane", verifyUrl: "https://www.dcsim.us/verify-email?token=abc" },
    { sender },
  );
  const msg = send.mock.calls[0][0];
  expect(msg.to).toBe("a@b.mil");
  expect(msg.subject).toMatch(/confirm/i);
  expect(msg.text).toContain("https://www.dcsim.us/verify-email?token=abc");
  expect(msg.html).toContain("https://www.dcsim.us/verify-email?token=abc");
});

// A crafted display name must not be able to inject markup into the HTML part.
test("escapes the recipient name in the HTML body", async () => {
  const { sender, send } = fakeSender();
  await sendVerificationEmail(
    { to: "a@b.mil", name: "<script>x</script>", verifyUrl: "https://x.test/v" },
    { sender },
  );
  expect(send.mock.calls[0][0].html).not.toContain("<script>");
});

test("propagates a send failure so the caller decides", async () => {
  const send = vi.fn().mockRejectedValue(new Error("smtp down"));
  await expect(
    sendVerificationEmail({ to: "a@b.mil", name: "J", verifyUrl: "https://x.test/v" }, { sender: { send } }),
  ).rejects.toThrow("smtp down");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run send-verification-email.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/modules/auth/send-verification-email.ts`, mirroring `send-password-reset-email.ts`:

```ts
import { getEmailSender, type EmailSender, escapeHtml } from "@/lib/email";

export type VerificationEmailArgs = { to: string; name: string; verifyUrl: string };

// Multipart (text + HTML) for the same deliverability reason as the reset mail.
// Errors propagate; the caller decides. Every link is built from
// defaultBaseUrl() by the caller — a vercel.app link in the body is what broke
// .mil delivery before.
export async function sendVerificationEmail(
  args: VerificationEmailArgs,
  deps: { sender?: EmailSender } = {},
): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const greeting = args.name ? `Hello ${args.name},` : "Hello,";

  const text = [
    greeting,
    ``,
    `An account was created for you on the DCSIM Hand Receipt system.`,
    ``,
    `Confirm this email address to finish signing up (the link expires in 24 hours):`,
    args.verifyUrl,
    ``,
    `Until you confirm, you will not be able to sign in.`,
    ``,
    `If you didn't create this account, you can ignore this email — no account will be usable without this confirmation.`,
  ].join("\n");

  const url = escapeHtml(args.verifyUrl);
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:480px;margin:0 auto;padding:8px">`,
    `<p style="font-weight:600;font-size:16px;margin:0 0 12px">DCSIM Hand Receipt</p>`,
    `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 16px">An account was created for you on the DCSIM Hand Receipt system. Confirm this email address to finish signing up.</p>`,
    `<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Confirm your email</a></p>`,
    `<p style="margin:0 0 16px;color:#64748b;font-size:13px">This link expires in 24 hours. If the button doesn&rsquo;t work, paste this address into your browser:<br><a href="${url}" style="color:#4f46e5;word-break:break-all">${url}</a></p>`,
    `<p style="margin:0;color:#64748b;font-size:13px">If you didn&rsquo;t create this account, you can ignore this email &mdash; it cannot be used until it is confirmed.</p>`,
    `</div>`,
  ].join("");

  await sender.send({ to: args.to, subject: "Confirm your DCSIM Hand Receipt email", text, html });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run send-verification-email.test`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/send-verification-email.ts src/modules/auth/send-verification-email.test.ts
git commit -m "feat(auth): add the email verification message"
```

---

## Task 4: `registerAction`

**Files:** Modify `src/app/actions/auth.ts`; modify `src/modules/users/users.service.ts`; create `src/app/actions/auth.register.test.ts`

**Interfaces:**
- Produces `registerAction(_prev, formData)` returning `{ ok: true } | { error: string }`, and `createSelfRegisteredUser(input: RegisterInput): Promise<User>`.

- [ ] **Step 1: Add the service function**

In `src/modules/users/users.service.ts`:

```ts
import { newUserSchema, registerSchema, type NewUserInput, type RegisterInput } from "./users.schema";

// Self-registration. Deliberately its OWN function rather than createUser with a
// role argument: there must be exactly one code path that can mint an account
// from an unauthenticated request, and it must not be able to choose a role.
// VIEWER is hard-coded here, and emailVerifiedAt is left NULL — the address is
// an unproved claim until the emailed link is clicked.
export async function createSelfRegisteredUser(input: RegisterInput) {
  const data = registerSchema.parse(input);
  return prisma.user.create({
    data: {
      rank: data.rank,
      name: data.name,
      email: data.email,
      unit: data.unit,
      contactNumber: data.contactNumber,
      role: "VIEWER",
      passwordHash: await hashPassword(data.password),
    },
  });
}
```

- [ ] **Step 2: Write the failing test**

Create `src/app/actions/auth.register.test.ts`, following the mocking style of `src/app/actions/auth.rate-limit.test.ts` (read it first):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const consumeRateLimit = vi.fn();
const resetRateLimit = vi.fn();
const verifyTurnstile = vi.fn();
const findUnique = vi.fn();
const createSelfRegisteredUser = vi.fn();
const createEmailVerificationToken = vi.fn();
const sendVerificationEmail = vi.fn();
const afterCallbacks: (() => Promise<void>)[] = [];

vi.mock("next/server", () => ({ after: (cb: () => Promise<void>) => afterCallbacks.push(cb) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/prisma", () => ({ default: { user: { findUnique: (a: unknown) => findUnique(a) } } }));
vi.mock("@/modules/users/users.service", () => ({
  createSelfRegisteredUser: (i: unknown) => createSelfRegisteredUser(i),
}));
vi.mock("@/lib/email-verification", () => ({
  createEmailVerificationToken: (id: string) => createEmailVerificationToken(id),
}));
vi.mock("@/modules/auth/send-verification-email", () => ({
  sendVerificationEmail: (a: unknown) => sendVerificationEmail(a),
}));

import { registerAction } from "./auth";

function form(over: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("name", "Jane Doe");
  fd.set("email", "jane@unit.mil");
  fd.set("password", "correct horse battery");
  fd.set("cf-turnstile-response", "tok");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

async function runDeferred() {
  while (afterCallbacks.length) await afterCallbacks.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  consumeRateLimit.mockResolvedValue({ allowed: true });
  verifyTurnstile.mockResolvedValue({ ok: true, status: "verified" });
  findUnique.mockResolvedValue(null);
  createSelfRegisteredUser.mockResolvedValue({ id: "u1", email: "jane@unit.mil", name: "Jane Doe" });
  createEmailVerificationToken.mockResolvedValue("rawtoken");
});

it("returns the SAME generic success whether or not the address is already registered", async () => {
  const fresh = await registerAction(undefined, form());
  findUnique.mockResolvedValue({ id: "existing", isActive: true, emailVerifiedAt: new Date() });
  const taken = await registerAction(undefined, form());
  expect(fresh).toEqual(taken);
  expect(fresh).toEqual({ ok: true });
});

it("never creates a second account for an address that already exists", async () => {
  findUnique.mockResolvedValue({ id: "existing", isActive: true, emailVerifiedAt: new Date() });
  await registerAction(undefined, form());
  await runDeferred();
  expect(createSelfRegisteredUser).not.toHaveBeenCalled();
});

it("creates the account and emails a link for a new address", async () => {
  await registerAction(undefined, form());
  await runDeferred();
  expect(createSelfRegisteredUser).toHaveBeenCalledTimes(1);
  expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  expect(sendVerificationEmail.mock.calls[0][0].verifyUrl).toContain("/verify-email?token=rawtoken");
});

it("does the account work AFTER responding, so response time reveals nothing", async () => {
  await registerAction(undefined, form());
  expect(createSelfRegisteredUser).not.toHaveBeenCalled(); // still deferred
  await runDeferred();
  expect(createSelfRegisteredUser).toHaveBeenCalledTimes(1);
});

it("rejects a malformed email before spending anything", async () => {
  const res = await registerAction(undefined, form({ email: "nope" }));
  expect(res).toMatchObject({ error: expect.any(String) });
  expect(consumeRateLimit).not.toHaveBeenCalled();
});

it("refuses a submission carrying no Turnstile token", async () => {
  const fd = form();
  fd.delete("cf-turnstile-response");
  const res = await registerAction(undefined, fd);
  expect(res).toMatchObject({ error: expect.any(String) });
  expect(createSelfRegisteredUser).not.toHaveBeenCalled();
});

// Volume IS the abuse here, so a success must not hand the token back.
it("never refunds a rate-limit token on success", async () => {
  await registerAction(undefined, form());
  await runDeferred();
  expect(resetRateLimit).not.toHaveBeenCalled();
});
```

> The rate-limit and Turnstile mocks must match how `auth.rate-limit.test.ts` already stubs `@/lib/rate-limit` and `@/lib/turnstile`. Copy that file's `vi.mock` blocks verbatim rather than writing new ones.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run auth.register.test`
Expected: FAIL — `registerAction is not a function`.

- [ ] **Step 4: Write `registerAction`**

Append to `src/app/actions/auth.ts`:

```ts
// PUBLIC BY DESIGN: registration is an unauthenticated entry point, like login
// and the reset request (reviewed exception to "auth-first").
//
// Modelled on requestPasswordResetAction, NOT on loginAction, and the difference
// matters: there is no "failed attempt" to charge here and nothing is ever
// refunded, because with registration the abuse IS volume. Copying login's
// refund would make the budget unlimited for anyone willing to succeed once.
export async function registerAction(_prev: unknown, formData: FormData) {
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  // Shape-check BEFORE spending anything — same ordering rule as loginAction:
  // junk must not reach the budget, or 60 malformed POSTs drain the shared
  // per-network ceiling and lock out everyone behind that egress.
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }
  const input = parsed.data;

  // Free to detect, and charging for it would double-punish the one population
  // that can never succeed — a visitor whose network blocks Cloudflare.
  if (missingTurnstileToken(formData)) return CHALLENGE_FAILED();

  const keys = await identityRateLimitKeys("register", input.email);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  const refused = await challenge(formData, keys.ip);
  if (refused) return refused;

  // Everything that could reveal whether this address is already registered runs
  // AFTER the response, so the action returns in ~constant time either way. The
  // return value below is identical for every outcome.
  after(async () => {
    try {
      const base = defaultBaseUrl().replace(/\/$/, "");
      if (!base) {
        console.error("[registerAction] no base URL configured (set APP_URL); skipping verification email");
        return;
      }

      const existing = await prisma.user.findUnique({ where: { email: input.email } });
      if (existing) {
        // Deliberately NOT a second account, and deliberately not an error the
        // caller can see. Telling the real owner that someone tried is useful;
        // telling the submitter would be an enumeration oracle.
        console.info("[registerAction] registration attempted for an existing address");
        return;
      }

      const user = await createSelfRegisteredUser(input);
      const raw = await createEmailVerificationToken(user.id);
      await sendVerificationEmail({
        to: user.email,
        name: user.name,
        verifyUrl: `${base}/verify-email?token=${raw}`,
      });
    } catch (e) {
      console.error("[registerAction] deferred work failed:", e);
    }
  });

  return { ok: true as const };
}
```

Add the imports at the top of the file:

```ts
import { registerSchema } from "@/modules/users/users.schema";
import { createSelfRegisteredUser } from "@/modules/users/users.service";
import { createEmailVerificationToken } from "@/lib/email-verification";
import { sendVerificationEmail } from "@/modules/auth/send-verification-email";
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run auth.register.test`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/auth.ts src/modules/users/users.service.ts src/app/actions/auth.register.test.ts
git commit -m "feat(auth): add self-service registration behind Turnstile and a rate limit"
```

---

## Task 5: Refuse sign-in until the address is verified

**Files:** Modify `src/auth.ts`, `src/app/actions/auth.ts`; create `src/app/actions/auth.verify-gate.test.ts`

**Interfaces:** Produces the sign-in refusal and `resendVerificationAction`.

The message must be shown ONLY to a caller who supplied the correct password. If an unverified account could be detected from the email alone, the login form becomes an oracle for "is this address registered". So the check sits AFTER the bcrypt compare, and the outcome travels back as a typed `CredentialsSignin` code.

- [ ] **Step 1: Write the failing test**

Create `src/app/actions/auth.verify-gate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const verifyPassword = vi.fn();

vi.mock("@/lib/prisma", () => ({ default: { user: { findUnique: (a: unknown) => findUnique(a) } } }));
vi.mock("@/lib/password", () => ({ verifyPassword: (a: string, b: string) => verifyPassword(a, b) }));

import { authorizeCredentials, EMAIL_NOT_VERIFIED } from "@/auth";

beforeEach(() => {
  vi.clearAllMocks();
  verifyPassword.mockResolvedValue(true);
});

it("admits a verified, active account", async () => {
  findUnique.mockResolvedValue({
    id: "u1", name: "J", email: "j@x.mil", role: "VIEWER", passwordHash: "h",
    isActive: true, emailVerifiedAt: new Date(),
  });
  await expect(authorizeCredentials({ email: "j@x.mil", password: "pw" }))
    .resolves.toMatchObject({ id: "u1" });
});

it("refuses an unverified account with a DISTINCT code, not a generic null", async () => {
  findUnique.mockResolvedValue({
    id: "u1", name: "J", email: "j@x.mil", role: "VIEWER", passwordHash: "h",
    isActive: true, emailVerifiedAt: null,
  });
  await expect(authorizeCredentials({ email: "j@x.mil", password: "pw" }))
    .rejects.toMatchObject({ code: EMAIL_NOT_VERIFIED });
});

// The oracle guard: a WRONG password on an unverified account must be
// indistinguishable from any other wrong password.
it("returns a generic null when the password is wrong, even if unverified", async () => {
  verifyPassword.mockResolvedValue(false);
  findUnique.mockResolvedValue({
    id: "u1", name: "J", email: "j@x.mil", role: "VIEWER", passwordHash: "h",
    isActive: true, emailVerifiedAt: null,
  });
  await expect(authorizeCredentials({ email: "j@x.mil", password: "bad" })).resolves.toBeNull();
});

it("checks the password BEFORE the verification state", async () => {
  findUnique.mockResolvedValue({
    id: "u1", name: "J", email: "j@x.mil", role: "VIEWER", passwordHash: "h",
    isActive: true, emailVerifiedAt: null,
  });
  await authorizeCredentials({ email: "j@x.mil", password: "pw" }).catch(() => {});
  expect(verifyPassword).toHaveBeenCalledTimes(1);
});

it("returns null for an unknown or inactive account without touching bcrypt", async () => {
  findUnique.mockResolvedValue(null);
  await expect(authorizeCredentials({ email: "nobody@x.mil", password: "pw" })).resolves.toBeNull();
  expect(verifyPassword).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run auth.verify-gate.test`
Expected: FAIL — `authorizeCredentials` is not exported.

- [ ] **Step 3: Extract and extend `authorize` in `src/auth.ts`**

Extracting the callback makes it unit-testable without booting Auth.js:

```ts
import { CredentialsSignin } from "next-auth";

/** Distinguishes "right password, unverified address" from every other
 *  credential failure. Travels back to loginAction as `?code=` on the error URL
 *  that @auth/core returns. */
export const EMAIL_NOT_VERIFIED = "email_not_verified";

class EmailNotVerifiedError extends CredentialsSignin {
  code = EMAIL_NOT_VERIFIED;
}

/**
 * Exported for unit tests. ORDER IS LOAD-BEARING: the password is checked
 * BEFORE the verification state, so an unverified account is only ever
 * disclosed to someone who already proved they hold the password. Checking
 * verification first would turn the login form into an oracle for "is this
 * address registered".
 */
export async function authorizeCredentials(raw: unknown) {
  const parsed = credsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  if (!user.emailVerifiedAt) throw new EmailNotVerifiedError();
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}
```

Then point the provider at it: `authorize: authorizeCredentials,`

- [ ] **Step 4: Handle the code in `loginAction`**

In `src/app/actions/auth.ts`, replace the destination error check:

```ts
  // The other shape of failure: @auth/core returned an error URL instead of
  // throwing. Treated identically to a thrown AuthError — EXCEPT for the
  // unverified-email code, which means the password was RIGHT and so must not
  // be counted as a credential failure or reported as one.
  if (/[?&]error=/.test(destination)) {
    if (destination.includes(`code=${EMAIL_NOT_VERIFIED}`)) {
      return { unverified: true as const, email };
    }
    await recordAuthFailure("login");
    return { error: "Invalid email or password." };
  }
```

And in the thrown-`AuthError` branch, check `error.code` for the same value before calling `recordAuthFailure`, returning the same `{ unverified: true, email }`.

`LoginForm` renders that state as: *"Confirm your email address before signing in. We sent a link to {email}."* plus a **Resend the link** button wired to `resendVerificationAction`.

- [ ] **Step 5: Add `resendVerificationAction`**

```ts
// Its OWN rate-limit scope. Sharing "register" would let a resend flood spend
// the budget that stops account-creation spam, and vice versa.
export async function resendVerificationAction(_prev: unknown, formData: FormData) {
  const parsed = emailField.safeParse(String(formData.get("email") ?? ""));
  if (!parsed.success) return { error: "Enter a valid email address." };
  const email = parsed.data;

  const keys = await identityRateLimitKeys("verify-resend", email);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  // Deferred and generic, for the same anti-enumeration reason as registration.
  after(async () => {
    try {
      const base = defaultBaseUrl().replace(/\/$/, "");
      if (!base) return;
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.isActive || user.emailVerifiedAt) return;
      const raw = await createEmailVerificationToken(user.id);
      await sendVerificationEmail({
        to: user.email,
        name: user.name,
        verifyUrl: `${base}/verify-email?token=${raw}`,
      });
    } catch (e) {
      console.error("[resendVerificationAction] deferred work failed:", e);
    }
  });

  return { ok: true as const };
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run auth.verify-gate.test auth.rate-limit.test auth.challenge.test`
Expected: PASS. The two existing auth test files must still pass — if they broke, `authorize`'s extraction changed behavior it should not have.

- [ ] **Step 7: Commit**

```bash
git add src/auth.ts src/app/actions/auth.ts src/app/actions/auth.verify-gate.test.ts
git commit -m "feat(auth): refuse sign-in until the email address is confirmed"
```

---

## Task 6: `/register` and `/verify-email`

**Files:** Create `src/app/register/page.tsx`, `src/app/register/RegisterForm.tsx`, `src/app/verify-email/page.tsx`; modify `src/app/login/LoginForm.tsx`

- [ ] **Step 1: Build `/register`**

`page.tsx` is a Server Component mirroring `login/page.tsx` — same `export const dynamic = "force-dynamic"`, same `turnstileWidgetSiteKey()` resolution on the server, same card shell. `RegisterForm.tsx` is the client half, mirroring `LoginForm.tsx` **including the `useSyncExternalStore` hydration guard** — that pattern exists because a server-rendered `disabled` button leaves an inert form when the client bundle fails, and a sign-up form has exactly the same failure mode.

Fields: name (required), email (required, `type="email"`, `autoComplete="username"`), password (required, `autoComplete="new-password"`), rank, unit, contact number (all optional). Success replaces the form with: *"Check your email. We sent a confirmation link to {email}. You'll be able to sign in once you confirm."*

> `type="email"` IS correct here, unlike the item form's `currentUserEmail`. That field is a free-text holder name copied verbatim by the CSV importer; this one is a real credential validated by `emailField`.

- [ ] **Step 2: Build `/verify-email`**

A Server Component reading `?token=`, calling `verifyEmailWithToken`, and rendering one of two outcomes — never a raw error:

- **Success:** "Email confirmed. You can now sign in." + a link to `/login`.
- **Failure:** "This confirmation link is invalid or has expired." + the resend form.

- [ ] **Step 3: Add the "Create account" link to `/login`**

Below the sign-in button: `Don't have an account? <Link href="/register">Create one</Link>`.

- [ ] **Step 4: Verify in a real browser**

Neither `npm run build` nor jsdom has a layout engine — CLAUDE.md is explicit that neither is evidence for UI. Load `/register` and `/login` at 375px and confirm the forms are usable and the buttons meet the 44px tap floor.

- [ ] **Step 5: Commit**

```bash
git add src/app/register src/app/verify-email src/app/login/LoginForm.tsx
git commit -m "feat(auth): add the register and verify-email pages"
```

---

## Task 7: The scoped receipt list query

**Files:** Modify `src/modules/transfers/transfers.service.ts`; create `src/modules/transfers/transfers.list.test.ts`

**Interfaces:** Produces
`listReceipts({ viewerEmail, all, cursor, take }): Promise<{ rows: ReceiptRow[]; nextCursor: string | null }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ default: { transfer: { findMany: (a: unknown) => findMany(a) } } }));

import { listReceipts } from "./transfers.service";

beforeEach(() => { vi.clearAllMocks(); findMany.mockResolvedValue([]); });

it("filters to the viewer's own receipts when they cannot see all", async () => {
  await listReceipts({ viewerEmail: "jane@unit.mil", all: false });
  const where = findMany.mock.calls[0][0].where;
  expect(JSON.stringify(where)).toContain("jane@unit.mil");
  expect(where.OR).toEqual([
    { senderEmail: { equals: "jane@unit.mil", mode: "insensitive" } },
    { receiverEmail: { equals: "jane@unit.mil", mode: "insensitive" } },
  ]);
});

it("applies no party filter when the viewer holds VIEW_ALL_RECEIPTS", async () => {
  await listReceipts({ viewerEmail: "jane@unit.mil", all: true });
  expect(findMany.mock.calls[0][0].where?.OR).toBeUndefined();
});

// The whole point of the scoping: a null viewer email must return NOTHING, never
// everything. An unverified account has no verified address to match on, and
// "no filter" would silently hand it the entire property book.
it("returns nothing — never everything — when there is no viewer email", async () => {
  const res = await listReceipts({ viewerEmail: null, all: false });
  expect(res.rows).toEqual([]);
  expect(findMany).not.toHaveBeenCalled();
});

it("never selects signature blobs", async () => {
  await listReceipts({ viewerEmail: "j@x.mil", all: true });
  const select = findMany.mock.calls[0][0].select;
  expect(JSON.stringify(select)).not.toMatch(/signature/i);
});

it("is bounded and paginates by keyset", async () => {
  await listReceipts({ viewerEmail: "j@x.mil", all: true });
  const arg = findMany.mock.calls[0][0];
  expect(arg.take).toBeGreaterThan(0);
  expect(arg.orderBy).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transfers.list.test`
Expected: FAIL — `listReceipts is not a function`.

- [ ] **Step 3: Implement**

```ts
const RECEIPTS_PAGE_SIZE = 25;

/**
 * The hand-receipt list. Bounded and keyset-paginated — receipts grow with the
 * fleet, so this must never become an unbounded findMany.
 *
 * `all` comes from the VIEW_ALL_RECEIPTS capability, resolved by the caller.
 * Without it the list is filtered to receipts the viewer is a party to, matched
 * on their VERIFIED address — an unverified one proves nothing and is never
 * passed in.
 *
 * A null viewerEmail returns an EMPTY list, never an unfiltered one. Falling
 * through to "no filter" would hand the whole property book to precisely the
 * accounts this scoping exists to restrict.
 */
export async function listReceipts({
  viewerEmail,
  all,
  cursor,
  take = RECEIPTS_PAGE_SIZE,
}: {
  viewerEmail: string | null;
  all: boolean;
  cursor?: string;
  take?: number;
}) {
  if (!all && !viewerEmail) return { rows: [], nextCursor: null };

  const rows = await prisma.transfer.findMany({
    where: all
      ? {}
      : {
          OR: [
            { senderEmail: { equals: viewerEmail!, mode: "insensitive" } },
            { receiverEmail: { equals: viewerEmail!, mode: "insensitive" } },
          ],
        },
    // Only what the list renders. Never a signature blob.
    select: {
      id: true,
      receiptNumber: true,
      createdAt: true,
      status: true,
      senderName: true,
      receiverName: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  return {
    rows: hasMore ? rows.slice(0, take) : rows,
    nextCursor: hasMore ? rows[take - 1]!.id : null,
  };
}
```

> Check `Transfer.status`'s actual field name against `schema.prisma` before writing this select — if it differs, use the real one rather than adding a field that does not exist.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run transfers.list.test`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/transfers/transfers.service.ts src/modules/transfers/transfers.list.test.ts
git commit -m "feat(receipts): add the bounded, party-scoped receipt list query"
```

---

## Task 8: The `/receipts` page

**Files:** Create `src/app/receipts/page.tsx`; modify `src/components/nav.ts`, `src/components/AppHeader.tsx`, `src/components/nav.test.ts`

- [ ] **Step 1: Build the page**

```tsx
export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  let user;
  try {
    user = await requireCapability("VIEW_INVENTORY");
  } catch (e) {
    if (e instanceof AuthError) redirect("/login");
    throw e;
  }
  const all = user.capabilities.includes("VIEW_ALL_RECEIPTS");

  // The VERIFIED address only. An unverified one is an unproved claim about
  // somebody else's mailbox, and matching on it would show this account their
  // receipts.
  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true, emailVerifiedAt: true },
  });
  const viewerEmail = me?.emailVerifiedAt ? me.email : null;

  const { rows, nextCursor } = await listReceipts({
    viewerEmail,
    all,
    cursor: (await searchParams).cursor,
  });
  // …renders a `.table` of receipt number, date, parties, status, linking to
  // /receipts/<number>; a "Load more" link carrying ?cursor=; and an empty state.
}
```

The heading is **"All hand receipts"** with `all`, **"Your hand receipts"** without — and in the scoped case a subtitle saying *"Receipts where you are the issuing or receiving party."* so an empty list is never mistaken for "there are no receipts".

- [ ] **Step 2: Add the nav entry**

In `nav.ts`, for a logged-in user, add `{ label: "Receipts", href: "/receipts", icon: "receipts" }` after Items. Add `receipts` to the `NavIcon` union and map it in `AppHeader`'s `ICONS` (`FileText` from lucide-react).

> `nav.ts` documents five tabs as the practical ceiling at 375px. An admin now has Search, Items, Receipts, Queue, Users, Dashboard = **six**. Either drop Dashboard from the rail for admins or accept the truncation deliberately — check it in a real browser at 375px and decide there, then record the decision in the `navItemsFor` docstring.

- [ ] **Step 3: Update `nav.test.ts` and `AppHeader.test.tsx`**

Both pin the exact label lists per role and will fail. Update the expectations to include Receipts.

- [ ] **Step 4: Run the component tests**

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/receipts/page.tsx src/components/nav.ts src/components/nav.test.ts src/components/AppHeader.tsx src/components/AppHeader.test.tsx
git commit -m "feat(receipts): add the scoped hand-receipt list page"
```

---

## Task 9: Copy changes

**Files:** Modify `src/components/nav.ts`, `src/app/page.tsx`

- [ ] **Step 1: Rename the sign-in labels**

`nav.ts:26`: `"Staff sign in"` → `"Sign in"`. `src/app/page.tsx`: `"Staff log in"` → `"Log in"`, and add a `Create account` link beside it.

- [ ] **Step 2: Correct the home page's "Who it is for"**

It currently reads *"Technicians sign in with an account provisioned by an administrator"*, which this PR makes false. Replace with wording that says anyone can create an account, that a new account can read the property book, and that further permissions are requested from an administrator.

- [ ] **Step 3: Update `nav.test.ts`**

It pins `"Staff sign in"`. Change the expectation.

- [ ] **Step 4: Commit**

```bash
git add src/components/nav.ts src/components/nav.test.ts src/app/page.tsx
git commit -m "feat(auth): sign-in is no longer labelled staff-only, and offers account creation"
```

---

## Task 10: Documentation

- [ ] **Step 1: CLAUDE.md §1**

Replace the "There is NO public self-registration" bullet — it is now false. The replacement states: registration is public, creates `VIEWER` only, requires a verified email before sign-in, and that `createSelfRegisteredUser` is the ONLY path that mints an account without a session and cannot choose a role.

- [ ] **Step 2: `docs/SECURITY.md`**

New entries under Authentication (registration, email verification, resend) and under the public surface (what `/register` exposes). Bump *Last reviewed*. Add **two** entries to **Known gaps & accepted risks**:

1. A self-registered, email-verified account **bypasses the public PIN gate** — logged-in users are admitted by `src/proxy.ts` — so anyone with a working mailbox can reach the item and receipt surfaces without the PIN. Accepted: those surfaces are already PIN-readable and the PIN is shared.
2. The own-receipts scoping is a **list filter, not a confidentiality boundary**. `/receipts/<number>` still opens for any PIN holder. Narrowing that is a deliberate feature change, not a bug.

- [ ] **Step 3: CHANGELOG.md**

Under today's date, Added/Changed, describing sign-up, confirmation, the read-only tier and the receipts list for a reader. Under **Notes**: the migration name, the `emailVerifiedAt` backfill, and that `GMAIL_*` must be live in Vercel prod or verification mail silently logs instead of sending.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/SECURITY.md CHANGELOG.md
git commit -m "docs: public self-registration with email verification"
```

---

## Task 11: Verify and open the PR

- [ ] **Step 1:** `npm test` — alone. Expected: PASS.
- [ ] **Step 2:** `npm run lint && npm run build`. Expected: both PASS.
- [ ] **Step 3: Exercise the real flow.** Register a new address; confirm no account is usable before the link is clicked; click it; sign in; confirm `/receipts` shows only that account's receipts and `/items` is read-only; confirm `/admin/*` refuses. With `GMAIL_*` unset locally the mail is logged by `LogEmailSender` — take the link from the console.
- [ ] **Step 4: Confirm the anti-enumeration property by hand.** Register an address that already exists and confirm the response is byte-identical to a fresh one, and that no second account appears.
- [ ] **Step 5: Apply the migration to Supabase BEFORE merging** — DDL + backfill + a `_prisma_migrations` row carrying the checksum from the dev DB, as with `20260808120000_capability_foundation`.
- [ ] **Step 6:** Push, open the PR, wait for `Semgrep SAST` + `Build (next build)`, merge.

---

## Self-Review Notes

**Spec coverage.** §3 registration → Tasks 1–6. §4 own-receipt scoping → Tasks 7–8. §7 copy → Task 9. §11 docs → Task 10.

**The two places a mistake is silent rather than loud.** `listReceipts` falling through to an unfiltered query on a null viewer email (Task 7 pins it), and `authorize` checking verification before the password, which would turn the login form into an enumeration oracle (Task 5 pins it). Do not weaken either test.

**Deferred to PR 3.** The `/account` permissions card, the request form, the admin approval queue. `VIEWER` accounts created here have no way to ask for more until PR 3 ships — acceptable for a single release, and the home-page copy in Task 9 should not promise a request flow that does not exist yet.
