# Bulk Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename a selected or scanned batch of devices to `PREFIX-001 … PREFIX-NNN` in selection order, from the `/items` More-actions sheet, refusing to apply if any generated name is already taken.

**Architecture:** A pure sequence builder computes the names and is called by BOTH the client (for the live range line) and the server (for what actually gets written) — the apply action never accepts a name list. One service function does the write in a single transaction of four queries, using a `VALUES`-join UPDATE because `updateMany` cannot set a different value per row.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Prisma 7 on PostgreSQL, Zod, Vitest (node + jsdom).

**Spec:** `docs/superpowers/specs/2026-08-11-bulk-rename-design.md` — read the "accepted tradeoff" section before starting.

## Global Constraints

- **Never query inside a loop.** No `Promise.all(ids.map(id => prisma...))`. Batch with `findMany` / `createMany` / one raw `UPDATE`.
- **Service functions enforce NO permissions.** The calling Server Action owns the guard, via `requireCapability("MANAGE_ITEMS")` from `@/lib/authz` — never bare `auth()`.
- **Cap at `MAX_BULK_ITEMS` (500)** — in the action for a readable message, in the service as the backstop.
- **Retired items are excluded and REPORTED**, never refused — the rule this repo established in `#119`.
- **The apply path NEVER accepts a client-supplied name list.** It takes `(itemIds, prefix, start)` and rebuilds the sequence server-side. This is the feature's security property.
- **Selection order IS the numbering.** Preserve caller array order everywhere; never sort or re-dedupe in a way that reorders.
- **Return shapes are ANNOTATED, not inferred** — a `"use server"` module may only export async functions, so result unions stay local `type` declarations in the action file.
- **Errors:** generic message to the client, `console.error` server-side. Never serialize a caught Prisma error.
- **Values are BOUND, never interpolated** into raw SQL (CLAUDE.md §2).
- Tests sit beside their subject. jsdom is opt-in per file via `// @vitest-environment jsdom` on **line 1**.
- **Docs ship in the same commit as the code.**
- **Working directory:** `C:\inventoryApp\.claude\worktrees\bulk-rename`, branch `worktree-bulk-rename`, cut from `main` at `e84897a`. `node_modules` resolves by parent-walk — do NOT `npm install`, never recursively delete it. `.env.test` may need copying from the main clone for DB suites.
- **Line numbers below are indicative.** Search for the symbol named.

---

## File Structure

**Create:**
- `src/modules/items/rename-sequence.ts` — the pure builder. No DOM, no network, no Prisma.
- `src/modules/items/rename-sequence.test.ts` — pure tests.
- `src/modules/items/items.rename.test.ts` — DB tests for `renameItems` / `previewRename`.

**Modify:**
- `src/modules/items/items.service.ts` — add `previewRename` and `renameItems`.
- `src/app/admin/actions/items.ts` — add `previewItemRenameAction` and `renameItemsAction`.
- `src/app/admin/actions/items.test.ts` — capability + name-list-ignored tests.
- `src/components/BulkActionsMenu.tsx` — the Rename section.
- `src/components/BulkActionsMenu.test.tsx` — jsdom coverage.
- `src/app/items/page.tsx` — pass `canRename`.
- `CHANGELOG.md`, `docs/SECURITY.md`, `.claude/rules/backend-constraints.md`.

---

### Task 1: The pure sequence builder

**Files:**
- Create: `src/modules/items/rename-sequence.ts`
- Create: `src/modules/items/rename-sequence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildRenameSequence(count: number, prefix: string, start: string): string[]`; `MAX_RENAME_PREFIX` (number); `class RenameSequenceError` with `code: "PREFIX_REQUIRED" | "PREFIX_TOO_LONG" | "START_NOT_DIGITS" | "START_OUT_OF_RANGE" | "COUNT_INVALID"`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/items/rename-sequence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRenameSequence, MAX_RENAME_PREFIX, RenameSequenceError } from "./rename-sequence";

