# Permission Requests Implementation Plan (PR 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user ask for capabilities with a justification, and let an administrator grant part of a request by unchecking what they are not giving.

**Architecture:** A `PermissionRequest` carries one justification and many `PermissionRequestItem` lines, each decided individually. The admin UI is a **pre-checked checklist**: submitting grants the checked lines and denies the unchecked ones, with one required reason covering everything withheld. Approval writes `UserCapability` rows inside the same transaction as the decisions. Outcomes render as green-check / red-X rows on `/account`, in the admin queue's decided list, and in the decision email.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Prisma 7 + PostgreSQL 16, Zod, Vitest, the existing Gmail OAuth sender.

## Global Constraints

- **Capabilities come from `capabilities.ts`** — `CAPABILITIES`, `CAPABILITY_LABELS`, `isElevated`, `isRequestable`. Never restate the list or the risk classification anywhere else.
- **`ADMINISTER` is requestable but elevated.** It renders in the danger treatment on both surfaces and **starts unchecked** in the approval list — granting full administrative control should take a deliberate tick, not a deliberate untick.
- **An admin may never decide their own request.** This is the self-grant hole on `ADMINISTER` and is the one guard whose absence is a privilege-escalation bug rather than a usability wart.
- **Deny requires a reason** — one per request, covering everything withheld, mirroring the single justification on the request side.
- **Approval is idempotent.** `UserCapability` is unique on `(userId, capability)`; deciding twice must not duplicate a grant or throw.
- **Decide inside one transaction.** Grant rows and item decisions commit together or not at all.
- **Every mutation is capability-gated**: requesting needs a session; deciding needs `ADMINISTER`.
- **`VIEW_INVENTORY` is not requestable** (`isRequestable` already says so) — everyone holds it.
- **Icons are never the only signal.** Each outcome row carries the word "Approved"/"Denied", the icon is `aria-hidden`, and colour is not load-bearing — red/green alone fails colour-blind users and screen readers.
- **This is the legacy `globals.css` world**, not the Tailwind zone. Neither `npm run build` nor jsdom is evidence for any of it — verify the red treatment and the checklist in a real browser.
- **Run `npm test` alone.** This worktree uses its own database (`handreceipt_test_caps`); keep it that way.
- **Docs ship in the same commit** (Task 8).

## Reference

Spec: `docs/superpowers/specs/2026-08-08-capability-permissions-and-self-registration-design.md` §5, §6, §7.
PR 1 (`adebad8`) provides the capability model; PR 2 (`9f57b24`) provides `VIEWER` accounts that need this.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` *(modify)* | `PermissionRequest`, `PermissionRequestItem`, `RequestStatus`, `Decision`. |
| `prisma/migrations/20260810120000_permission_requests/migration.sql` *(create)* | DDL. |
| `src/modules/users/permissions.schema.ts` *(create)* | Zod for the request and the decision. |
| `src/modules/users/permissions.service.ts` *(create)* | Create, list, decide. The only file here that reaches the DB. |
| `src/modules/users/permissions.service.test.ts` *(create)* | Guards: duplicate, self-decision, reason-required, idempotent grant, transactional. |
| `src/app/actions/permissions.ts` *(create)* | `requestPermissionsAction` (session), `decidePermissionRequestAction` (`ADMINISTER`). |
| `src/app/account/PermissionsCard.tsx` *(create)* | Current capabilities, pending, decided outcomes, request form. |
| `src/app/account/page.tsx` *(modify)* | Render it. |
| `src/app/admin/permissions/page.tsx` + `DecisionForm.tsx` *(create)* | The approval queue. |
| `src/app/admin/page.tsx` *(modify)* | Hub link with a pending count. |
| `src/modules/auth/send-decision-email.ts` *(create)* | The outcome email. |
| `CLAUDE.md`, `docs/SECURITY.md`, `CHANGELOG.md`, `.claude/rules/backend-constraints.md` *(modify)* | Docs. |

---

## Task 1: Schema and migration

- [ ] **Step 1: Add to `prisma/schema.prisma`**

```prisma
enum RequestStatus {
  OPEN
  CLOSED
}

