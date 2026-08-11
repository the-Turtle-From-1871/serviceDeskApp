# Bulk Actions on a Scanned Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `/items` selection three new bulk actions — record audit, flag for service, complete service — and make the selection survive a reload, so a scanned batch of 150 devices can be acted on in one tap.

**Architecture:** Extends `886e946` (#109, multi-item scanning), which already collects a scanned batch into `ItemSelectionProvider`. Persistence moves that provider onto the app's existing `makeStore`/`usePersistedPref` localStorage pattern. Three new batched service functions (no loops, one transaction each) sit behind three capability-gated Server Actions, surfaced through a new `BulkActionsMenu` popover on the selection bar.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Prisma 7 on PostgreSQL, Zod, Vitest (node + jsdom), Tailwind v4 + `globals.css` legacy layer.

**Spec:** `docs/superpowers/specs/2026-08-11-bulk-actions-on-a-scanned-batch-design.md`

## Global Constraints

Every task's requirements implicitly include all of these.

- **Never query inside a loop.** No `Promise.all(ids.map(id => prisma...))`. Batch with `findMany({ where: { id: { in: ids } } })`, `updateMany`, `createMany`.
- **Service functions enforce NO permissions.** The calling Server Action owns the guard. Every action starts with `requireUser()`/`requireCapability()`/`requireAdmin()` from `@/lib/authz` — never bare `auth()`.
- **Cap every bulk write at `MAX_BULK_ITEMS` (500)** — in the action for a readable message, and in the service as the backstop for any other caller.
- **Retired items are excluded and reported, never refused.** Every new bulk function returns `{ updated: number; skipped: number }`.
- **Return shapes are ANNOTATED, not inferred.** A `"use server"` module may only export async functions, so result unions stay as local `type` declarations in the action file.
- **Errors:** generic message to the client, `console.error` with the real error server-side. Never serialize a caught Prisma error into a client string.
- **Tests sit beside their subject** — `x.ts` → `x.test.ts`. jsdom is opt-in per file via `// @vitest-environment jsdom` on **line 1**.
- **`npm run build` and jsdom are NOT evidence for a CSS change.** Neither has a layout engine.
- **Docs ship in the same commit as the code**, per `CLAUDE.md`.
- **Work happens in the worktree `C:\inventoryApp\.claude\worktrees\bulk-scan-actions`, on branch `worktree-bulk-scan-actions`.** Branched from `a8ce592`. `node_modules` resolves by parent-walk — do not run `npm install`, and never delete `node_modules` recursively from here.
- **Line numbers in this plan are indicative only.** The file moved between planning and execution (#109, #111, #112 all landed). Search for the symbol named, not the line cited.

---

## File Structure

**Create:**
- `src/components/item-selection-store.ts` — pure parse + localStorage store for the persisted selection. No React, no DOM beyond what `makeStore` owns.
- `src/components/item-selection-store.test.ts` — pure tests for `parseSelection`.
- `src/components/BulkActionsMenu.tsx` — the popover sheet holding the three new actions.
- `src/components/BulkActionsMenu.test.tsx` — jsdom; pins the no-layout-class popover invariant.
- `src/modules/audit/audit.bulk.test.ts` — DB tests for `recordAudits`.
- `src/modules/service-queue/service-queue.bulk.test.ts` — DB tests for the two bulk queue functions.

**Modify:**
- `src/modules/items/items.schema.ts` — `MAX_BULK_ITEMS` moves here (pure, client-importable).
- `src/modules/items/items.service.ts:582` — re-export `MAX_BULK_ITEMS` instead of declaring it.
- `src/components/ItemSelection.tsx` — swap `useState` for the persisted store; add `startedAt` + `atCap`.
- `src/modules/audit/audit.service.ts` — add `recordAudits`.
- `src/app/admin/actions/audit.ts` — add `recordAuditsAction`.
- `src/modules/service-queue/service-queue.errors.ts` — add `TOO_MANY` to the code union.
- `src/modules/service-queue/service-queue.service.ts` — add `upsertServiceRequests`, `completeServiceItems`.
- `src/app/admin/actions/queue.ts` — add `flagItemsForServiceAction`, `completeServiceItemsAction`.
- `src/app/admin/actions/queue.test.ts` — capability-refusal tests for both new actions.
- `src/app/admin/actions/audit.test.ts` — capability-refusal + foreign-signature tests.
- `src/components/ItemSelectTable.tsx` — render `<BulkActionsMenu>` in the selection bar; show the batch age.
- `src/app/items/page.tsx` — pass `signatures` and capability flags down.
- `src/app/globals.css` — add `#items-bulkactions` to all four popover rule groups.
- `CHANGELOG.md`, `docs/SECURITY.md`, `.claude/rules/backend-constraints.md`, `CLAUDE.md`.

---

### Task 1: Persist the `/items` selection

The selection is a `useState` Map today, so a screen lock loses a 150-item sweep. This moves it to localStorage through the app's existing pattern and caps it at `MAX_BULK_ITEMS`.

**Files:**
- Modify: `src/modules/items/items.schema.ts`
- Modify: `src/modules/items/items.service.ts:580-582`
- Create: `src/components/item-selection-store.ts`
- Create: `src/components/item-selection-store.test.ts`
- Modify: `src/components/ItemSelection.tsx`
- Modify: `src/components/ItemSelection.test.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `makeStore`, `usePersistedPref` from `src/components/persisted-pref.ts`; `SelectedItem` from `src/components/items-view.ts`.
- Produces: `MAX_BULK_ITEMS` (now from `items.schema.ts`); `parseSelection(raw: string | null): PersistedSelection`; `selectionStore`; `EMPTY_SELECTION`; and an extended `ItemSelectionValue` carrying `startedAt: number` and `atCap: boolean`.

- [ ] **Step 1: Move `MAX_BULK_ITEMS` into the pure schema module**

`items.service.ts` imports Prisma, so a Client Component cannot import the constant from there without pulling a DB client into the browser bundle. `items.schema.ts` is pure Zod. Append to `src/modules/items/items.schema.ts`:

```ts
/** Hard cap on one bulk action. The UI selects at most this many, but every
 *  bulk action is reachable by POST, so the server bounds it too.
 *
 *  Declared HERE rather than in items.service.ts because the /items selection
 *  is a Client Component and must be able to import it — items.service.ts
 *  imports Prisma, which must never reach the browser bundle. */
export const MAX_BULK_ITEMS = 500;
```

- [ ] **Step 2: Import AND re-export it from the service, so nothing downstream changes**

In `src/modules/items/items.service.ts`, delete the `export const MAX_BULK_ITEMS = 500;` declaration and its docblock (search for the symbol — it sits just above `markItemsReady`; do not trust a line number, the file moves).

**Both an import and a re-export are required.** `MAX_BULK_ITEMS` is used at five sites *inside* this file (`markItemsReady`, `clearItemsReady`, `setItemsStatus`, `setItemsCategory`, and the scanned-items create). A bare `export { X } from "./y"` re-exports the name without binding it in module scope, so those five uses would fail to compile.

Extend the existing `items.schema` import on line 9:

```ts
import {
  newItemSchema,
  normalizeCategoryName,
  MAX_BULK_ITEMS,
  type NewItemInput,
  type ScannedItemInput,
} from "./items.schema";
```

then re-export it beside the other exports so every existing importer of `items.service` keeps working:

```ts
// Re-exported, not redeclared: the definition lives in the pure schema module
// so the /items selection (a Client Component) can import it without pulling
// Prisma into the browser bundle. See items.schema.ts.
export { MAX_BULK_ITEMS };
```

- [ ] **Step 3: Run the existing suites that touch the cap, to prove the move changed nothing**

Run: `npx vitest run items.bulk readiness`
Expected: PASS. These already assert `TOO_MANY` at the cap; if they pass, all five call sites still resolve the constant.

- [ ] **Step 4: Write the failing test for the store parser**

Create `src/components/item-selection-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSelection, EMPTY_SELECTION } from "./item-selection-store";

const ok = { id: "a1", make: "Dell", model: "5540", serialNumber: "7XK2Q13", status: "ACTIVE" };

describe("parseSelection", () => {
  it("returns the empty selection for null", () => {
    expect(parseSelection(null)).toEqual(EMPTY_SELECTION);
  });

  it("returns the empty selection for malformed JSON rather than throwing", () => {
    expect(parseSelection("{not json")).toEqual(EMPTY_SELECTION);
  });

  it("returns the empty selection when items is not an array", () => {
    expect(parseSelection(JSON.stringify({ startedAt: 1, items: "nope" }))).toEqual(EMPTY_SELECTION);
  });

  it("round-trips a valid selection", () => {
    const raw = JSON.stringify({ startedAt: 1754870000000, items: [ok] });
    expect(parseSelection(raw)).toEqual({ startedAt: 1754870000000, items: [ok] });
  });

  it("drops entries that are not well-formed SelectedItems", () => {
    const raw = JSON.stringify({
      startedAt: 5,
      items: [ok, { id: "b2" }, null, { ...ok, id: "", }, { ...ok, id: "c3", status: "GONE" }],
    });
    expect(parseSelection(raw)).toEqual({ startedAt: 5, items: [ok] });
  });

  it("falls back to 0 for a non-finite startedAt", () => {
    const raw = JSON.stringify({ startedAt: "yesterday", items: [ok] });
    expect(parseSelection(raw).startedAt).toBe(0);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run item-selection-store`
Expected: FAIL — `Failed to resolve import "./item-selection-store"`.

- [ ] **Step 6: Write the store**

Create `src/components/item-selection-store.ts`:

```ts
import { makeStore } from "./persisted-pref";
import type { SelectedItem } from "./items-view";

/** Versioned, so a future shape change retires old batches instead of parsing
 *  them into something subtly wrong. */
export const SELECTION_KEY = "items:selection:v1";

/** What is persisted: the selected items, plus when the batch began — the bar
 *  renders the age so a batch found the next morning is legible rather than
 *  mysterious. */
export type PersistedSelection = { startedAt: number; items: SelectedItem[] };

export const EMPTY_SELECTION: PersistedSelection = { startedAt: 0, items: [] };

/** localStorage is attacker-writable and survives deploys, so every field is
 *  validated rather than trusted. A bad entry is DROPPED, not defaulted: a
 *  half-parsed item would render a row with a blank serial and, worse, could
 *  reach a bulk action as an id nobody scanned. */
function isSelectedItem(v: unknown): v is SelectedItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" && o.id !== "" &&
    typeof o.make === "string" &&
    typeof o.model === "string" &&
    typeof o.serialNumber === "string" &&
    (o.status === "ACTIVE" || o.status === "RETIRED")
  );
}

export function parseSelection(raw: string | null): PersistedSelection {
  if (!raw) return EMPTY_SELECTION;
  try {
    const v = JSON.parse(raw) as { startedAt?: unknown; items?: unknown };
    if (!Array.isArray(v.items)) return EMPTY_SELECTION;
    const items = v.items.filter(isSelectedItem);
    const startedAt =
      typeof v.startedAt === "number" && Number.isFinite(v.startedAt) ? v.startedAt : 0;
    return { startedAt, items };
  } catch {
    return EMPTY_SELECTION;
  }
}

export const selectionStore = makeStore<PersistedSelection>(SELECTION_KEY, parseSelection);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run item-selection-store`
Expected: PASS, 6 tests.

- [ ] **Step 8: Rewrite the provider onto the store**

Replace the body of `src/components/ItemSelection.tsx` (keep the `"use client"` line and the `SelectedItem` re-export):

```tsx
"use client";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { SelectedItem } from "./items-view";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
import { usePersistedPref } from "./persisted-pref";
import { selectionStore, EMPTY_SELECTION } from "./item-selection-store";

export type { SelectedItem };

type ItemSelectionValue = {
  /** id -> item. A Map, not a Set of ids, so it survives paging: the
   *  receipt-group validation needs each selected item's make/model, and an
   *  item selected on page 1 is gone from `items` once you page forward. */
  selected: ReadonlyMap<string, SelectedItem>;
  /** Epoch ms the current batch began, or 0 when nothing is selected. */
  startedAt: number;
  /** True once the selection has reached MAX_BULK_ITEMS — further scans are
   *  refused rather than collected and failed at the end. */
  atCap: boolean;
  toggle: (item: SelectedItem) => void;
  addMany: (items: SelectedItem[]) => void;
  removeMany: (ids: string[]) => void;
  clear: () => void;
};

const Ctx = createContext<ItemSelectionValue | null>(null);

/**
 * Owns the /items selection. It lives here rather than inside ItemSelectTable
 * because the scan sheet and the table are SIBLING client components under a
 * Server Component page, so neither can reach the other's state.
 *
 * PERSISTED to localStorage: a scanned batch can be 150 devices collected over
 * twenty minutes walking a room, and losing it to a screen lock or an
 * accidental back-swipe means re-scanning from zero with no record of what was
 * already counted. usePersistedPref is built on useSyncExternalStore, so the
 * server snapshot is used during SSR and the stored value takes over on the
 * client — no hydration mismatch, and it syncs across tabs for free.
 */
export function ItemSelectionProvider({ children }: { children: ReactNode }) {
  const [persisted] = usePersistedPref(selectionStore, EMPTY_SELECTION);

  const selected = useMemo(
    () => new Map(persisted.items.map((it) => [it.id, it])),
    [persisted.items],
  );

  /**
   * Every mutation reads the CURRENT stored value rather than closing over
   * `persisted`. ItemsScanButton calls addMany from a decode loop that fires
   * again before React has re-rendered, so a closed-over snapshot would drop
   * scans — the same hazard its own `seen` ref exists to avoid. store.get()
   * re-reads localStorage, so this is always the live list.
   */
  const mutate = useCallback((fn: (items: SelectedItem[]) => SelectedItem[]) => {
    const current = selectionStore.get();
    const items = fn(current.items);
    selectionStore.set(
      items.length === 0
        ? EMPTY_SELECTION
        : { startedAt: current.startedAt || Date.now(), items },
    );
  }, []);

  const toggle = useCallback((item: SelectedItem) => {
    mutate((items) =>
      items.some((i) => i.id === item.id)
        ? items.filter((i) => i.id !== item.id)
        : items.length >= MAX_BULK_ITEMS
          ? items
          : [...items, item],
    );
  }, [mutate]);

  // RETIRED is refused HERE as well as by callers: retired rows render no
  // checkbox and selectableIds excludes them, so a bulk action must never
  // receive one. `toggle` stays permissive on purpose — it is the checkbox's
  // own handler, and a strict toggle could not un-select a row that somehow
  // got in.
  const addMany = useCallback((incoming: SelectedItem[]) => {
    mutate((items) => {
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const it of incoming) {
        if (it.status !== "ACTIVE") continue;
        if (!byId.has(it.id) && byId.size >= MAX_BULK_ITEMS) continue;
        byId.set(it.id, it);
      }
      return [...byId.values()];
    });
  }, [mutate]);

  const removeMany = useCallback((ids: string[]) => {
    const drop = new Set(ids);
    mutate((items) => items.filter((i) => !drop.has(i.id)));
  }, [mutate]);

  const clear = useCallback(() => selectionStore.set(EMPTY_SELECTION), []);

  const value = useMemo(
    () => ({
      selected,
      startedAt: persisted.startedAt,
      atCap: selected.size >= MAX_BULK_ITEMS,
      toggle,
      addMany,
      removeMany,
      clear,
    }),
    [selected, persisted.startedAt, toggle, addMany, removeMany, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useItemSelection(): ItemSelectionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useItemSelection must be used inside <ItemSelectionProvider>");
  return ctx;
}
```

- [ ] **Step 9: Add the persistence test to the provider's jsdom suite**

Append to `src/components/ItemSelection.test.tsx` (the file already carries `// @vitest-environment jsdom` on line 1 — do not add a second):

```tsx
import { SELECTION_KEY } from "./item-selection-store";

const ITEM = { id: "a1", make: "Dell", model: "5540", serialNumber: "7XK2Q13", status: "ACTIVE" as const };

function Probe() {
  const { selected, atCap } = useItemSelection();
  return <output>{`${selected.size}${atCap ? " CAP" : ""}`}</output>;
}

test("a selection survives an unmount and remount", async () => {
  const user = userEvent.setup();
  const { unmount } = render(
    <ItemSelectionProvider>
      <AddButton item={ITEM} />
      <Probe />
    </ItemSelectionProvider>,
  );
  await user.click(screen.getByRole("button", { name: /add/i }));
  expect(screen.getByRole("status")).toHaveTextContent("1");
  unmount();

  render(
    <ItemSelectionProvider>
      <Probe />
    </ItemSelectionProvider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("1");
});

test("a corrupt stored value yields an empty selection instead of throwing", () => {
  window.localStorage.setItem(SELECTION_KEY, "{not json");
  render(
    <ItemSelectionProvider>
      <Probe />
    </ItemSelectionProvider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("0");
});
```

Add a local `AddButton` helper beside `Probe` if the file has none:

```tsx
function AddButton({ item }: { item: typeof ITEM }) {
  const { addMany } = useItemSelection();
  return <button onClick={() => addMany([item])}>Add</button>;
}
```

Clear storage between tests so one case cannot seed the next:

```tsx
afterEach(() => window.localStorage.clear());
```

- [ ] **Step 10: Run the provider and table suites**

Run: `npm run test:ui`
Expected: PASS, including the pre-existing `ItemSelection.test.tsx` and `ItemSelectTable.test.tsx` cases unchanged.

- [ ] **Step 11: Add the changelog entry**

In `CHANGELOG.md`, add a new section at the top (or extend today's if one exists):

```markdown
## 2026-08-11

### Added
- The `/items` selection now survives a reload, a screen lock and a re-login. A batch scanned over several minutes is no longer lost, and the selection bar shows when it was started. Selections are capped at 500 items, matching the limit bulk actions already enforced.
```

- [ ] **Step 12: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/items/items.service.ts \
        src/components/item-selection-store.ts src/components/item-selection-store.test.ts \
        src/components/ItemSelection.tsx src/components/ItemSelection.test.tsx CHANGELOG.md
git commit -m "feat(items): keep the /items selection across reloads"
```

---

### Task 2: Bulk audit

`markAuditedAction` audits one item under one signature, which makes a shelf sweep unusable. This adds the batched twin. It is affordable only because signature blobs are content-addressed and deduplicated — 150 audits reference one `SignatureAsset` row.

**Files:**
- Modify: `src/modules/audit/audit.service.ts`
- Create: `src/modules/audit/audit.bulk.test.ts`
- Modify: `src/app/admin/actions/audit.ts`
- Modify: `src/app/admin/actions/audit.test.ts`
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Consumes: `MAX_BULK_ITEMS` from `@/modules/items/items.schema`; `ItemError` from `@/modules/items/items.errors`; `putSignatureAsset` from `@/modules/signatures/signature-asset.service`; `getOwnedSignature` from `@/modules/signatures/signatures.service`.
- Produces: `recordAudits(input: RecordAuditsInput): Promise<{ updated: number; skipped: number }>` and `recordAuditsAction(formData: FormData): Promise<BulkAuditResult>`.

- [ ] **Step 1: Write the failing DB test**

Create `src/modules/audit/audit.bulk.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { recordAudits } from "./audit.service";
import { ItemError } from "@/modules/items/items.errors";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

async function mkItem(serial: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  return prisma.item.create({
    data: { make: "Dell", model: "5540", serialNumber: serial, deviceName: `dev-${serial}`, status },
  });
}

async function mkUser() {
  return prisma.user.create({
    data: { name: "Auditor", email: `a${Date.now()}@unit.mil`, passwordHash: "x", role: "ADMIN" },
  });
}

describe("recordAudits", () => {
  let userId: string;
  beforeEach(async () => {
    userId = (await mkUser()).id;
  });

  it("writes one audit per item and ONE shared signature asset", async () => {
    const items = await Promise.all([mkItem("BULKA1"), mkItem("BULKA2"), mkItem("BULKA3")]);
    const res = await recordAudits({
      itemIds: items.map((i) => i.id),
      auditedById: userId,
      auditedByName: "Auditor",
      signerName: "SGT Smith",
      signatureImage: PNG,
    });

    expect(res).toEqual({ updated: 3, skipped: 0 });

    const audits = await prisma.itemAudit.findMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(audits).toHaveLength(3);
    expect(new Set(audits.map((a) => a.signatureSha)).size).toBe(1);
  });

  it("stamps lastAuditedAt with the SAME instant as the audit rows", async () => {
    const item = await mkItem("BULKA4");
    await recordAudits({
      itemIds: [item.id],
      auditedById: userId,
      auditedByName: "Auditor",
      signerName: "SGT Smith",
      signatureImage: PNG,
    });
    const audit = await prisma.itemAudit.findFirstOrThrow({ where: { itemId: item.id } });
    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.lastAuditedAt?.getTime()).toBe(audit.createdAt.getTime());
  });

  it("excludes retired items and reports them as skipped", async () => {
    const active = await mkItem("BULKA5");
    const retired = await mkItem("BULKA6", "RETIRED");
    const res = await recordAudits({
      itemIds: [active.id, retired.id],
      auditedById: userId,
      auditedByName: "Auditor",
      signerName: "SGT Smith",
      signatureImage: PNG,
    });
    expect(res).toEqual({ updated: 1, skipped: 1 });
    expect(await prisma.itemAudit.count({ where: { itemId: retired.id } })).toBe(0);
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(
      recordAudits({ itemIds: ids, auditedById: userId, auditedByName: "A", signerName: "S", signatureImage: PNG }),
    ).rejects.toMatchObject({ code: "TOO_MANY" });
  });

  it("is a no-op for an empty list", async () => {
    const res = await recordAudits({
      itemIds: [], auditedById: userId, auditedByName: "A", signerName: "S", signatureImage: PNG,
    });
    expect(res).toEqual({ updated: 0, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run audit.bulk`
Expected: FAIL — `recordAudits is not a function`.

- [ ] **Step 3: Implement `recordAudits`**

Add to `src/modules/audit/audit.service.ts`, below `recordAudit`, with these imports at the top:

```ts
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
import { ItemError } from "@/modules/items/items.errors";
```

```ts
export type RecordAuditsInput = {
  itemIds: string[];
  auditedById: string;
  auditedByName: string;
  signerName: string;
  signatureImage: string;
};

/**
 * Record ONE audit event per item, under a single signature — the batched twin
 * of recordAudit, for a shelf sweep.
 *
 * Four queries in one transaction, never one per item. Step 2 is the whole
 * reason this is affordable: the signature is content-addressed, so 150 audits
 * reference ONE SignatureAsset row rather than storing 150 copies of the blob.
 *
 * RETIRED items are excluded and REPORTED, not refused. That deliberately
 * diverges from markAuditedAction, which rejects a retired item outright: right
 * for one item, wrong for a batch, where one retired device must not fail an
 * audit of 150.
 *
 * `now` is computed here and BOUND to both the audit rows and lastAuditedAt.
 * ItemAudit.createdAt is @default(now()), so omitting it would take the
 * database's clock per row and leave the denormalized column milliseconds adrift
 * from the log it summarizes — the drift the single transaction exists to
 * prevent.
 *
 * Enforces NO permissions — the calling Server Action owns the admin guard.
 */
export async function recordAudits(
  input: RecordAuditsInput,
): Promise<{ updated: number; skipped: number }> {
  const ids = [...new Set(input.itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const active = await tx.item.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: { id: true },
    });
    if (active.length === 0) return { updated: 0, skipped: ids.length };

    const signatureSha = await putSignatureAsset(tx, input.signatureImage);
    const activeIds = active.map((a) => a.id);

    await tx.itemAudit.createMany({
      data: activeIds.map((itemId) => ({
        itemId,
        auditedById: input.auditedById,
        auditedByName: input.auditedByName,
        signerName: input.signerName,
        signatureSha,
        createdAt: now,
      })),
    });
    await tx.item.updateMany({
      where: { id: { in: activeIds } },
      data: { lastAuditedAt: now },
    });

    return { updated: activeIds.length, skipped: ids.length - activeIds.length };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run audit.bulk`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing action test**

Append to `src/app/admin/actions/audit.test.ts`:

```ts
import { recordAuditsAction } from "./audit";

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("recordAuditsAction", () => {
  it("refuses a caller without ADMINISTER", async () => {
    // Follow this file's existing session-mocking helper; the assertion is that
    // the AuthError propagates rather than the action returning ok.
    await expect(
      recordAuditsAction(fd({ itemIds: "a1,a2", signatureId: "s1" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a signature belonging to another admin", async () => {
    const res = await recordAuditsAction(fd({ itemIds: "a1", signatureId: "someone-elses-id" }));
    expect(res).toEqual({ error: "Select a valid signature." });
  });

  it("refuses an empty selection", async () => {
    const res = await recordAuditsAction(fd({ itemIds: "", signatureId: "s1" }));
    expect(res).toEqual({ error: "Select at least one item." });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run admin/actions/audit`
Expected: FAIL — `recordAuditsAction` is not exported.

- [ ] **Step 7: Implement the action**

Add to `src/app/admin/actions/audit.ts`:

```ts
import { recordAudits } from "@/modules/audit/audit.service";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
import { ItemError } from "@/modules/items/items.errors";

const bulkAuditSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one item.")
    .max(MAX_BULK_ITEMS, `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.`),
  signatureId: z.string().min(1, "Select a signature."),
});

type BulkAuditResult =
  | { error: string }
  | { ok: true; updated: number; skipped: number };

/**
 * Audit every selected item under ONE signature — the /items selection-bar
 * twin of markAuditedAction, for a scanned shelf sweep.
 *
 * The client posts only ids and a signatureId. The signer name and image are
 * re-read server-side scoped to the acting admin, so a client can neither forge
 * a signer nor use another admin's ink. The batch is client-supplied ids, so
 * this guard is the entire boundary.
 */
export async function recordAuditsAction(formData: FormData): Promise<BulkAuditResult> {
  const user = await requireAdmin();

  const parsed = bulkAuditSchema.safeParse({
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
    signatureId: String(formData.get("signatureId") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const sig = await getOwnedSignature(parsed.data.signatureId, user.id);
    if (!sig) return { error: "Select a valid signature." };

    const { updated, skipped } = await recordAudits({
      itemIds: parsed.data.itemIds,
      auditedById: user.id,
      auditedByName: user.name,
      signerName: sig.name,
      signatureImage: sig.image,
    });

    revalidatePath("/items");
    // Audit recency drives the dashboard's accountability donut.
    revalidatePath("/admin/analytics");
    return { ok: true, updated, skipped };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[recordAuditsAction] unexpected error:", e);
    return { error: "Something went wrong recording those audits. Please try again." };
  }
}
```

- [ ] **Step 8: Run the action tests**

Run: `npx vitest run admin/actions/audit`
Expected: PASS.

- [ ] **Step 9: Update `docs/SECURITY.md`**

Add `recordAuditsAction` to the authz-controls inventory beside `markAuditedAction`: gated on `ADMINISTER`; item ids are client-supplied and bounded at 500; the signer is resolved server-side via `getOwnedSignature(id, session.user.id)` so a foreign signature id is refused; retired items are excluded server-side. Bump the *Last reviewed* date at the top.

- [ ] **Step 10: Commit**

```bash
git add src/modules/audit/audit.service.ts src/modules/audit/audit.bulk.test.ts \
        src/app/admin/actions/audit.ts src/app/admin/actions/audit.test.ts docs/SECURITY.md
git commit -m "feat(audit): record an audit for many items under one signature"
```

---

### Task 3: Bulk flag for service

**Files:**
- Modify: `src/modules/service-queue/service-queue.errors.ts`
- Modify: `src/modules/service-queue/service-queue.service.ts`
- Create: `src/modules/service-queue/service-queue.bulk.test.ts`
- Modify: `src/app/admin/actions/queue.ts`
- Modify: `src/app/admin/actions/queue.test.ts`
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Consumes: `normalizeNote`, `computeServiceDueAt`, `serviceDueAtUpdate` (already in the module); `MAX_BULK_ITEMS`; `parseOverrideDays` from `@/modules/service-queue/service-form`.
- Produces: `upsertServiceRequests(input): Promise<{ updated: number; skipped: number }>` and `flagItemsForServiceAction(formData): Promise<BulkQueueResult>`, where `BulkQueueResult = { error: string } | { ok: true; updated: number; skipped: number }`.

- [ ] **Step 1: Add the `TOO_MANY` error code**

Replace `src/modules/service-queue/service-queue.errors.ts`:

```ts
export class ServiceQueueError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID_STATUS" | "NOTE_REQUIRED" | "TOO_MANY",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ServiceQueueError";
  }
}
```

- [ ] **Step 2: Write the failing DB test**

Create `src/modules/service-queue/service-queue.bulk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import prisma from "@/lib/prisma";
import { upsertServiceRequests } from "./service-queue.service";

async function mkItem(serial: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  return prisma.item.create({
    data: { make: "Dell", model: "5540", serialNumber: serial, deviceName: `dev-${serial}`, status },
  });
}

describe("upsertServiceRequests", () => {
  it("creates a PENDING row for every item that had none", async () => {
    const items = await Promise.all([mkItem("BULKQ1"), mkItem("BULKQ2")]);
    const res = await upsertServiceRequests({
      itemIds: items.map((i) => i.id),
      serviceType: "REIMAGE",
    });
    expect(res).toEqual({ updated: 2, skipped: 0 });
    const rows = await prisma.serviceQueueItem.findMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(rows.every((r) => r.dueAt === null)).toBe(true);
  });

  it("WIPES a COMPLETED row's stale deadline before reopening it — a new round resets", async () => {
    const item = await mkItem("BULKQ3");
    await prisma.serviceQueueItem.create({
      data: {
        itemId: item.id,
        serviceType: "REPAIR",
        status: "COMPLETED",
        dueAt: new Date("2026-01-01"),
        overdueAlertedAt: new Date("2026-01-02"),
      },
    });

    await upsertServiceRequests({ itemIds: [item.id], serviceType: "REIMAGE" });

    const row = await prisma.serviceQueueItem.findUniqueOrThrow({ where: { itemId: item.id } });
    expect(row.status).toBe("PENDING");
    expect(row.dueAt).toBeNull();
    expect(row.overdueAlertedAt).toBeNull();
  });

  it("leaves a live PENDING row's deadline untouched when no days are given", async () => {
    const item = await mkItem("BULKQ4");
    const due = new Date("2026-12-01T00:00:00.000Z");
    await prisma.serviceQueueItem.create({
      data: { itemId: item.id, serviceType: "REPAIR", status: "PENDING", dueAt: due },
    });

    await upsertServiceRequests({ itemIds: [item.id], serviceType: "REIMAGE" });

    const row = await prisma.serviceQueueItem.findUniqueOrThrow({ where: { itemId: item.id } });
    expect(row.serviceType).toBe("REIMAGE");
    expect(row.dueAt?.getTime()).toBe(due.getTime());
  });

  it("sets a fresh deadline on every row when days are given", async () => {
    const items = await Promise.all([mkItem("BULKQ5"), mkItem("BULKQ6")]);
    await upsertServiceRequests({
      itemIds: items.map((i) => i.id),
      serviceType: "REPAIR",
      overrideDays: 7,
    });
    const rows = await prisma.serviceQueueItem.findMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(rows.every((r) => r.dueAt !== null)).toBe(true);
  });

  it("excludes retired items and reports them as skipped", async () => {
    const active = await mkItem("BULKQ7");
    const retired = await mkItem("BULKQ8", "RETIRED");
    const res = await upsertServiceRequests({
      itemIds: [active.id, retired.id],
      serviceType: "REPAIR",
    });
    expect(res).toEqual({ updated: 1, skipped: 1 });
    expect(await prisma.serviceQueueItem.count({ where: { itemId: retired.id } })).toBe(0);
  });

  it("requires a note for OTHER", async () => {
    const item = await mkItem("BULKQ9");
    await expect(
      upsertServiceRequests({ itemIds: [item.id], serviceType: "OTHER", note: "  " }),
    ).rejects.toMatchObject({ code: "NOTE_REQUIRED" });
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(
      upsertServiceRequests({ itemIds: ids, serviceType: "REPAIR" }),
    ).rejects.toMatchObject({ code: "TOO_MANY" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run service-queue.bulk`
Expected: FAIL — `upsertServiceRequests is not a function`.

- [ ] **Step 4: Implement `upsertServiceRequests`**

Add to `src/modules/service-queue/service-queue.service.ts`, below `upsertServiceRequest`, importing the cap at the top:

```ts
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
```

```ts
type BulkUpsertInput = {
  itemIds: string[];
  serviceType: ServiceType;
  note?: string | null;
  overrideDays?: number | null;
};

/**
 * Flag MANY items for service in one pass — the batched twin of
 * upsertServiceRequest, for a cart of devices scanned off a shelf.
 *
 * Four queries in one transaction, never one per item. The COMPLETED wipe stays
 * AHEAD of the update for the same reason it does in the single-item path: a
 * device that broke a second time would otherwise inherit the finished round's
 * dueAt (opening as "Overdue 17d") and its overdueAlertedAt, which the sweep's
 * `overdueAlertedAt: null` filter turns into "this lapse can never alert".
 *
 * Blank days keeps its two meanings — NO deadline on create
 * (computeServiceDueAt), NO CHANGE on update (serviceDueAtUpdate returns {}) —
 * so re-flagging a live request cannot move a deadline nobody touched.
 *
 * transferId is null: a scanned batch has no receipt behind it, matching the
 * item-page flag rather than the receipt builder's.
 *
 * RETIRED items are excluded and REPORTED, not refused — see recordAudits.
 *
 * Enforces NO permissions — the calling Server Action owns the guard.
 */
export async function upsertServiceRequests(
  input: BulkUpsertInput,
): Promise<{ updated: number; skipped: number }> {
  // Throws NOTE_REQUIRED before any query, so an OTHER with no note cannot
  // half-apply across a batch.
  const serviceNote = normalizeNote(input.serviceType, input.note);

  const ids = [...new Set(input.itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ServiceQueueError("TOO_MANY");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const active = await tx.item.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: { id: true },
    });
    const activeIds = active.map((a) => a.id);
    if (activeIds.length === 0) return { updated: 0, skipped: ids.length };

    const existing = await tx.serviceQueueItem.findMany({
      where: { itemId: { in: activeIds } },
      select: { itemId: true },
    });
    const existingIds = new Set(existing.map((e) => e.itemId));

    // New round resets: scoped to COMPLETED, so a genuine re-save of a PENDING
    // row keeps its deadline.
    await tx.serviceQueueItem.updateMany({
      where: { itemId: { in: activeIds }, status: "COMPLETED" },
      data: { dueAt: null, overdueAlertedAt: null },
    });

    if (existingIds.size > 0) {
      await tx.serviceQueueItem.updateMany({
        where: { itemId: { in: [...existingIds] } },
        data: {
          serviceType: input.serviceType,
          serviceNote,
          transferId: null,
          status: "PENDING",
          ...serviceDueAtUpdate(input.overrideDays, now),
        },
      });
    }

    const fresh = activeIds.filter((id) => !existingIds.has(id));
    if (fresh.length > 0) {
      await tx.serviceQueueItem.createMany({
        data: fresh.map((itemId) => ({
          itemId,
          serviceType: input.serviceType,
          serviceNote,
          transferId: null,
          status: "PENDING" as const,
          dueAt: computeServiceDueAt(now, input.overrideDays),
          overdueAlertedAt: null,
        })),
        // Race-safe against the same item being flagged elsewhere between the
        // read and the write, leaning on the unique itemId constraint.
        skipDuplicates: true,
      });
    }

    return { updated: activeIds.length, skipped: ids.length - activeIds.length };
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run service-queue.bulk`
Expected: PASS, 7 tests.

- [ ] **Step 6: Implement the action**

Add to `src/app/admin/actions/queue.ts`:

```ts
import { upsertServiceRequests } from "@/modules/service-queue/service-queue.service";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";

const bulkFlagSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one item.")
    .max(MAX_BULK_ITEMS, `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.`),
  serviceType: z.enum(["REIMAGE", "REPAIR", "OTHER"]),
  note: z.string().optional(),
});

type BulkQueueResult =
  | { error: string }
  | { ok: true; updated: number; skipped: number };

function bulkIds(formData: FormData): string[] {
  return String(formData.get("itemIds") ?? "").split(",").filter(Boolean);
}

/**
 * Flag every selected item for service — the /items selection-bar twin of
 * setServiceAction, for a cart of devices scanned off a shelf.
 *
 * No transferId: a scanned batch has no receipt behind it. Unlike
 * setServiceAction, `overrideDays` is accepted on every call, because a batch
 * has no per-item "already flagged?" state for the form to branch on — a blank
 * still means no deadline on create and no change on update.
 */
export async function flagItemsForServiceAction(formData: FormData): Promise<BulkQueueResult> {
  await requireCapability("MANAGE_QUEUE");

  const parsed = bulkFlagSchema.safeParse({
    itemIds: bulkIds(formData),
    serviceType: String(formData.get("serviceType") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const { updated, skipped } = await upsertServiceRequests({
      itemIds: parsed.data.itemIds,
      serviceType: parsed.data.serviceType,
      note: parsed.data.note,
      overrideDays: parseOverrideDays(formData.get("overrideDays")),
    });
    revalidatePath("/items");
    revalidatePath("/admin/queue");
    // A PENDING queue row reads as IN_REPAIR in the fleet buckets.
    revalidatePath("/admin/analytics");
    return { ok: true, updated, skipped };
  } catch (e) {
    if (e instanceof ServiceQueueError && e.code === "NOTE_REQUIRED") {
      return { error: "Describe the service needed for 'Other'." };
    }
    if (e instanceof ServiceQueueError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[flagItemsForServiceAction] unexpected error:", e);
    return { error: "Something went wrong flagging those items. Please try again." };
  }
}
```

- [ ] **Step 7: Add the capability-refusal test**

Append to `src/app/admin/actions/queue.test.ts`, following the file's existing session-mocking helper:

```ts
import { flagItemsForServiceAction } from "./queue";

describe("flagItemsForServiceAction", () => {
  it("refuses a caller without MANAGE_QUEUE", async () => {
    const f = new FormData();
    f.set("itemIds", "a1,a2");
    f.set("serviceType", "REPAIR");
    await expect(flagItemsForServiceAction(f)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unknown service type rather than defaulting one", async () => {
    const f = new FormData();
    f.set("itemIds", "a1");
    f.set("serviceType", "DESTROY");
    const res = await flagItemsForServiceAction(f);
    expect(res).toHaveProperty("error");
  });
});
```

- [ ] **Step 8: Run the action tests**

Run: `npx vitest run admin/actions/queue`
Expected: PASS.

- [ ] **Step 9: Update `docs/SECURITY.md`**

Add `flagItemsForServiceAction` beside `setServiceAction`: gated on `MANAGE_QUEUE`, item ids client-supplied and bounded at 500, retired excluded server-side, service type validated by Zod enum so a crafted value is refused rather than defaulted. Bump *Last reviewed*.

- [ ] **Step 10: Commit**

```bash
git add src/modules/service-queue/service-queue.errors.ts \
        src/modules/service-queue/service-queue.service.ts \
        src/modules/service-queue/service-queue.bulk.test.ts \
        src/app/admin/actions/queue.ts src/app/admin/actions/queue.test.ts docs/SECURITY.md
git commit -m "feat(queue): flag many items for service in one pass"
```

---

### Task 4: Bulk complete service

**Files:**
- Modify: `src/modules/service-queue/service-queue.service.ts`
- Modify: `src/modules/service-queue/service-queue.bulk.test.ts`
- Modify: `src/app/admin/actions/queue.ts`
- Modify: `src/app/admin/actions/queue.test.ts`
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Consumes: `MAX_BULK_ITEMS`; `ServiceQueueError`.
- Produces: `completeServiceItems(itemIds: string[]): Promise<{ updated: number; skipped: number }>` and `completeServiceItemsAction(formData): Promise<BulkQueueResult>` (the `BulkQueueResult` type declared in Task 3).

- [ ] **Step 1: Write the failing test**

Append to `src/modules/service-queue/service-queue.bulk.test.ts`:

```ts
import { completeServiceItems } from "./service-queue.service";

describe("completeServiceItems", () => {
  it("completes the queue rows AND stamps markedReadyAt on the items", async () => {
    const items = await Promise.all([mkItem("BULKC1"), mkItem("BULKC2")]);
    for (const it of items) {
      await prisma.serviceQueueItem.create({
        data: { itemId: it.id, serviceType: "REPAIR", status: "PENDING" },
      });
    }

    const res = await completeServiceItems(items.map((i) => i.id));
    expect(res).toEqual({ updated: 2, skipped: 0 });

    const rows = await prisma.serviceQueueItem.findMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(rows.every((r) => r.status === "COMPLETED")).toBe(true);

    const fresh = await prisma.item.findMany({ where: { id: { in: items.map((i) => i.id) } } });
    expect(fresh.every((i) => i.markedReadyAt !== null)).toBe(true);
  });

  it("LEAVES dueAt and overdueAlertedAt on the finished row", async () => {
    const item = await mkItem("BULKC3");
    const due = new Date("2026-03-01T00:00:00.000Z");
    const alerted = new Date("2026-03-02T00:00:00.000Z");
    await prisma.serviceQueueItem.create({
      data: { itemId: item.id, serviceType: "REPAIR", status: "PENDING", dueAt: due, overdueAlertedAt: alerted },
    });

    await completeServiceItems([item.id]);

    const row = await prisma.serviceQueueItem.findUniqueOrThrow({ where: { itemId: item.id } });
    expect(row.dueAt?.getTime()).toBe(due.getTime());
    expect(row.overdueAlertedAt?.getTime()).toBe(alerted.getTime());
  });

  it("skips items with no PENDING row instead of erroring", async () => {
    const pending = await mkItem("BULKC4");
    const none = await mkItem("BULKC5");
    await prisma.serviceQueueItem.create({
      data: { itemId: pending.id, serviceType: "REPAIR", status: "PENDING" },
    });

    const res = await completeServiceItems([pending.id, none.id]);
    expect(res).toEqual({ updated: 1, skipped: 1 });
  });

  it("does not re-complete an already COMPLETED row", async () => {
    const item = await mkItem("BULKC6");
    await prisma.serviceQueueItem.create({
      data: { itemId: item.id, serviceType: "REPAIR", status: "COMPLETED" },
    });
    const res = await completeServiceItems([item.id]);
    expect(res).toEqual({ updated: 0, skipped: 1 });
    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.markedReadyAt).toBeNull();
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(completeServiceItems(ids)).rejects.toMatchObject({ code: "TOO_MANY" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run service-queue.bulk`
Expected: FAIL — `completeServiceItems is not a function`.

- [ ] **Step 3: Implement `completeServiceItems`**

Add to `src/modules/service-queue/service-queue.service.ts`, below `completeServiceItem`:

```ts
/**
 * Complete MANY items' service in one pass — the batched twin of
 * completeServiceItem, for a cart of finished devices.
 *
 * Three queries in one transaction. The findMany replaces the single-item
 * canComplete guard: a row that is not PENDING simply is not in the set, so a
 * completed row is SKIPPED rather than erroring the whole batch.
 *
 * Steps 2 and 3 stay in one transaction for the reason the single-item version
 * gives: a queue row that says COMPLETED while the item was never marked on
 * hand is the inconsistency worth preventing. Like that version it deliberately
 * LEAVES dueAt/overdueAlertedAt on the finished row — clearing them is the next
 * round's job (upsertServiceRequests / reopenServiceItem).
 *
 * The item update is scoped to ACTIVE: "back on hand" is meaningless for kit
 * that left the fleet, and readiness reports RETIRED regardless.
 *
 * Enforces NO permissions — the calling Server Action owns the guard.
 */
export async function completeServiceItems(
  itemIds: string[],
): Promise<{ updated: number; skipped: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ServiceQueueError("TOO_MANY");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const pending = await tx.serviceQueueItem.findMany({
      where: { itemId: { in: ids }, status: "PENDING" },
      select: { id: true, itemId: true },
    });
    if (pending.length === 0) return { updated: 0, skipped: ids.length };

    await tx.serviceQueueItem.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { status: "COMPLETED" },
    });
    await tx.item.updateMany({
      where: { id: { in: pending.map((p) => p.itemId) }, status: "ACTIVE" },
      data: { markedReadyAt: now },
    });

    return { updated: pending.length, skipped: ids.length - pending.length };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run service-queue.bulk`
Expected: PASS, 12 tests total in the file.

- [ ] **Step 5: Implement the action**

Add to `src/app/admin/actions/queue.ts`:

```ts
import { completeServiceItems } from "@/modules/service-queue/service-queue.service";

const bulkIdsSchema = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one item.")
    .max(MAX_BULK_ITEMS, `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.`),
});

/**
 * Complete service on every selected item — the /items selection-bar twin of
 * completeServiceAction. Takes ITEM ids, not queue-row ids: the selection knows
 * items, and the queue row is resolved server-side.
 */
export async function completeServiceItemsAction(formData: FormData): Promise<BulkQueueResult> {
  await requireCapability("MANAGE_QUEUE");

  const parsed = bulkIdsSchema.safeParse({ itemIds: bulkIds(formData) });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const { updated, skipped } = await completeServiceItems(parsed.data.itemIds);
    revalidatePath("/items");
    revalidatePath("/admin/queue");
    // Completing stamps markedReadyAt, which moves the fleet buckets.
    revalidatePath("/admin/analytics");
    return { ok: true, updated, skipped };
  } catch (e) {
    if (e instanceof ServiceQueueError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[completeServiceItemsAction] unexpected error:", e);
    return { error: "Something went wrong completing those items. Please try again." };
  }
}
```

- [ ] **Step 6: Add the capability-refusal test**

Append to `src/app/admin/actions/queue.test.ts`:

```ts
import { completeServiceItemsAction } from "./queue";

describe("completeServiceItemsAction", () => {
  it("refuses a caller without MANAGE_QUEUE", async () => {
    const f = new FormData();
    f.set("itemIds", "a1,a2");
    await expect(completeServiceItemsAction(f)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an empty selection", async () => {
    const f = new FormData();
    f.set("itemIds", "");
    const res = await completeServiceItemsAction(f);
    expect(res).toEqual({ error: "Select at least one item." });
  });
});
```

- [ ] **Step 7: Run the action tests**

Run: `npx vitest run admin/actions/queue`
Expected: PASS.

- [ ] **Step 8: Update `docs/SECURITY.md`**

Add `completeServiceItemsAction`: gated on `MANAGE_QUEUE`, takes item ids (queue rows resolved server-side), bounded at 500, non-pending rows skipped. Bump *Last reviewed*.

- [ ] **Step 9: Commit**

```bash
git add src/modules/service-queue/service-queue.service.ts \
        src/modules/service-queue/service-queue.bulk.test.ts \
        src/app/admin/actions/queue.ts src/app/admin/actions/queue.test.ts docs/SECURITY.md
git commit -m "feat(queue): complete service on many items at once"
```

---

### Task 5: The More-actions sheet

Three new controls, two needing their own inputs, cannot go inline: the selection bar is sticky, overlays the table, and stacked it covered a phone viewport entirely. They go behind one popover.

**Files:**
- Create: `src/components/BulkActionsMenu.tsx`
- Create: `src/components/BulkActionsMenu.test.tsx`
- Modify: `src/components/ItemSelectTable.tsx`
- Modify: `src/app/items/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `CHANGELOG.md`, `.claude/rules/backend-constraints.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `recordAuditsAction`, `flagItemsForServiceAction`, `completeServiceItemsAction`; `useItemSelection`; `SERVICE_TYPE_OPTIONS` from `@/modules/service-queue/service-form`.
- Produces: `<BulkActionsMenu itemIds={string[]} signatures={{id,name}[]} canAudit={boolean} canQueue={boolean} />`.

- [ ] **Step 1: Add the popover CSS, all four groups**

In `src/app/globals.css`, add `#items-bulkactions` to each of the four selector groups that currently list `#items-sortfilter, #queue-sortfilter` — the base block (~line 799), the `::backdrop` block (~line 816), and the two inside the anchored `@supports` block (~lines 909 and 924). There is no class to inherit from; missing one group gives a sheet that is wrong at exactly one breakpoint.

Update the comment above the base block to name three callers rather than two.

- [ ] **Step 2: Write the failing component test**

Create `src/components/BulkActionsMenu.test.tsx` (`// @vitest-environment jsdom` MUST be line 1):

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { BulkActionsMenu } from "./BulkActionsMenu";

vi.mock("@/app/admin/actions/audit", () => ({ recordAuditsAction: vi.fn() }));
vi.mock("@/app/admin/actions/queue", () => ({
  flagItemsForServiceAction: vi.fn(),
  completeServiceItemsAction: vi.fn(),
}));

const SIGS = [{ id: "s1", name: "SGT Smith" }];

test("the popover element carries NO class — a layout class would render it while closed", () => {
  const { container } = render(
    <BulkActionsMenu itemIds={["a1"]} signatures={SIGS} canAudit canQueue />,
  );
  const popover = container.querySelector("[popover]");
  expect(popover).not.toBeNull();
  expect(popover!.getAttribute("class")).toBeNull();
  // The layout lives on an inner wrapper instead.
  expect(popover!.querySelector(".popup-menu__panel")).not.toBeNull();
});

test("audit controls are absent without ADMINISTER", () => {
  render(<BulkActionsMenu itemIds={["a1"]} signatures={[]} canAudit={false} canQueue />);
  // jsdom applies the UA `display: none` to a closed popover, so query hidden.
  expect(screen.queryByLabelText(/sign as/i, { hidden: true })).toBeNull();
});

test("queue controls are absent without MANAGE_QUEUE", () => {
  render(<BulkActionsMenu itemIds={["a1"]} signatures={SIGS} canAudit canQueue={false} />);
  expect(screen.queryByLabelText(/service type/i, { hidden: true })).toBeNull();
});

test("the whole menu is absent when the caller can do neither", () => {
  const { container } = render(
    <BulkActionsMenu itemIds={["a1"]} signatures={[]} canAudit={false} canQueue={false} />,
  );
  expect(container.querySelector("[popover]")).toBeNull();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:ui -- BulkActionsMenu`
Expected: FAIL — cannot resolve `./BulkActionsMenu`.

- [ ] **Step 4: Write the component**

Create `src/components/BulkActionsMenu.tsx`. Mirror `SortFilterMenu.tsx` exactly for the popover mechanics.

**First, export the hook.** `useDismissSwallowsTap` is currently module-private at `src/components/SortFilterMenu.tsx:77` (`function useDismissSwallowsTap(...)`, no `export`). Add the `export` keyword — do NOT write a second copy. It is the only implementation of the light-dismiss click-through fix, and a duplicate would be the second copy of a rule that has already shipped broken once.

```tsx
"use client";
import { useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { recordAuditsAction } from "@/app/admin/actions/audit";
import { flagItemsForServiceAction, completeServiceItemsAction } from "@/app/admin/actions/queue";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";
import { useDismissSwallowsTap } from "./SortFilterMenu";

type Msg = { ok: boolean; text: string } | null;

const plural = (n: number) => (n === 1 ? "" : "s");

/** "Audited 47 · skipped 2 retired." — the skip count is never silent: four of
 *  these actions pass over retired rows, and an operator who scanned 49 devices
 *  must be told 2 did nothing. */
function outcome(verb: string, updated: number, skipped: number): string {
  const head = `${verb} ${updated} item${plural(updated)}.`;
  return skipped > 0 ? `${head} Skipped ${skipped} (retired or not applicable).` : head;
}

/**
 * The selection bar's overflow sheet: the three bulk actions that need their
 * own inputs and cannot fit inline.
 *
 * POPOVER RULES — all inherited from SortFilterMenu and all load-bearing:
 *  - The element carrying `popover` has NO className. An author `display` beats
 *    the UA's `[popover]:not(:popover-open) { display: none }`, and every closed
 *    sheet would then render and swallow the taps meant for the bar beneath it.
 *  - useDismissSwallowsTap spends the dismissing tap in the CAPTURE phase; light
 *    dismiss closes on pointerdown and still delivers the click to whatever sits
 *    underneath.
 *  - Styled by id (#items-bulkactions), listed in all four globals.css rule
 *    groups. There is deliberately no shared class to inherit from.
 */
export function BulkActionsMenu({
  itemIds,
  signatures,
  canAudit,
  canQueue,
}: {
  itemIds: string[];
  signatures: { id: string; name: string }[];
  canAudit: boolean;
  canQueue: boolean;
}) {
  const menuId = "items-bulkactions";
  const triggerId = "items-bulkactions-trigger";
  useDismissSwallowsTap(menuId, triggerId);

  const [signatureId, setSignatureId] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [note, setNote] = useState("");
  const [auditMsg, setAuditMsg] = useState<Msg>(null);
  const [queueMsg, setQueueMsg] = useState<Msg>(null);
  // Separate transitions: these are independent operations sharing a panel, and
  // one `pending` flag would point the busy state at the wrong control.
  const [auditPending, startAudit] = useTransition();
  const [flagPending, startFlag] = useTransition();
  const [completePending, startComplete] = useTransition();

  // Nothing this caller may do — render no trigger at all rather than an empty
  // sheet.
  if (!canAudit && !canQueue) return null;

  const none = itemIds.length === 0;
  const ids = itemIds.join(",");

  const run = (
    start: (fn: () => void) => void,
    setMsg: (m: Msg) => void,
    fd: FormData,
    call: (fd: FormData) => Promise<{ error: string } | { ok: true; updated: number; skipped: number }>,
    verb: string,
  ) => {
    setMsg(null);
    start(async () => {
      const res = await call(fd);
      if ("error" in res) return setMsg({ ok: false, text: res.error });
      setMsg({ ok: true, text: outcome(verb, res.updated, res.skipped) });
      // Selection is deliberately KEPT — clearing it unmounts the bar holding
      // this message, and a 150-item batch cost real physical effort.
    });
  };

  const applyAudit = () => {
    const fd = new FormData();
    fd.set("itemIds", ids);
    fd.set("signatureId", signatureId);
    run(startAudit, setAuditMsg, fd, recordAuditsAction, "Audited");
  };

  const applyFlag = () => {
    const fd = new FormData();
    fd.set("itemIds", ids);
    fd.set("serviceType", serviceType);
    fd.set("note", note);
    run(startFlag, setQueueMsg, fd, flagItemsForServiceAction, "Flagged");
  };

  const applyComplete = () => {
    const fd = new FormData();
    fd.set("itemIds", ids);
    run(startComplete, setQueueMsg, fd, completeServiceItemsAction, "Completed service on");
  };

  return (
    <>
      <button
        type="button"
        id={triggerId}
        className="btn btn-secondary menu-trigger"
        popoverTarget={menuId}
        disabled={none}
      >
        <span className="menu-trigger__label">More actions</span>
        <ChevronDown className="menu-trigger__chevron" aria-hidden="true" />
      </button>

      {/* NO className on this element. See the trap note above. */}
      <div id={menuId} popover="auto">
        <div className="popup-menu__panel stack-sm">
          {canAudit && (
            <div className="stack" style={{ gap: 4 }}>
              <label className="label" htmlFor="bulk-sig">Record audit — sign as</label>
              <select
                id="bulk-sig"
                className="select"
                value={signatureId}
                disabled={auditPending || none || signatures.length === 0}
                onChange={(e) => setSignatureId(e.target.value)}
              >
                <option value="">Choose…</option>
                {signatures.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={auditPending || none || !signatureId}
                onClick={applyAudit}
              >
                {auditPending ? "Recording…" : `Audit ${itemIds.length} item${plural(itemIds.length)}`}
              </button>
              {signatures.length === 0 && (
                <span className="subtle">No saved signatures — add one under Account.</span>
              )}
              {auditMsg && (
                <span role="status" className={auditMsg.ok ? "subtle" : "alert-error"}>{auditMsg.text}</span>
              )}
            </div>
          )}

          {canQueue && (
            <div className="stack" style={{ gap: 4 }}>
              <label className="label" htmlFor="bulk-service">Flag for service — type</label>
              <select
                id="bulk-service"
                className="select"
                value={serviceType}
                disabled={flagPending || none}
                onChange={(e) => setServiceType(e.target.value)}
              >
                <option value="">Choose…</option>
                {SERVICE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                className="input"
                placeholder={serviceType === "OTHER" ? "What needs doing? (required)" : "Note (optional)"}
                value={note}
                disabled={flagPending || none}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={flagPending || none || !serviceType}
                onClick={applyFlag}
              >
                {flagPending ? "Flagging…" : "Flag for service"}
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                disabled={completePending || none}
                onClick={applyComplete}
                title="Mark service finished and record these devices as back on hand"
              >
                {completePending ? "Completing…" : "Complete service"}
              </button>
              {queueMsg && (
                <span role="status" className={queueMsg.ok ? "subtle" : "alert-error"}>{queueMsg.text}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Run the component test**

Run: `npm run test:ui -- BulkActionsMenu`
Expected: PASS, 4 tests.

- [ ] **Step 6: Wire it into the selection bar**

In `src/components/ItemSelectTable.tsx`, inside the `isAdmin` row of the sticky bar (beside `<MarkReadyButton>` and `<ReadinessControls>`), add:

```tsx
<BulkActionsMenu
  itemIds={[...selected.keys()]}
  signatures={signatures}
  canAudit={canAudit}
  canQueue={canQueue}
/>
```

Add the three new props to the component's signature (`signatures: { id: string; name: string }[]`, `canAudit: boolean`, `canQueue: boolean`).

Then render the batch age and the cap notice next to the count. Both `startedAt` and `atCap` come from `useItemSelection()` — the table already destructures `selected` from it, so extend that call rather than adding a second:

```tsx
<span>
  {selected.size} selected · {groupCount} row{groupCount === 1 ? "" : "s"}
  {startedAt > 0 && (
    <span className="subtle">
      {" "}· started {new Date(startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
    </span>
  )}
  {/* A hard stop, not a warning: addMany refuses past this point, so a scan
      that appears to do nothing must say why. Without this the camera beeps
      "already scanned" for a device that was never added. */}
  {atCap && (
    <span role="status" className="alert-error">
      {" "}· limit reached ({MAX_BULK_ITEMS}) — apply an action or clear some before scanning more
    </span>
  )}
</span>
```

Import the constant from the pure module, never from `items.service.ts`:

```tsx
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
```

- [ ] **Step 7: Pass the data from the page**

In `src/app/items/page.tsx`, add the import:

```tsx
import { listSignatureNames } from "@/modules/signatures/signatures.service";
```

then, alongside the existing capability reads (the page already resolves `user` and reads `user.capabilities` for `canCreate`):

```tsx
const canAudit = user.capabilities.includes("ADMINISTER");
const canQueue = user.capabilities.includes("MANAGE_QUEUE");
// Names only — no signature image blob reaches the browser. recordAuditsAction
// re-reads the image server-side scoped to the acting admin, so the id posted
// back is not trusted for anything but lookup.
const signatures = canAudit ? await listSignatureNames(user.id) : [];
```

and pass `signatures`, `canAudit`, `canQueue` to `<ItemSelectTable>`.

Note this adds **one** query to the page, and only for an admin. `listSignatureNames` selects `{ id, name }` — never the image.

- [ ] **Step 8: Run the full UI suite**

Run: `npm run test:ui`
Expected: PASS, including the unchanged `ItemSelectTable.test.tsx` invariants.

- [ ] **Step 9: Update the docs**

`CHANGELOG.md`, under today's `### Added`:

```markdown
- Bulk actions for a selected or scanned batch: record an audit for every item under one signature, flag them all for service, or complete service on them all at once. Retired devices are passed over and reported rather than failing the batch.
```

`.claude/rules/backend-constraints.md`, under Service & Ticket Lifecycles and Operational Readiness:
- `upsertServiceRequests` / `completeServiceItems` are the batched twins, and they preserve both invariants the single-item paths carry: the COMPLETED wipe stays ahead of the update (new round resets), and completing stamps `markedReadyAt` in the same transaction while leaving `dueAt`/`overdueAlertedAt` on the finished row.
- The cross-cutting rule: **bulk actions exclude retired items and REPORT them; they never refuse the batch.** Note this diverges from `markAuditedAction` on purpose, and that "fixing" either to match the other is wrong in both directions.
- `recordAudits` writes N audit rows against ONE deduplicated `SignatureAsset`, and must set `createdAt` explicitly because the column defaults to `now()`.

`CLAUDE.md`, one line under Operational Readiness noting bulk audit exists and pointing at the rule file.

- [ ] **Step 10: Commit**

```bash
git add src/components/BulkActionsMenu.tsx src/components/BulkActionsMenu.test.tsx \
        src/components/ItemSelectTable.tsx src/app/items/page.tsx src/app/globals.css \
        CHANGELOG.md .claude/rules/backend-constraints.md CLAUDE.md
git commit -m "feat(items): bulk audit, service flag and service completion from the selection bar"
```

---

### Task 6: Full verification

Nothing above proves the CSS or the popover behaviour — jsdom has no layout engine and no Popover API, and no CI job has either.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS. If unrelated files fail, check no other session is running tests — a concurrent run truncates the shared test database and masquerades as flakiness.

CI runs the suite too, as of `39f1a9b` (#112): the third job, **`Tests (vitest)`**, stands up a real Postgres and runs `npm test`. Running it locally first is still worth it — a red push burns a CI cycle to tell you what a local run says in seconds — but it is now a gate rather than an honour system.

- [ ] **Step 2: Lint and build**

Run: `npm run lint && npm run build`
Expected: both clean.

- [ ] **Step 3: Verify in a real browser at 1280px**

Start `npm run dev`, sign in as an admin, go to `/items`.
- Select several items. Confirm the bar shows the count and "started HH:MM".
- Open **More actions**. Confirm the panel is anchored under the trigger, not centred in the viewport.
- Record an audit; confirm the message names the count, and the Audit column updates after the refresh.
- Flag for service, then check `/admin/queue`. Complete service, then confirm the items read **Ready to deploy**.
- Press Escape; confirm the panel closes and focus returns to the trigger.

- [ ] **Step 4: Verify at 390px — the checks jsdom cannot make**

Same page in a 390×844 viewport with touch emulation.
- Open the sheet. It must be a **bottom sheet**, full width, not an anchored dropdown.
- With the sheet open, tap outside it onto a button in the bar beneath. The sheet must close and **that button must NOT fire** — this is `useDismissSwallowsTap`, and it has no unit coverage at all.
- Confirm the panel scrolls internally rather than growing off the top of the screen.
- Confirm the closed sheet intercepts nothing: tap each bar control with the sheet shut and confirm all respond.

- [ ] **Step 5: Verify persistence on a real device**

Through the cloudflared tunnel on an iPhone (the camera needs a secure context):
- Scan several devices into a batch.
- Lock the phone, wait, unlock. The batch must still be there with its original start time.
- Reload the page. Same.
- Confirm the batch stops accepting at 500.

- [ ] **Step 6: Commit any fixes found**

```bash
git add -A
git commit -m "fix(items): <what the browser pass turned up>"
```

If the browser pass finds nothing, skip this step. A 500 that outlives a CSS fix means `rm -rf .next` — Turbopack caches a CSS syntax error across a dev-server restart.