describe("buildRenameSequence", () => {
  it("pads to the width of the start value as typed", () => {
    expect(buildRenameSequence(3, "LAPTOP", "001")).toEqual([
      "LAPTOP-001", "LAPTOP-002", "LAPTOP-003",
    ]);
    expect(buildRenameSequence(2, "LAPTOP", "01")).toEqual(["LAPTOP-01", "LAPTOP-02"]);
    expect(buildRenameSequence(2, "LAPTOP", "1")).toEqual(["LAPTOP-1", "LAPTOP-2"]);
  });

  it("treats the width as a MINIMUM and grows past it", () => {
    // 95..99 fit in two digits; 100 does not, and must not wrap or be refused.
    expect(buildRenameSequence(6, "X", "95")).toEqual([
      "X-95", "X-96", "X-97", "X-98", "X-99", "X-100",
    ]);
  });

  it("starts from zero when asked to", () => {
    expect(buildRenameSequence(2, "X", "000")).toEqual(["X-000", "X-001"]);
  });

  it("trims the prefix", () => {
    expect(buildRenameSequence(1, "  LAPTOP  ", "001")).toEqual(["LAPTOP-001"]);
  });

  it("refuses a blank prefix", () => {
    expect(() => buildRenameSequence(1, "   ", "001")).toThrow(RenameSequenceError);
    expect(() => buildRenameSequence(1, "", "001")).toMatchObject({ code: "PREFIX_REQUIRED" });
  });

  it("refuses an over-long prefix", () => {
    const long = "A".repeat(MAX_RENAME_PREFIX + 1);
    expect(() => buildRenameSequence(1, long, "001")).toMatchObject({ code: "PREFIX_TOO_LONG" });
  });

  it("refuses a start that is not digits only", () => {
    for (const bad of ["", "1a", "-1", "1.5", " 1", "0x10"]) {
      expect(() => buildRenameSequence(1, "X", bad)).toMatchObject({ code: "START_NOT_DIGITS" });
    }
  });

  it("refuses a start whose range would exceed safe integers", () => {
    expect(() => buildRenameSequence(1, "X", "9".repeat(20))).toMatchObject({
      code: "START_OUT_OF_RANGE",
    });
  });

  it("refuses a non-positive or non-integer count", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => buildRenameSequence(bad, "X", "001")).toMatchObject({ code: "COUNT_INVALID" });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run rename-sequence`
Expected: FAIL — `Failed to resolve import "./rename-sequence"`.

- [ ] **Step 3: Write the module**

Create `src/modules/items/rename-sequence.ts`:

```ts
// Pure name-sequence logic for the bulk rename. No DOM, no network, no Prisma,
// so it unit-tests directly — the same reason readiness.ts, swipe-row.ts and
// recipient-search.ts are split into leaves.
//
// It is called from BOTH sides on purpose: the client renders the live range
// line from it, and the server rebuilds the names it actually writes from it.
// One implementation means the preview and the write cannot disagree.

/** Longest prefix accepted. `deviceName` has no length constraint in the
 *  schema, but a name too long to read on a printed label is not a name, and
 *  an unbounded prefix is an unbounded write. */
export const MAX_RENAME_PREFIX = 40;

export class RenameSequenceError extends Error {
  constructor(
    public code:
      | "PREFIX_REQUIRED"
      | "PREFIX_TOO_LONG"
      | "START_NOT_DIGITS"
      | "START_OUT_OF_RANGE"
      | "COUNT_INVALID",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RenameSequenceError";
  }
}

/**
 * The names a bulk rename will write, in caller order.
 *
 * `start` is a STRING, not a number, and that is load-bearing: the pad width is
 * inferred from how it was typed, so "001" means three digits and "1" means one.
 * Parsing it to a number first would throw that away and there would be no way
 * to ask for leading zeros.
 *
 * The width is a MINIMUM, not a ceiling: starting at "95" with ten devices
 * yields 95…99 then 100, rather than wrapping or refusing. Refusing there would
 * be a puzzle at exactly the moment someone is trying to label a shelf.
 */
export function buildRenameSequence(count: number, prefix: string, start: string): string[] {
  const trimmed = prefix.trim();
  if (!trimmed) throw new RenameSequenceError("PREFIX_REQUIRED");
  if (trimmed.length > MAX_RENAME_PREFIX) throw new RenameSequenceError("PREFIX_TOO_LONG");
  if (!/^\d+$/.test(start)) throw new RenameSequenceError("START_NOT_DIGITS");
  if (!Number.isInteger(count) || count < 1) throw new RenameSequenceError("COUNT_INVALID");

  const first = Number(start);
  // Guards a pathological start like twenty nines, where the arithmetic below
  // would silently lose precision and emit duplicate names.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(first + count - 1)) {
    throw new RenameSequenceError("START_OUT_OF_RANGE");
  }

  const width = start.length;
  return Array.from({ length: count }, (_, i) =>
    `${trimmed}-${String(first + i).padStart(width, "0")}`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run rename-sequence`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/rename-sequence.ts src/modules/items/rename-sequence.test.ts
git commit -m "feat(items): pure name-sequence builder for bulk rename"
```

---

### Task 2: `previewRename` and `renameItems`

**Files:**
- Modify: `src/modules/items/items.service.ts`
- Create: `src/modules/items/items.rename.test.ts`

**Interfaces:**
- Consumes: `buildRenameSequence` (Task 1); `MAX_BULK_ITEMS`, `ItemError`, `ItemEditor`, `diffItemFields` (existing).
- Produces:
  - `type RenameCollision = { name: string; serialNumber: string }`
  - `previewRename(itemIds: string[], prefix: string, start: string): Promise<{ count: number; first: string; last: string; skipped: number; collisions: RenameCollision[] }>`
  - `renameItems(itemIds: string[], prefix: string, start: string, editor: ItemEditor): Promise<RenameResult>` where
    `type RenameResult = { ok: false; collisions: RenameCollision[] } | { ok: true; renamed: number; unchanged: number; skipped: number }`

- [ ] **Step 1: Write the failing DB test**

Create `src/modules/items/items.rename.test.ts`. Follow the fixture idiom in `src/modules/items/items.bulk.test.ts` — `beforeAll(migrateTestDb)`, `beforeEach(resetDb)`, and note `Item.createdById` is a **required non-nullable FK**:

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { renameItems, previewRename } from "./items.service";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";

let editorId: string;
const editor = () => ({ id: editorId, name: "Tech" });

async function mkItem(serial: string, deviceName: string | null, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  return prisma.item.create({
    data: { make: "Dell", model: "5540", serialNumber: serial, deviceName, status, createdById: editorId },
  });
}

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  editorId = (await prisma.user.create({
    data: { name: "Tech", email: `t${Date.now()}@unit.mil`, passwordHash: "x", role: "ADMIN" },
  })).id;
});

describe("renameItems", () => {
  it("writes a distinct consecutive name per item, in caller order", async () => {
    const a = await mkItem("R1", "old-a");
    const b = await mkItem("R2", "old-b");
    const c = await mkItem("R3", null);

    const res = await renameItems([c.id, a.id, b.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 3, unchanged: 0, skipped: 0 });

    // Caller order decides the numbering, NOT insertion or serial order.
    expect((await prisma.item.findUniqueOrThrow({ where: { id: c.id } })).deviceName).toBe("LAPTOP-001");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("LAPTOP-002");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: b.id } })).deviceName).toBe("LAPTOP-003");
  });

  it("refuses the WHOLE batch on a collision and writes nothing", async () => {
    const a = await mkItem("R4", "keep-me");
    const b = await mkItem("R5", "also-keep");
    await mkItem("R6", "LAPTOP-002"); // taken by a device outside the batch

    const res = await renameItems([a.id, b.id], "LAPTOP", "001", editor());
    expect(res).toMatchObject({ ok: false });
    if (res.ok === false) {
      expect(res.collisions).toEqual([{ name: "LAPTOP-002", serialNumber: "R6" }]);
    }

    // Nothing partial landed.
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("keep-me");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: b.id } })).deviceName).toBe("also-keep");
    expect(await prisma.itemEdit.count()).toBe(0);
  });

  it("matches collisions case-insensitively", async () => {
    const a = await mkItem("R7", "x");
    await mkItem("R8", "laptop-001");
    const res = await renameItems([a.id], "LAPTOP", "001", editor());
    expect(res).toMatchObject({ ok: false });
  });

  it("does NOT collide with a name held by an item inside the batch", async () => {
    // a already holds the name it is about to be given — that is a no-op, not a clash.
    const a = await mkItem("R9", "LAPTOP-001");
    const b = await mkItem("R10", "other");
    const res = await renameItems([a.id, b.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 1, unchanged: 1, skipped: 0 });
  });

  it("excludes retired items and numbers the survivors CONSECUTIVELY", async () => {
    const a = await mkItem("R11", "a");
    const dead = await mkItem("R12", "b", "RETIRED");
    const c = await mkItem("R13", "c");

    const res = await renameItems([a.id, dead.id, c.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 2, unchanged: 0, skipped: 1 });

    // No hole at position 2 — the survivors get 001 and 002.
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("LAPTOP-001");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: c.id } })).deviceName).toBe("LAPTOP-002");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: dead.id } })).deviceName).toBe("b");
  });

  it("writes one ItemEdit per CHANGED item, shaped like a hand edit", async () => {
    const a = await mkItem("R14", "was-a");
    await renameItems([a.id], "LAPTOP", "007", editor());

    const edits = await prisma.itemEdit.findMany({ where: { itemId: a.id } });
    expect(edits).toHaveLength(1);
    expect(edits[0].editedByName).toBe("Tech");
    expect(edits[0].changes).toEqual([{ field: "deviceName", from: "was-a", to: "LAPTOP-007" }]);
  });

  it("writes no history for an item already holding its target name", async () => {
    const a = await mkItem("R15", "LAPTOP-001");
    const res = await renameItems([a.id], "LAPTOP", "001", editor());
    expect(res).toEqual({ ok: true, renamed: 0, unchanged: 1, skipped: 0 });
    expect(await prisma.itemEdit.count()).toBe(0);
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(renameItems(ids, "X", "001", editor())).rejects.toMatchObject({ code: "TOO_MANY" });
  });

  it("leaves mdmProposedName alone, so the device stays on the rename worklist", async () => {
    // The flag means "MDM still calls this BE-XXXXXXXXXXXX — fix it in Intune".
    // A local rename does not change what MDM calls it, and clearing the flag
    // here would drop the device off ?needsRename=1 while the real job is
    // outstanding. The importer clears it on its own once MDM agrees.
    const a = await prisma.item.create({
      data: {
        make: "Dell", model: "5540", serialNumber: "R16", deviceName: "BE-2AD6890X7IOL",
        status: "ACTIVE", createdById: editorId, mdmProposedName: "BE-2AD6890X7IOL",
      },
    });
    await renameItems([a.id], "LAPTOP", "001", editor());

    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: a.id } });
    expect(fresh.deviceName).toBe("LAPTOP-001");
    expect(fresh.mdmProposedName).toBe("BE-2AD6890X7IOL");
    // And the history records only the name change, never the flag.
    const edits = await prisma.itemEdit.findMany({ where: { itemId: a.id } });
    expect(edits[0].changes).toEqual([
      { field: "deviceName", from: "BE-2AD6890X7IOL", to: "LAPTOP-001" },
    ]);
  });
});