enum Decision {
  PENDING
  APPROVED
  DENIED
}

// One ask, one justification, many capability lines decided individually.
//
// The denial reason lives on the REQUEST rather than the item: an admin denies
// by unchecking lines and gives one reason covering everything withheld, which
// mirrors the single justification on the request side. Denied items read it
// through their request.
model PermissionRequest {
  id            String                  @id @default(cuid())
  user          User                    @relation("PermissionRequests", fields: [userId], references: [id], onDelete: Cascade)
  userId        String
  justification String
  status        RequestStatus           @default(OPEN)
  denialReason  String?
  createdAt     DateTime                @default(now())
  decidedAt     DateTime?
  decidedBy     User?                   @relation("PermissionDecisions", fields: [decidedById], references: [id], onDelete: SetNull)
  decidedById   String?
  items         PermissionRequestItem[]

  @@index([status, createdAt])
  @@index([userId])
}

model PermissionRequestItem {
  id         String            @id @default(cuid())
  request    PermissionRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  requestId  String
  capability Capability
  decision   Decision          @default(PENDING)

  @@unique([requestId, capability])
  @@index([requestId])
}
```

Add to `User`'s relation block:

```prisma
  permissionRequests  PermissionRequest[] @relation("PermissionRequests")
  permissionDecisions PermissionRequest[] @relation("PermissionDecisions")
```

- [ ] **Step 2: Write `prisma/migrations/20260810120000_permission_requests/migration.sql`**

```sql
-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "PermissionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
    "denialReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "PermissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionRequestItem" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "capability" "Capability" NOT NULL,
    "decision" "Decision" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "PermissionRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PermissionRequest_status_createdAt_idx" ON "PermissionRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PermissionRequest_userId_idx" ON "PermissionRequest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionRequestItem_requestId_capability_key" ON "PermissionRequestItem"("requestId", "capability");

-- CreateIndex
CREATE INDEX "PermissionRequestItem_requestId_idx" ON "PermissionRequestItem"("requestId");

-- AddForeignKey
ALTER TABLE "PermissionRequest" ADD CONSTRAINT "PermissionRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRequest" ADD CONSTRAINT "PermissionRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRequestItem" ADD CONSTRAINT "PermissionRequestItem_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "PermissionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Normalize line endings, apply, generate**

```bash
git add prisma/migrations/20260810120000_permission_requests/migration.sql
rm prisma/migrations/20260810120000_permission_requests/migration.sql
git checkout -- prisma/migrations/20260810120000_permission_requests/migration.sql
npx prisma migrate deploy && npx prisma generate
```

- [ ] **Step 4: Verify an empty diff**

`npx prisma migrate diff --from-config-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script` → `-- This is an empty migration.`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260810120000_permission_requests
git commit -m "feat(permissions): add the permission request schema"
```

---

## Task 2: Schemas

**Files:** Create `src/modules/users/permissions.schema.ts`

```ts
import { z } from "zod";
import { CAPABILITIES, isRequestable } from "./capabilities";

// Long enough to be a reason rather than a shrug. An admin deciding a request
// has only this text to go on, so "pls" must not be submittable.
export const MIN_JUSTIFICATION = 20;

const requestableCapability = z
  .enum(CAPABILITIES)
  .refine(isRequestable, "That permission cannot be requested.");

export const permissionRequestSchema = z.object({
  justification: z
    .string()
    .trim()
    .min(MIN_JUSTIFICATION, `Please explain what you need this for (at least ${MIN_JUSTIFICATION} characters).`)
    .max(2000),
  capabilities: z
    .array(requestableCapability)
    .min(1, "Choose at least one permission to request.")
    .max(CAPABILITIES.length),
});

export const permissionDecisionSchema = z
  .object({
    requestId: z.string().min(1),
    // The CHECKED lines. Everything else on the request is denied — the admin
    // decides by unchecking, so absence is a decision, not an omission.
    approve: z.array(z.enum(CAPABILITIES)).default([]),
    denialReason: z.string().trim().max(2000).optional(),
  });
