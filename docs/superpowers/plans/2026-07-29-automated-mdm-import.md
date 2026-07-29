# Automated MDM CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a technician's nightly Intune export POST a CSV to the app and import itself, with no human in the loop.

**Architecture:** A new `POST /api/items/import` route authenticated by a shared secret in an env var (constant-time compare, the same shape `/api/cron/purge` already uses), which feeds the existing `parseItemsCsv` → `commitImport` pipeline with an empty `resolutions` array. Import *logic* does not change; this is a second front door onto it. A seeded non-loginable service account supplies the `editor` identity that `ImportBatch.createdById` requires.

**Tech Stack:** Next.js 16 route handlers, Prisma 7, Vitest, `node:crypto`.

Spec: `docs/superpowers/specs/2026-07-29-automated-mdm-import-design.md`

## Global Constraints

- Every Server Action and Route Handler starts with `requireUser()`/`requireAdmin()` from `@/lib/authz` — **except** cron-style routes with no session, which authenticate via a constant-time secret compare and fail closed. This route is the latter.
- Never use string concatenation or template interpolation inside raw queries. Values are bound.
- Catch exceptions in handlers; return generic messages to the client, log detail server-side.
- Never query inside a loop. Batch with `findMany`/`createMany`/`updateMany`.
- Docs are part of the change, not a follow-up: `CHANGELOG.md`, `docs/SECURITY.md` and `CLAUDE.md` update **in the same commit** as the code that makes them stale.
- `docs/SECURITY.md` is CI-enforced by `scripts/check-security-docs.mjs`. A watched file changing without `docs/SECURITY.md` changing fails the PR. **New security-relevant files must be added to that script's `WATCHED` list** or they escape the guardrail.
- `prisma migrate dev` cannot run non-interactively in this shell. Author migrations with `npx prisma migrate diff --from-config-datasource --to-schema` and apply with `npx prisma migrate deploy`.
- Do not run the test suite concurrently with another agent — integration tests truncate a shared test database.
- `MAX_IMPORT_ROWS` is 2000 and stays 2000.

---

### Task 1: Extract the shared bearer-secret check

Today the constant-time check lives inline in the purge route. A second route needs it, and two copies of an auth check drift.

**Files:**
- Create: `src/lib/cron-auth.ts`
- Create: `src/lib/cron-auth.test.ts`
- Modify: `src/app/api/cron/purge/route.ts:1-25` (replace the local `isAuthorized`)
- Modify: `scripts/check-security-docs.mjs` (add the new file to `WATCHED`)
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `hasValidBearerSecret(req: Request, secret: string | undefined): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/cron-auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hasValidBearerSecret } from "./cron-auth";

const reqWith = (auth?: string) =>
  new Request("https://example.test/api/x", auth ? { headers: { authorization: auth } } : undefined);

describe("hasValidBearerSecret", () => {
  it("accepts an exact Bearer match", () => {
    expect(hasValidBearerSecret(reqWith("Bearer s3cret"), "s3cret")).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(hasValidBearerSecret(reqWith("Bearer s3cres"), "s3cret")).toBe(false);
  });

  it("rejects a wrong secret of a different length", () => {
    expect(hasValidBearerSecret(reqWith("Bearer nope"), "s3cret")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(hasValidBearerSecret(reqWith(), "s3cret")).toBe(false);
  });

  it("rejects the bare secret without the Bearer prefix", () => {
    expect(hasValidBearerSecret(reqWith("s3cret"), "s3cret")).toBe(false);
  });

  it("FAILS CLOSED when the secret is not configured", () => {
    // The whole point: an unset env var must never mean "let everyone in".
    expect(hasValidBearerSecret(reqWith("Bearer anything"), undefined)).toBe(false);
    expect(hasValidBearerSecret(reqWith("Bearer "), "")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/cron-auth.test.ts`