describe("previewRename", () => {
  it("reports the range, the skip count and any collisions without writing", async () => {
    const a = await mkItem("P1", "a");
    const b = await mkItem("P2", "b");
    await mkItem("P3", "LAPTOP-002");

    const out = await previewRename([a.id, b.id], "LAPTOP", "001");
    expect(out).toEqual({
      count: 2,
      first: "LAPTOP-001",
      last: "LAPTOP-002",
      skipped: 0,
      collisions: [{ name: "LAPTOP-002", serialNumber: "P3" }],
    });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).deviceName).toBe("a");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run items.rename`
Expected: FAIL — `renameItems is not a function`.

- [ ] **Step 3: Implement both functions**

Add to `src/modules/items/items.service.ts`, below `setItemsCategory`. Add the import at the top beside the other `./` imports:

```ts
import { buildRenameSequence } from "./rename-sequence";
```

```ts
export type RenameCollision = { name: string; serialNumber: string };

export type RenameResult =
  | { ok: false; collisions: RenameCollision[] }
  | { ok: true; renamed: number; unchanged: number; skipped: number };

/** The ACTIVE ids among `ids`, in the caller's order, with their current names.
 *  Caller order is the numbering, so this must never sort. */
async function activeRenameTargets(
  client: Prisma.TransactionClient | typeof prisma,
  ids: string[],
): Promise<{ active: string[]; before: Map<string, string | null> }> {
  const rows = await client.item.findMany({
    where: { id: { in: ids }, status: "ACTIVE" },
    select: { id: true, deviceName: true },
  });
  const before = new Map(rows.map((r) => [r.id, r.deviceName]));
  return { active: ids.filter((id) => before.has(id)), before };
}

/** Names among `names` already held by an item OUTSIDE `excludeIds`.
 *
 *  Case-INSENSITIVE: `deviceName` is not citext (unlike `serialNumber`), so a
 *  plain IN would call "LAPTOP-005" and "laptop-005" different names, which
 *  nobody reading the property book would. Matches how units.service.ts
 *  compares unit names. Values are bound via Prisma.join, never interpolated. */
async function findNameCollisions(
  client: Prisma.TransactionClient | typeof prisma,
  names: string[],
  excludeIds: string[],
): Promise<RenameCollision[]> {
  if (names.length === 0) return [];
  const lowered = names.map((n) => n.toLowerCase());
  return client.$queryRaw<RenameCollision[]>(Prisma.sql`
    SELECT "deviceName" AS name, "serialNumber"::text AS "serialNumber"
    FROM "Item"
    WHERE lower("deviceName") IN (${Prisma.join(lowered)})
      AND "id" NOT IN (${Prisma.join(excludeIds)})
    ORDER BY "deviceName"
  `);
}

/**
 * What a bulk rename WOULD do. Read-only and advisory — `renameItems` re-checks
 * inside its own transaction, which is what closes the window where another
 * session takes one of these names between this call and the tap.
 *
 * Enforces NO permissions — the calling Server Action owns the guard.
 */
export async function previewRename(
  itemIds: string[],
  prefix: string,
  start: string,
): Promise<{ count: number; first: string; last: string; skipped: number; collisions: RenameCollision[] }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { count: 0, first: "", last: "", skipped: 0, collisions: [] };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const { active } = await activeRenameTargets(prisma, ids);
  if (active.length === 0) {
    return { count: 0, first: "", last: "", skipped: ids.length, collisions: [] };
  }

  const names = buildRenameSequence(active.length, prefix, start);
  return {
    count: names.length,
    first: names[0],
    last: names[names.length - 1],
    skipped: ids.length - active.length,
    collisions: await findNameCollisions(prisma, names, active),
  };
}

/**
 * Rename many items to a consecutive PREFIX-NNN sequence, in CALLER ORDER.
 *
 * Takes `prefix`/`start` and builds the names itself — it must never accept a
 * name list, or an admin-gated action becomes "write any string to any item".
 * `deviceName` is kept in the admin-only editableItemFields set precisely so it
 * is not reachable that way.
 *
 * Numbers are assigned over the SURVIVORS. Filtering retired rows before
 * numbering is what gives eight survivors of ten 001..008 rather than gaps at
 * the retired positions — the labels are printed and the pile is physical, so a
 * shifted sequence beats a gapped one.
 *
 * Four queries in one transaction, never one per item. The write is a
 * VALUES-join UPDATE because `updateMany` sets ONE value across every matched
 * row and a rename needs a different value per row. This is deliberately NOT
 * the importer's batched UPDATE: that one splices column IDENTIFIERS, which is
 * why it carries UPDATABLE_ITEM_COLUMNS / FIELD_TO_COLUMN / COLUMN_CAST. Here
 * the column is a literal, so none of that applies. No chunking either —
 * MAX_BULK_ITEMS is 500 and this binds two parameters per row, 1,000 against
 * Postgres's 65,535 ceiling.
 *
 * NOTE: `Item.deviceName` is MDM-owned and the nightly Drive import reverts a
 * rename within a night. That is an accepted product decision, not an oversight
 * — see the design spec. Do not "fix" it here.
 *
 * Enforces NO permissions — the calling Server Action owns the guard.
 */
export async function renameItems(
  itemIds: string[],
  prefix: string,
  start: string,
  editor: ItemEditor,
): Promise<RenameResult> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { ok: true, renamed: 0, unchanged: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  return prisma.$transaction(async (tx) => {
    const { active, before } = await activeRenameTargets(tx, ids);
    const skipped = ids.length - active.length;
    if (active.length === 0) return { ok: true, renamed: 0, unchanged: 0, skipped };

    const names = buildRenameSequence(active.length, prefix, start);

    const collisions = await findNameCollisions(tx, names, active);
    if (collisions.length > 0) return { ok: false, collisions };

    // Pure, in-memory diff — no query in this map.
    const edits = active
      .map((id, i) => ({
        id,
        name: names[i],
        changes: diffItemFields({ deviceName: before.get(id) ?? null }, { deviceName: names[i] }),
      }))
      .filter((e) => e.changes.length > 0);

    const unchanged = active.length - edits.length;
    if (edits.length === 0) return { ok: true, renamed: 0, unchanged, skipped };

    await tx.$executeRaw(Prisma.sql`
      UPDATE "Item" SET "deviceName" = v.name
      FROM (VALUES ${Prisma.join(
        edits.map((e) => Prisma.sql`(${e.id}::text, ${e.name}::text)`),
      )}) AS v(id, name)
      WHERE "Item"."id" = v.id
    `);

    await tx.itemEdit.createMany({
      data: edits.map((e) => ({
        itemId: e.id,
        editedById: editor.id,
        editedByName: editor.name,
        changes: e.changes as unknown as Prisma.InputJsonValue,
      })),
    });

    return { ok: true, renamed: edits.length, unchanged, skipped };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run items.rename`
Expected: PASS, 10 tests. If files this branch never touched fail, a sibling worktree's `prisma generate` or another session's `npm test` is interfering — regenerate the client and re-run before believing it.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.rename.test.ts
git commit -m "feat(items): batched rename service with a collision guard"
```

---

### Task 3: The two Server Actions

**Files:**
- Modify: `src/app/admin/actions/items.ts`
- Modify: `src/app/admin/actions/items.test.ts`
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Consumes: `previewRename`, `renameItems`, `RenameCollision`, `MAX_BULK_ITEMS` (Task 2); `MAX_RENAME_PREFIX` (Task 1); `requireCapability` from `@/lib/authz`.
- Produces:
  - `previewItemRenameAction(formData: FormData): Promise<RenamePreviewResult>`
  - `renameItemsAction(formData: FormData): Promise<RenameActionResult>`
  - Form fields on both: `itemIds` (comma-joined, order significant), `prefix`, `start`.

- [ ] **Step 1: Write the failing action tests**

Append to `src/app/admin/actions/items.test.ts`. **Read the file's existing mocking idiom first** and follow it — in particular, whether its `beforeEach` sets a persistent `requireCapability.mockResolvedValue(...)`. If it does, a `.rejects` assertion needs its own `mockRejectedValueOnce` or it passes while asserting nothing (that shipped three times on the previous branch):

```ts
import { previewItemRenameAction, renameItemsAction } from "./items";

function rfd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("renameItemsAction", () => {
  it("refuses a caller without MANAGE_ITEMS", async () => {
    requireCapability.mockRejectedValueOnce(new AuthError("FORBIDDEN"));
    await expect(
      renameItemsAction(rfd({ itemIds: "a1,a2", prefix: "LAPTOP", start: "001" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(renameItems).not.toHaveBeenCalled();
  });

  it("IGNORES a client-supplied name list and recomputes from prefix+start", async () => {
    const f = rfd({ itemIds: "a1,a2", prefix: "LAPTOP", start: "001" });
    f.append("names", "PWNED-1");
    f.append("names", "PWNED-2");
    await renameItemsAction(f);
    // The service is called with prefix+start, never with names.
    expect(renameItems).toHaveBeenCalledWith(["a1", "a2"], "LAPTOP", "001", expect.anything());
  });

  it("preserves the posted id ORDER, because order is the numbering", async () => {
    await renameItemsAction(rfd({ itemIds: "c3,a1,b2", prefix: "X", start: "1" }));
    expect(renameItems).toHaveBeenCalledWith(["c3", "a1", "b2"], "X", "1", expect.anything());
  });

  it("rejects a blank prefix and a non-digit start", async () => {
    expect(await renameItemsAction(rfd({ itemIds: "a1", prefix: " ", start: "001" }))).toHaveProperty("error");
    expect(await renameItemsAction(rfd({ itemIds: "a1", prefix: "X", start: "1a" }))).toHaveProperty("error");
  });

  it("reports a collision as a conflict rather than an error string", async () => {
    renameItems.mockResolvedValueOnce({ ok: false, collisions: [{ name: "X-1", serialNumber: "S1" }] });
    const res = await renameItemsAction(rfd({ itemIds: "a1", prefix: "X", start: "1" }));
    expect(res).toEqual({ conflict: true, collisions: [{ name: "X-1", serialNumber: "S1" }] });
  });
});

describe("previewItemRenameAction", () => {
  it("refuses a caller without MANAGE_ITEMS", async () => {
    requireCapability.mockRejectedValueOnce(new AuthError("FORBIDDEN"));
    await expect(
      previewItemRenameAction(rfd({ itemIds: "a1", prefix: "X", start: "1" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run admin/actions/items`
Expected: FAIL — `previewItemRenameAction` is not exported.

- [ ] **Step 3: Implement the actions**

Add to `src/app/admin/actions/items.ts`:

```ts
import { previewRename, renameItems, type RenameCollision } from "@/modules/items/items.service";
import { MAX_RENAME_PREFIX, RenameSequenceError } from "@/modules/items/rename-sequence";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";

/** Shared shape for both rename actions. `itemIds` order IS the numbering, so
 *  this must NOT sort or re-order — only drop blanks. */
const renameSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one item.")
    .max(MAX_BULK_ITEMS, `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.`),
  prefix: z
    .string()
    .trim()
    .min(1, "Enter a name prefix.")
    .max(MAX_RENAME_PREFIX, `Prefixes are limited to ${MAX_RENAME_PREFIX} characters.`),
  start: z.string().regex(/^\d+$/, "Start must be a whole number, like 001."),
});

function renameInput(formData: FormData) {
  return {
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
    prefix: String(formData.get("prefix") ?? ""),
    start: String(formData.get("start") ?? ""),
  };
}

type RenamePreviewResult =
  | { error: string }
  | { ok: true; count: number; first: string; last: string; skipped: number; collisions: RenameCollision[] };

type RenameActionResult =
  | { error: string }
  | { conflict: true; collisions: RenameCollision[] }
  | { ok: true; renamed: number; unchanged: number; skipped: number };

/** What the rename WOULD do — drives the sheet's range line and collision list.
 *  Advisory: renameItemsAction re-checks inside its transaction. */
export async function previewItemRenameAction(formData: FormData): Promise<RenamePreviewResult> {
  await requireCapability("MANAGE_ITEMS");

  const parsed = renameSchema.safeParse(renameInput(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const out = await previewRename(parsed.data.itemIds, parsed.data.prefix, parsed.data.start);
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof RenameSequenceError) return { error: "Check the prefix and start number." };
    console.error("[previewItemRenameAction] unexpected error:", e);
    return { error: "Couldn't work out those names. Please try again." };
  }
}

/**
 * Rename every selected item to a consecutive PREFIX-NNN sequence.
 *
 * The client posts ONLY ids, a prefix and a start. Any `names` field it sends is
 * ignored — `z.object()` strips it and the service rebuilds the sequence itself.
 * Accepting a name list would turn this into "write any string to any item".
 */
export async function renameItemsAction(formData: FormData): Promise<RenameActionResult> {
  const admin = await requireCapability("MANAGE_ITEMS");

  const parsed = renameSchema.safeParse(renameInput(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const res = await renameItems(parsed.data.itemIds, parsed.data.prefix, parsed.data.start, {
      id: admin.id,
      name: admin.name,
    });
    if (!res.ok) return { conflict: true, collisions: res.collisions };

    revalidatePath("/items");
    return { ok: true, renamed: res.renamed, unchanged: res.unchanged, skipped: res.skipped };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    if (e instanceof RenameSequenceError) return { error: "Check the prefix and start number." };
    console.error("[renameItemsAction] unexpected error:", e);
    return { error: "Something went wrong renaming those items. Please try again." };
  }
}
```

Note: this action deliberately does NOT revalidate `/admin/analytics` — a device name feeds no dashboard aggregate. It does not revalidate per-item `/i/<id>` paths either; `setReadinessAction` sets that precedent for bulk writes.

- [ ] **Step 4: Run the action tests**

Run: `npx vitest run admin/actions/items`
Expected: PASS.

- [ ] **Step 5: Update `docs/SECURITY.md`**

Add an entry beside the other `MANAGE_ITEMS` bulk writes: `renameItemsAction` and `previewItemRenameAction` are gated on `MANAGE_ITEMS`; item ids are client-supplied, bounded at 500, and **order-significant**; the written names are **recomputed server-side from `(prefix, start)`** and a posted `names` field is ignored, so the action cannot be driven to write arbitrary strings; retired items are excluded. Bump *Last reviewed* to today.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/actions/items.ts src/app/admin/actions/items.test.ts docs/SECURITY.md
git commit -m "feat(items): rename actions, with names recomputed server-side"
```

---

### Task 4: The Rename section in the sheet

**Files:**
- Modify: `src/components/BulkActionsMenu.tsx`
- Modify: `src/components/BulkActionsMenu.test.tsx`
- Modify: `src/app/items/page.tsx`
- Modify: `CHANGELOG.md`, `.claude/rules/backend-constraints.md`

**Interfaces:**
- Consumes: `previewItemRenameAction`, `renameItemsAction` (Task 3); `buildRenameSequence`, `RenameSequenceError` (Task 1); the existing `useItemSelection()`.
- Produces: a `canRename: boolean` prop on `BulkActionsMenu`.

- [ ] **Step 1: Write the failing jsdom test**

Append to `src/components/BulkActionsMenu.test.tsx` (it already carries `// @vitest-environment jsdom` on line 1 — do NOT add a second). Extend the existing `vi.mock` of the actions module rather than adding a second mock of the same path:

```tsx
test("shows the computed range as the fields change", async () => {
  const user = userEvent.setup();
  render(<BulkActionsMenu itemIds={["a", "b", "c"]} signatures={[]} canAudit={false} canQueue={false} canRename />);
  await user.type(screen.getByLabelText(/name prefix/i, { hidden: true }), "LAPTOP");
  await user.clear(screen.getByLabelText(/start at/i, { hidden: true }));
  await user.type(screen.getByLabelText(/start at/i, { hidden: true }), "001");
  expect(screen.getByText(/LAPTOP-001/, { hidden: true })).toBeInTheDocument();
  expect(screen.getByText(/LAPTOP-003/, { hidden: true })).toBeInTheDocument();
});

test("rename controls are absent without MANAGE_ITEMS", () => {
  render(<BulkActionsMenu itemIds={["a"]} signatures={[]} canAudit canQueue canRename={false} />);
  expect(screen.queryByLabelText(/name prefix/i, { hidden: true })).toBeNull();
});

test("the whole menu is absent when the caller can do nothing", () => {
  const { container } = render(
    <BulkActionsMenu itemIds={["a"]} signatures={[]} canAudit={false} canQueue={false} canRename={false} />,
  );
  expect(container.querySelector("[popover]")).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:ui -- BulkActionsMenu`
Expected: FAIL — no `name prefix` field.

- [ ] **Step 3: Add the Rename section**

In `src/components/BulkActionsMenu.tsx`. Add `canRename: boolean` to the props type and destructuring, extend the early return, and add the imports:

```tsx
import { useEffect, useState, useTransition } from "react";
import { previewItemRenameAction, renameItemsAction } from "@/app/admin/actions/items";
import { buildRenameSequence } from "@/modules/items/rename-sequence";

// …inside the component, replacing the existing early return:
if (!canAudit && !canQueue && !canRename) return null;
```

State and the derived range — its OWN transition, because one shared `pending` points the busy state at the wrong control:

```tsx
const [prefix, setPrefix] = useState("");
const [start, setStart] = useState("001");
const [renameMsg, setRenameMsg] = useState<Msg>(null);
const [collisions, setCollisions] = useState<{ name: string; serialNumber: string }[]>([]);
const [renamePending, startRename] = useTransition();

// Computed on the CLIENT from the same pure builder the server writes from, so
// the line is instant and costs no round trip. try/catch because a half-typed
// start ("" while you retype it) is an expected transient, not an error.
let range: { first: string; last: string } | null = null;
try {
  const names = buildRenameSequence(itemIds.length, prefix, start);
  range = { first: names[0], last: names[names.length - 1] };
} catch {
  range = null;
}
```

The debounced collision check. **Clear `collisions` whenever the fields change** — a stale list must never gate a different sequence:

```tsx
useEffect(() => {
  setCollisions([]);
  if (!range || itemIds.length === 0) return;
  const t = setTimeout(() => {
    const fd = new FormData();
    fd.set("itemIds", itemIds.join(","));
    fd.set("prefix", prefix);
    fd.set("start", start);
    previewItemRenameAction(fd).then((res) => {
      if ("ok" in res) setCollisions(res.collisions);
    });
  }, 400);
  return () => clearTimeout(t);
  // range is derived from these three; depending on it directly would re-run
  // on every render because it is a fresh object each time.
}, [prefix, start, itemIds]);
```

Apply:

```tsx
const applyRename = () => {
  setRenameMsg(null);
  const fd = new FormData();
  fd.set("itemIds", itemIds.join(","));
  fd.set("prefix", prefix);
  fd.set("start", start);
  startRename(async () => {
    const res = await renameItemsAction(fd);
    if ("error" in res) return setRenameMsg({ ok: false, text: res.error });
    if ("conflict" in res) {
      setCollisions(res.collisions);
      return setRenameMsg({ ok: false, text: "Those names are already taken." });
    }
    setRenameMsg({
      ok: true,
      text: outcome("Renamed", res.renamed, res.skipped) +
        (res.unchanged > 0 ? ` ${res.unchanged} already had the right name.` : ""),
    });
    // Selection deliberately KEPT — clearing unmounts the bar holding this message.
  });
};
```

The markup, following the audit and service sections so the three read as one panel:

```tsx
{canRename && (
  <div className="stack" style={{ gap: 4 }}>
    <label className="label" htmlFor="bulk-prefix">Rename — name prefix</label>
    <input
      id="bulk-prefix"
      className="input"
      value={prefix}
      disabled={renamePending || none}
      onChange={(e) => setPrefix(e.target.value)}
      placeholder="e.g. LAPTOP"
    />
    <label className="label" htmlFor="bulk-start">Start at</label>
    <input
      id="bulk-start"
      className="input"
      inputMode="numeric"
      value={start}
      disabled={renamePending || none}
      onChange={(e) => setStart(e.target.value)}
      // Leading zeros set the width, so this stays TEXT — type="number" would
      // strip them and "001" would silently become "1".
    />
    {range && (
      <span className="subtle">
        {itemIds.length} device{itemIds.length === 1 ? "" : "s"}, in scan order:{" "}
        {range.first} … {range.last}
      </span>
    )}
    {collisions.length > 0 && (
      <span role="alert" className="alert-error">
        {collisions.length} name{collisions.length === 1 ? "" : "s"} already taken:{" "}
        {collisions.map((c) => `${c.name} (${c.serialNumber})`).join(", ")}
      </span>
    )}
    <button
      type="button"
      className="btn btn-secondary"
      disabled={renamePending || none || !range || collisions.length > 0}
      onClick={applyRename}
    >
      {renamePending ? "Renaming…" : `Rename ${itemIds.length}`}
    </button>
    {collisions.length > 0 && (
      <span className="subtle">Change the prefix or start number to continue.</span>
    )}
    {renameMsg && (
      <span role={renameMsg.ok ? "status" : "alert"} className={renameMsg.ok ? "subtle" : "alert-error"}>
        {renameMsg.text}
      </span>
    )}
  </div>
)}
```

- [ ] **Step 4: Pass the capability from the page**

In `src/app/items/page.tsx`, beside the existing `canAudit` / `canQueue`:

```tsx
const canRename = user.capabilities.includes("MANAGE_ITEMS");
```

and pass `canRename` through `<ItemSelectTable>` to `<BulkActionsMenu>`. `ItemSelectTable` needs the prop threaded and documented alongside the existing two — including the note already there that the bulk row is still wrapped in `isAdmin`, so on `/items` this arrives true or the sheet is not mounted.

- [ ] **Step 5: Run the UI suite**

Run: `npm run test:ui`
Expected: PASS, including the pre-existing `BulkActionsMenu` and `ItemSelectTable` invariants unchanged.

- [ ] **Step 6: Update the docs**

`CHANGELOG.md`, new dated section, **and the MDM caveat is not optional**:

```markdown
### Added
- Rename a whole scanned or selected batch at once, from **More actions → Rename**: give a prefix and a starting number and the devices are named `PREFIX-001`, `PREFIX-002`, … in the order you scanned them. It shows the range before applying and refuses if any of those names already belongs to another device. **Note:** device names come from MDM, so the nightly import will restore the MDM name — rename in Intune for a change that sticks. The item page's *Previous names* section will show the name you set.
```

`.claude/rules/backend-constraints.md`, in the section that already documents MDM winning on `deviceName`: a bulk rename exists (`renameItems`), it is knowingly subject to that revert, numbers are assigned over **ACTIVE items only and consecutively**, and the names are always recomputed server-side from `(prefix, start)` — a posted name list is ignored.

- [ ] **Step 7: Commit**

```bash
git add src/components/BulkActionsMenu.tsx src/components/BulkActionsMenu.test.tsx \
        src/app/items/page.tsx CHANGELOG.md .claude/rules/backend-constraints.md
git commit -m "feat(items): rename a batch to a numbered sequence from the selection bar"
```

---

### Task 5: Full verification

- [ ] **Step 1: Whole suite, lint, build**

Run: `npm test`, then `npm run lint`, then `npm run build`.
Expected: all green; lint baseline is 0 errors / 33 warnings. CI runs the suite too (the `Tests (vitest)` job), but a local run debugs faster.

- [ ] **Step 2: Browser check at 1280px**

`npm run dev`, sign in as an admin, `/items`, select several items, open **More actions**:
- Typing a prefix and start updates the range line immediately, with no server round trip.
- A prefix that collides with an existing device disables Apply and lists the clash with its serial.
- Applying reports counts and the **selection is not cleared**.
- The renamed devices show the new names after the refresh.

- [ ] **Step 3: Browser check at 390px**

Same in a 390×844 viewport with touch emulation:
- The Rename fields are reachable inside the sheet's scroll box and the sticky `Done` footer still pins.
- The sheet's trigger still clears the nav rail (the `#119` fix) now that the panel is taller.
- With the sheet open, tapping a control beneath it closes the sheet WITHOUT firing that control.

Do **not** use `locator.tap()` — it auto-scrolls and has already hidden one defect on this codebase. Assert with `elementFromPoint`.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(items): <what the browser pass turned up>"
```

Skip if the pass is clean. A 500 that outlives a CSS fix means `rm -rf .next`.