```

- [ ] Write `permissions.schema.test.ts` covering: a short justification is rejected; `VIEW_INVENTORY` is rejected as unrequestable; an empty capability list is rejected; duplicates are tolerated; `ADMINISTER` is accepted.
- [ ] Commit.

---

## Task 3: The service

**Files:** Create `src/modules/users/permissions.service.ts` and its test.

**Produces:**
- `createPermissionRequest(userId, input)` — throws `PermissionRequestError("ALREADY_HELD" | "ALREADY_PENDING")`
- `listOpenRequests()` / `listRequestsForUser(userId)`
- `decidePermissionRequest({ requestId, deciderId, approve, denialReason })` — throws `PermissionRequestError("SELF_DECISION" | "REASON_REQUIRED" | "NOT_FOUND" | "ALREADY_DECIDED")`

- [ ] **Step 1: Write the failing tests** covering, at minimum:

```
- refuses a capability the user already holds (baseline OR grant)
- refuses a capability already pending for that user
- allows re-requesting a capability that was DENIED
- refuses a decision by the requester themselves          <- the privilege guard
- refuses a denial with no reason
- allows an approve-everything decision with no reason
- writes UserCapability rows ONLY for approved lines
- marks unchecked lines DENIED and stores the reason on the request
- is idempotent: deciding a request whose grant already exists does not throw
- closes the request when no PENDING items remain
- refuses to decide an already-CLOSED request
- grants and decisions commit in ONE transaction
```

- [ ] **Step 2–4:** run (fail), implement, run (pass).

Implementation notes that matter:

```ts
// Effective set from the SAME pure function everything else uses, so "already
// held" cannot drift from what requireCapability actually admits.
const held = effectiveCapabilities(user.role, user.capabilities.map((c) => c.capability));

// The self-decision guard. An admin approving their own ADMINISTER request is
// a privilege escalation with a paper trail that looks legitimate.
if (request.userId === deciderId) throw new PermissionRequestError("SELF_DECISION");

// Idempotent by the unique constraint: skipDuplicates rather than a
// read-then-write, which would race two admins deciding at once.
await tx.userCapability.createMany({ data: rows, skipDuplicates: true });
```

- [ ] **Step 5:** Commit.

---

## Task 4: Server actions

**Files:** Create `src/app/actions/permissions.ts`

```ts
"use server";
// Requesting needs only a session — a VIEWER asking for more is the whole
// point. Deciding needs ADMINISTER.
export async function requestPermissionsAction(_prev, formData) {
  const user = await requireCapability("VIEW_INVENTORY");
  // …parse, call the service, map PermissionRequestError to a message,
  // revalidatePath("/account") and revalidatePath("/admin/permissions")
}

export async function decidePermissionRequestAction(_prev, formData) {
  const admin = await requireAdmin();
  // …parse; `approve` is formData.getAll("approve"); call the service with
  // deciderId: admin.id; send the decision email through after().
}
```

Both return `{ ok: true } | { error: string }`; never leak a raw error (CLAUDE.md §5).

- [ ] Write action tests: the requester cannot forge `userId` (it comes from the session); a non-admin cannot decide; the self-decision refusal surfaces as a message.
- [ ] Commit.

---

## Task 5: The decision email

**Files:** Create `src/modules/auth/send-decision-email.ts` + test.

Per-capability breakdown, approved lines then denied, reason once at the end. Uses `✓` / `✗` **text characters**, not icons or background colours — mail clients strip CSS and block images, and the words "Approved"/"Denied" carry the meaning regardless. Link built from `defaultBaseUrl()`.

- [ ] Test: both lists render; the reason appears once; the recipient name is escaped in the HTML part; a send failure propagates.
- [ ] Commit.

---

## Task 6: `/account` — Your permissions

**Files:** Create `src/app/account/PermissionsCard.tsx`; modify `src/app/account/page.tsx`.

Renders:
1. **Current permissions** — `effectiveCapabilities` via `CAPABILITY_LABELS`.
2. **Pending requests** — submitted date, justification, the capabilities asked for.
3. **Recent decisions** — the outcome rows:

```
Requested 6 Aug — decided 8 Aug by SSG Alvarez
  ✓  Create hand receipts        Approved
  ✗  Administer                  Denied
  Reason given: …