Expected: FAIL — cannot resolve `./cron-auth`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/cron-auth.ts`:

```ts
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time `Authorization: Bearer <secret>` check for routes that have no
 * user session — cron sweeps and machine-driven imports.
 *
 * FAILS CLOSED when the expected secret is unset or blank: a missing env var is
 * a misconfiguration, and treating it as "no auth required" would silently open
 * the endpoint on any environment that forgot to set it.
 *
 * Compares the WHOLE header (including the `Bearer ` prefix) so a caller cannot
 * pass the bare secret, and length-checks first because timingSafeEqual throws
 * on differing lengths. The length of a rejected guess leaks, which is not a
 * useful oracle against a random secret.
 *
 * No `server-only`, no Prisma: this must stay importable from anywhere.
 */
export function hasValidBearerSecret(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/cron-auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Refactor the purge route onto it**

In `src/app/api/cron/purge/route.ts`, delete the local `isAuthorized` function and the `timingSafeEqual` import, add `import { hasValidBearerSecret } from "@/lib/cron-auth";`, and change the guard in `handle`:

```ts
if (!hasValidBearerSecret(req, process.env.CRON_SECRET)) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

Behaviour is identical — same comparison, same fail-closed rule.

- [ ] **Step 6: Add the new file to the security-docs watch list**

In `scripts/check-security-docs.mjs`, add to the `WATCHED` array:

```js
[/^src\/lib\/cron-auth\.ts$/, "the shared secret check for session-less routes (§1)"],
```

- [ ] **Step 7: Update `docs/SECURITY.md`**

Find the existing entry describing the cron endpoint's `CRON_SECRET` authentication. Note that the check now lives in `src/lib/cron-auth.ts` and is shared, and bump the *Last reviewed* date at the top of the file.

- [ ] **Step 8: Verify the guardrail and the purge route still work**

Run: `npm run check:security-docs`
Expected: passes (a watched file changed AND `docs/SECURITY.md` changed).

Run: `npx vitest run src/app/api src/lib`
Expected: PASS, including any existing purge-route tests.

- [ ] **Step 9: Commit**

```bash
git add src/lib/cron-auth.ts src/lib/cron-auth.test.ts src/app/api/cron/purge/route.ts scripts/check-security-docs.mjs docs/SECURITY.md
git commit -m "refactor(auth): share the constant-time bearer-secret check between session-less routes"
```

---

### Task 2: `commitImport` reports unresolved rows

The route needs to tell the caller which rows could not have a home unit derived. `plan.unresolved` is already computed; it just isn't returned.

**Files:**
- Modify: `src/modules/items/items.service.ts` (the `commitImport` signature and its `return`)
- Test: `src/modules/items/items.service.import.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `commitImport(...)` return type gains `unresolved: UnresolvedRow[]`. `UnresolvedRow` is `{ row: number; deviceName: string; segments: string[] }`, exported from `src/modules/items/import.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/items/items.service.import.test.ts`. Match the file's existing setup helpers rather than inventing new ones — read the top of the file first and reuse how it seeds an editor and builds CSV text.

```ts
it("reports rows whose home unit could not be derived", async () => {
  // A device name with no segment matching any known unit abbreviation, and no
  // homeUnit column -> unresolved, but the row still imports.
  const csv = [
    "serialNumber,make,model,deviceName",
    "UNRESOLVED-1,Dell,7440,ZZTOP99-LT-001",
  ].join("\n");

  const res = await commitImport(csv, "fleet.csv", [], editor);

  expect(res.added).toBe(1);
  expect(res.unresolved).toHaveLength(1);
  expect(res.unresolved[0].deviceName).toBe("ZZTOP99-LT-001");

  const item = await prisma.item.findFirst({ where: { serialNumber: "UNRESOLVED-1" } });
  expect(item).not.toBeNull();
  expect(item?.homeUnit).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/items/items.service.import.test.ts`
Expected: FAIL — `res.unresolved` is undefined.

- [ ] **Step 3: Implement**

In `src/modules/items/items.service.ts`, in `commitImport`:

Add `unresolved: UnresolvedRow[]` to the declared return type (alongside `mismatches`). Import the type if it isn't already imported from `./import`.

The early-return for a parse error must include it:

```ts
if (error) return { added: 0, updated: 0, skipped: [], unchanged: 0, detected: 0, mismatches: [], unresolved: [], error };
```

`plan.unresolved` is already destructured or reachable as `plan.unresolved` after `const plan = planImport(rows, existing, units);`. Add it to the final return alongside the existing fields.

Add a comment at the return explaining why it is there:

```ts
// `unresolved` is surfaced (not just counted) because the automated import has
// no human at the resolution step — the caller reports it so an admin can teach
// the abbreviation later. The browser flow ignores this field; it gets the same
// list from analyzeImport before committing.
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/modules/items/items.service.import.test.ts`
Expected: PASS.

- [ ] **Step 5: Check nothing else broke**

Run: `npx vitest run src/modules/items src/app/admin`
Expected: PASS. The browser import action ignores the added field, so `analyzeImportAction`/`commitImportAction` need no change.

- [ ] **Step 6: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.import.test.ts
git commit -m "feat(import): commitImport reports rows whose home unit could not be derived"
```

---

### Task 3: The import service account

`commitImport` needs `editor: { id, name }` and writes `ImportBatch.createdById`, a required FK to `User`. A machine-driven import has no session.

**Files:**
- Create: `prisma/migrations/<timestamp>_import_service_account/migration.sql`
- Create: `src/modules/items/import-actor.ts`
- Create: `src/modules/items/import-actor.test.ts`
- Modify: `docs/SECURITY.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `IMPORT_SERVICE_ACCOUNT_EMAIL: string` — the constant `"mdm-import@service.invalid"`
  - `getImportActor(): Promise<{ id: string; name: string }>` — throws `Error` if the row is missing.

**Design note for the implementer:** the account is `isActive: false`. That is what makes it non-loginable, and it is deliberate, not an oversight — `defaultGetSession` in `src/lib/authz.ts` returns `null` for an inactive user, so no session can ever resolve to this account even if someone guessed a password. It is NOT at risk from the account purge worker: `purgeDeactivatedUsers` only considers rows with a non-null `deactivatedAt` (left null here), and `hasBlockingReferences` refuses to delete any user who created import batches. The `.invalid` TLD is reserved by RFC 2606 and can never be a real address.

- [ ] **Step 1: Write the failing test**

Create `src/modules/items/import-actor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import prisma from "@/lib/prisma";
import { getImportActor, IMPORT_SERVICE_ACCOUNT_EMAIL } from "./import-actor";

describe("getImportActor", () => {
  it("resolves the seeded service account", async () => {
    const actor = await getImportActor();
    expect(actor.id).toBeTruthy();
    expect(actor.name).toBe("MDM Import (automated)");
  });

  it("the service account cannot be signed in as", async () => {
    const user = await prisma.user.findUnique({
      where: { email: IMPORT_SERVICE_ACCOUNT_EMAIL },
      select: { isActive: true, deactivatedAt: true, role: true },
    });
    // isActive:false is what blocks authentication (see defaultGetSession).
    expect(user?.isActive).toBe(false);
    // deactivatedAt stays null so the account-purge worker never considers it.
    expect(user?.deactivatedAt).toBeNull();
    expect(user?.role).toBe("USER");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/items/import-actor.test.ts`
Expected: FAIL — cannot resolve `./import-actor`.

- [ ] **Step 3: Write the migration**

Create the migration directory with a timestamp newer than the latest existing one in `prisma/migrations/`, e.g. `20260729120000_import_service_account/migration.sql`:

```sql
-- The identity automated imports are attributed to.
--
-- ImportBatch.createdById is a required FK to "User", so a machine-driven
-- import still needs a row to point at. This account exists ONLY as that
-- attribution anchor.
--
-- isActive = false is what makes it non-loginable: defaultGetSession in
-- src/lib/authz.ts returns null for an inactive user, so no session can resolve
-- to it regardless of the password hash.
--
-- deactivatedAt is deliberately NULL: purgeDeactivatedUsers only hard-deletes
-- accounts with a non-null deactivatedAt, so leaving it null keeps this row
-- permanently out of scope for the purge worker.
--
-- The .invalid TLD is reserved by RFC 2606 and can never be a real address.
INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "isActive", "createdAt", "updatedAt")
VALUES (
  'svcmdmimport000000000000',
  'MDM Import (automated)',
  'mdm-import@service.invalid',
  '!no-login-service-account',
  'USER',
  false,
  NOW(),
  NOW()
)
ON CONFLICT ("email") DO NOTHING;
```

- [ ] **Step 4: Apply the migration**

Run: `npx prisma migrate deploy`
Expected: the new migration applies. Then confirm the row exists:

Run: `npx prisma db execute --stdin <<< 'SELECT "name","isActive" FROM "User" WHERE email = '"'"'mdm-import@service.invalid'"'"';'`

- [ ] **Step 5: Write the implementation**

Create `src/modules/items/import-actor.ts`:

```ts
import "server-only";
import prisma from "@/lib/prisma";

/** The address of the seeded, non-loginable account automated imports are
 *  attributed to. `.invalid` is reserved by RFC 2606, so this can never
 *  collide with a real person's address. */
export const IMPORT_SERVICE_ACCOUNT_EMAIL = "mdm-import@service.invalid";

/**
 * The `editor` identity an automated import writes its history under.
 *
 * THROWS rather than falling back to any other account. Silently importing as
 * "whoever we found" would attribute a machine's mass edit to a real person, so
 * a missing service account must be a loud failure that returns a 500 and gets
 * fixed, not a quiet substitution.
 */
export async function getImportActor(): Promise<{ id: string; name: string }> {
  const user = await prisma.user.findUnique({
    where: { email: IMPORT_SERVICE_ACCOUNT_EMAIL },
    select: { id: true, name: true },
  });
  if (!user) {
    throw new Error(
      `Import service account (${IMPORT_SERVICE_ACCOUNT_EMAIL}) is missing. ` +
        "Apply the import_service_account migration.",
    );
  }
  return user;
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run src/modules/items/import-actor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Document it**

In `docs/SECURITY.md`, add an entry: a non-loginable service account exists for automated import attribution, why `isActive: false` is the mechanism, and that it is out of scope for the account purge. Bump *Last reviewed*.

In `CLAUDE.md`, under the authorization section near the "Provision an individual admin account per technician — do NOT share one login" bullet, add:

```markdown
  * **One exception, and only one: the import service account.** `mdm-import@service.invalid` ("MDM Import (automated)") exists solely because `ImportBatch.createdById` is a required FK and a machine-driven import has no session. It is `isActive: false`, which is what makes it non-loginable (`defaultGetSession` returns null for an inactive user), and its `deactivatedAt` stays NULL so the purge worker never considers it. It is NOT a shared login — nobody can sign in as it. Do not add more service accounts without the same reasoning written down.
```

- [ ] **Step 8: Commit**

```bash
git add prisma/migrations src/modules/items/import-actor.ts src/modules/items/import-actor.test.ts docs/SECURITY.md CLAUDE.md
git commit -m "feat(import): seed a non-loginable service account for automated import attribution"
```

---

### Task 4: The import route

**Files:**
- Create: `src/app/api/items/import/route.ts`
- Create: `src/app/api/items/import/route.test.ts`
- Modify: `src/proxy.ts` — only if the verification in Step 1 shows the route is gated
- Modify: `scripts/check-security-docs.mjs`
- Modify: `docs/SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `hasValidBearerSecret` (Task 1), `commitImport` with `unresolved` (Task 2), `getImportActor` (Task 3).
- Produces: `POST /api/items/import`.

- [ ] **Step 1: Verify the proxy does not gate the new path**

`src/proxy.ts` coarse-login-gates `/items`, `/admin/*` and others, and PIN-gates the public surface. A machine POST carries no session cookie, so if `/api/items/import` falls inside a gated matcher it will be redirected to `/login` and never reach the handler — the failure looks like a broken secret.

Read `src/proxy.ts` and find the matcher/prefix list. Confirm whether `/api/items/import` is matched. If it is, add an explicit allowance for it **before** the login gate, with a comment saying the route authenticates by secret in the handler.

Record the finding in the commit message either way.

- [ ] **Step 2: Write the failing test**

Create `src/app/api/items/import/route.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import prisma from "@/lib/prisma";
import { POST } from "./route";

const SECRET = "test-import-secret";

const post = (body: FormData | null, auth?: string) =>
  POST(
    new Request("https://example.test/api/items/import", {
      method: "POST",
      headers: auth ? { authorization: auth } : undefined,
      body: body ?? undefined,
    }) as never,
  );

const csvForm = (csv: string, filename = "fleet.csv") => {
  const fd = new FormData();
  fd.set("file", new File([csv], filename, { type: "text/csv" }));
  return fd;
};

beforeAll(() => {
  process.env.MDM_IMPORT_SECRET = SECRET;
});

describe("POST /api/items/import", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await post(csvForm("serialNumber\nX1"));
    expect(res.status).toBe(401);
    expect(await prisma.item.count({ where: { serialNumber: "X1" } })).toBe(0);
  });

  it("rejects a wrong secret and imports nothing", async () => {
    const res = await post(csvForm("serialNumber,make,model\nX2,Dell,7440"), "Bearer wrong");
    expect(res.status).toBe(401);
    expect(await prisma.item.count({ where: { serialNumber: "X2" } })).toBe(0);
  });

  it("rejects a non-csv filename", async () => {
    const res = await post(csvForm("serialNumber\nX3", "fleet.txt"), `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
  });

  it("imports a valid CSV and attributes it to the service account", async () => {
    const res = await post(
      csvForm("serialNumber,make,model\nROUTE-1,Dell,7440"),
      `Bearer ${SECRET}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);

    const item = await prisma.item.findFirst({ where: { serialNumber: "ROUTE-1" } });
    expect(item).not.toBeNull();

    const batch = await prisma.importBatch.findFirst({
      where: { filename: "fleet.csv" },
      orderBy: { createdAt: "desc" },
      include: { createdBy: { select: { email: true } } },
    });
    expect(batch?.createdBy.email).toBe("mdm-import@service.invalid");
  });

  it("returns 400 with a message on an unparseable CSV rather than throwing", async () => {
    const res = await post(csvForm("not,a,fleet,export\n1,2,3,4"), `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/app/api/items/import/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 4: Write the route**

Create `src/app/api/items/import/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { hasValidBearerSecret } from "@/lib/cron-auth";
import { commitImport } from "@/modules/items/items.service";
import { getImportActor } from "@/modules/items/import-actor";

// Prisma and node crypto require the Node runtime. Never cached: this mutates
// the database on every call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MUST be declared, and MUST exceed commitImport's transaction budget.
//
// commitImport runs an interactive transaction configured with
// `timeout: 50_000, maxWait: 5_000` (items.service.ts). Those are consumed
// SEQUENTIALLY, so the function must be allowed to live longer than their sum
// (55s) or the platform kills it mid-transaction instead of letting it abort
// cleanly into the catch below — which is exactly the confusing generic failure
// the batching work went in to remove. The interactive import page sets 60;
// this one is a nightly job with nobody waiting, so it takes the Hobby ceiling.
export const maxDuration = 300;

/** Generous ceiling on the uploaded body. MAX_IMPORT_ROWS (2000) of this CSV's
 *  shape is ~500KB; anything near this is a mistake, and rejecting it here
 *  avoids reading a large body into memory before the row cap can apply. */
const MAX_CSV_BYTES = 5_000_000;

export async function POST(req: NextRequest) {
  // Checked BEFORE the body is read, so an unauthenticated flood costs one
  // constant-time compare rather than a multi-megabyte read.
  if (!hasValidBearerSecret(req, process.env.MDM_IMPORT_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let file: File;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (!(candidate instanceof File) || candidate.size === 0) {
      return NextResponse.json({ error: "Attach the CSV as the `file` field." }, { status: 400 });
    }
    if (!candidate.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: "The file must be a .csv file." }, { status: 400 });
    }
    if (candidate.size > MAX_CSV_BYTES) {
      return NextResponse.json({ error: "That file is too large to import." }, { status: 413 });
    }
    file = candidate;
  } catch {
    return NextResponse.json({ error: "Expected a multipart/form-data body." }, { status: 400 });
  }

  try {
    const actor = await getImportActor();
    const text = await file.text();

    // Empty resolutions is CORRECT, not a shortcut. An unrecognised unit
    // abbreviation does not block a row: the item imports with a blank
    // homeUnit and comes back in `unresolved` for an admin to teach later at
    // /admin/units. See readinessState / planImport for why this is safe.
    const res = await commitImport(text, file.name, [], actor);
    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });

    revalidatePath("/items");
    revalidatePath("/admin/audit");

    return NextResponse.json({
      ok: true,
      added: res.added,
      updated: res.updated,
      unchanged: res.unchanged,
      detected: res.detected,
      skipped: res.skipped,
      unresolved: res.unresolved,
      mismatches: res.mismatches,
    });
  } catch (e) {
    console.error("[api/items/import] import failed:", e);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/app/api/items/import/route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Measure a full-size import and record the number**

The spec requires this rather than reasoning about it. Write a throwaway script or a temporary test that builds a 2000-row CSV of the widest realistic shape (every importable column populated, all rows matching existing serials so they take the UPDATE path) and times one `commitImport`.

Run it against the local test database, note the elapsed seconds, then **delete the throwaway** and put the number in the commit message and in the `CHANGELOG.md` Notes.

If it exceeds ~40s locally, stop and raise it — the transaction budget and `maxDuration` need revisiting together, and chunking `commitImport` across transactions (the deferred follow-up noted at `items.service.ts:862`) becomes real work rather than a nicety.

- [ ] **Step 7: Add the route to the security-docs watch list**

In `scripts/check-security-docs.mjs`, add:

```js
[/^src\/app\/api\/items\/import\/route\.ts$/, "the secret-authenticated machine import endpoint (§1)"],
```

- [ ] **Step 8: Document**

`docs/SECURITY.md` — new entry: the endpoint, that it authenticates by `MDM_IMPORT_SECRET` with a constant-time compare checked before the body is read, that it fails closed when unset, that it writes as the service account, and the accepted tradeoff that rotating the secret requires a redeploy. Add to **Known gaps & accepted risks**: anyone holding the secret can create and update inventory rows, bounded by `MAX_IMPORT_ROWS`, with every change attributed in `ItemEdit`. Bump *Last reviewed*.

`CHANGELOG.md` — a `## 2026-07-29` section (newest at top; merge with an existing one for the same date rather than adding a second):

```markdown
### Added
- **The nightly Intune export can now import itself.** A scheduled job can POST the CSV straight to the app instead of somebody opening the import page and doing it by hand. Rows whose unit abbreviation the app does not recognise still import — they come back listed in the response so an admin can teach the abbreviation afterwards.

### Notes
- New environment variable **`MDM_IMPORT_SECRET`** must be set in Vercel and in the scheduled job. Unset, the endpoint refuses everything.
- A new migration seeds an **`MDM Import (automated)`** account that automated imports are recorded under. It cannot be signed in to.
- Measured: a full 2000-row all-update import takes ~<N>s locally.
```

`CLAUDE.md` — under the import/data-fetching rules add:

```markdown
* **There are TWO import front doors and ONE import implementation.** `/admin/items/import` (interactive, two-step, resolves units by hand) and `POST /api/items/import` (machine-driven, secret-authenticated, `resolutions: []`) both call `commitImport`. Do not fork the logic. **An empty `resolutions` array is valid** — an unrecognised unit leaves `homeUnit` blank and is reported in `unresolved`; it never blocks a row. The route MUST declare `maxDuration` greater than `commitImport`'s `maxWait + timeout` (currently 5s + 50s), or the platform kills the function mid-transaction instead of letting it abort into a caught error.
```

- [ ] **Step 9: Full verification**

```bash
npm run check:security-docs
npm run lint
npx vitest run src/modules/items src/app/api src/lib
npm run build
```

Expected: all pass. `npm run build` is what catches a route-handler signature Next rejects.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/items/import scripts/check-security-docs.mjs docs/SECURITY.md CHANGELOG.md CLAUDE.md src/proxy.ts
git commit -m "feat(import): secret-authenticated endpoint so the nightly MDM export can import itself"
```

---

### Task 5: Hand-off notes for the technician

**Files:**
- Modify: `DEPLOY.md`

- [ ] **Step 1: Document the client side**

Add a section to `DEPLOY.md` covering what the person automating the export needs:

````markdown
## Automated MDM import

Set `MDM_IMPORT_SECRET` in Vercel (Production + Preview) and give the same value
to the scheduled export job. Rotating it requires a redeploy.

The job posts the CSV as multipart form data:

```powershell
$headers = @{ Authorization = "Bearer $env:MDM_IMPORT_SECRET" }
$form = @{ file = Get-Item .\fleet.csv }
Invoke-RestMethod -Uri "https://<host>/api/items/import" -Method Post -Headers $headers -Form $form
```

Limits and behaviour:
- Maximum **2000 rows** per import. Split larger exports.
- `serialNumber` is the required column; a serial that already exists is updated
  in place, a new one is created, and **nothing is ever deleted** — devices
  missing from the export are left untouched.
- Rows whose unit abbreviation is unrecognised still import, with a blank home
  unit, and are listed in the response under `unresolved`.
- A non-200 response means nothing was written. Log the body.
````

- [ ] **Step 2: Commit**

```bash
git add DEPLOY.md
git commit -m "docs: how to point the nightly MDM export at the import endpoint"
```

---

## Self-Review

**Spec coverage:** cron-auth helper → Task 1. `commitImport` unresolved → Task 2. Service account → Task 3. Route, `maxDuration`, body cap, measurement → Task 4. Docs/watch-list/CHANGELOG → folded into the tasks that make them stale. Technician hand-off → Task 5.

**Deferred to the units plan** (`2026-07-29-bulk-unit-management.md`): `/admin/units`, the `learnUnits` batching rewrite, the citext migration, unresolved surfacing in the UI, and the last-successful-import staleness signal. Those ship independently of this plan; this one leaves `unresolved` reported in the HTTP response only.

**Open item carried from the spec:** rate limiting. Deliberately none beyond the existing proxy behaviour — the secret is checked before the body is read, so an unauthenticated flood costs one constant-time compare, matching how `/api/cron/purge` is treated. Revisit only if logs show authenticated abuse.

**Not addressed by this plan:** nightly imports overwrite hand edits to `deviceName`, `deviceUIC`, holder and category, because a matched row takes the export's values. That is existing import behaviour, now happening unattended. It is recorded in the spec's risks; deciding whether to make the importer defer to a more recent human edit is a separate feature.