```

Green `Check` / red `X` from `lucide-react`, `aria-hidden`, always beside the word. The reason renders **once** under the group.

4. **Request form** — checkbox list of everything not already held, plus one justification textarea. `ADMINISTER` in the danger treatment with a line explaining it grants full administrative control.

- [ ] Write a jsdom `PermissionsCard.test.tsx` (`// @vitest-environment jsdom` on line 1): already-held capabilities are absent from the form; `ADMINISTER` carries its warning; a decided request shows both outcome words.
- [ ] Commit.

---

## Task 7: `/admin/permissions` — the approval queue

**Files:** Create `src/app/admin/permissions/page.tsx` and `DecisionForm.tsx`; modify `src/app/admin/page.tsx`.

Open requests newest first: requester, date, justification, and the requested capabilities as a **pre-checked checklist**.

- `ADMINISTER` renders red **and starts unchecked**.
- A required reason field appears as soon as any box is unchecked.
- The submit button tracks state: `Approve 3 of 3` / `Approve 2 of 3` / `Deny all`.
- Below, a "Recently decided" list showing the same check/X rows the requester sees.
- Hub link on `/admin` with a pending count. **Not a nav-rail tab** — admins are already at the five-tab budget (see `navItemsFor`).

- [ ] jsdom test: `ADMINISTER` unchecked by default; unchecking reveals the reason field; the button label tracks the count; a request by the signed-in admin renders its controls disabled with an explanation.
- [ ] **Verify in a real browser** — the red treatment and the checklist at 375px. Build and jsdom are not evidence.
- [ ] Commit.

---

## Task 8: Documentation

- [ ] **CLAUDE.md §1** — add the request workflow: requesting needs only a session, deciding needs `ADMINISTER`, an admin can never decide their own request, denial requires a reason, re-requesting after denial is allowed.
- [ ] **`docs/SECURITY.md`** — a new subsection under Authorization: the request/decision model, the self-decision guard (named as the privilege-escalation guard it is), idempotent grants, and the transactional decide. Bump *Last reviewed*.
- [ ] **`.claude/rules/backend-constraints.md`** — the same, in the capability section added by PR 1.
- [ ] **`CHANGELOG.md`** — written for a reader: you can ask for permissions with a reason; an administrator can grant part of what you asked for; you can see what was approved and what was not, and why.
- [ ] Commit.

---

## Task 9: Verify and open the PR

- [ ] `npm test` alone → PASS. `npm run lint && npm run build` → PASS.
- [ ] End-to-end against the dev database: a `VIEWER` requests three capabilities; an admin approves two and denies one with a reason; confirm the two grants exist, the third does not, the request is `CLOSED`, and `effectiveCapabilities` now admits the granted ones.
- [ ] Confirm the self-decision guard by attempting it directly in the service.
- [ ] Apply the migration to Supabase **before** merging (DDL + `_prisma_migrations` row with the dev checksum).
- [ ] Push, PR, wait for `Semgrep SAST` + `Build (next build)`, merge.

---

## Self-Review Notes

**Spec coverage.** §5 model and rules → Tasks 1–4. §6 both UIs and the check/X outcomes → Tasks 6–7. §7 email → Task 5. §11 docs → Task 8.

**The one place a mistake is a security bug rather than a bug.** The self-decision guard in Task 3. Everything else here is a usability failure at worst; that one is privilege escalation with an audit trail that looks legitimate. Its test must not be weakened.

**Deliberately not built.** Capability expiry, bulk decisions across requests, and admin-initiated grants outside the request flow (an admin still changes a role directly for that). None is needed to close the loop this PR exists to close.
