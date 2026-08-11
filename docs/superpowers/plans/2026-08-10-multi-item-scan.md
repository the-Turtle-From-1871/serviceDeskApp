# Multi-item scan on `/items` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/items`' Scan button collect a batch of items into the existing selection instead of navigating away on the first hit, and let an unknown serial be created without leaving the sheet.

**Architecture:** A new client context (`ItemSelection`) owns the selection Map so the scan sheet and the table — sibling Client Components under a Server Component page — can both reach it. `ItemsScanButton` becomes a session that accumulates entries; `QrScanner` gains a `children` slot and stays ignorant of items. Unknown serials are created through `scannedItemSchema`, an `.extend()` of `newItemSchema` with `deviceName` relaxed.

**Tech Stack:** Next.js 16 App Router (Server Components + Server Actions), React 19, TypeScript, Zod, Prisma 7, Vitest (+ jsdom for component tests), `globals.css` legacy design system.

**Spec:** `docs/superpowers/specs/2026-08-10-multi-item-scan-design.md`

## Global Constraints

- **No database in tests.** Decided 2026-08-10: no test-DB work in this plan. Gate logic tests inject `getSession` into `requireCapability`; service tests mock Prisma. Accepted gap: no live round-trip against the `citext` unique constraint.
- **Never point the test suite at production.** `resetDb()` truncates tables.
- **No migration in this feature.** `scannedItemSchema` is Zod-only; `SelectedItem` is a type. Do not add one.
- **Styling:** new UI here is the legacy `globals.css` system (`.card`/`.stack`/`.btn`), NOT Tailwind. See `.claude/rules/ui-styling.md`.
- **`npm run build` and jsdom are not evidence for CSS.** Neither has a layout engine. Task 8 is the real-browser gate.
- **Capability, never role.** The create path gates on `MANAGE_ITEMS` via `requireCapability`.
- **No query inside a loop.** The batch create is two queries for N rows.
- **Touch targets ≥ 44px** (`--tap`).
- **Commit style:** conventional commits; end the message with
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Run tests with:** `npx vitest run <filename-pattern>` (a *filename* filter). Component tests need `// @vitest-environment jsdom` on line 1.

---

### Task 1: `ItemSelection` provider and the `SelectedItem` type

**Files:**
- Create: `src/components/ItemSelection.tsx`
- Modify: `src/components/items-view.ts` (add the `SelectedItem` type)
- Test: `src/components/ItemSelection.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SelectedItem = { id: string; make: string; model: string; serialNumber: string; status: "ACTIVE" | "RETIRED" }` — **declared in `items-view.ts`, not in the provider.** `items-view.ts` is a pure module with no `"use client"`, and this type is imported by the Prisma-backed service in Task 6; a server module reaching into a client component file for a type works (types are erased) but is the wrong direction, and it puts a `"use client"` file on the service's import graph where a future non-type import would silently break the bundle.
  - `<ItemSelectionProvider>{children}</ItemSelectionProvider>`
  - `useItemSelection(): { selected: ReadonlyMap<string, SelectedItem>; toggle(item: SelectedItem): void; addMany(items: SelectedItem[]): void; removeMany(ids: string[]): void; clear(): void }`

- [ ] **Step 1: Write the failing test**

Create `src/components/ItemSelection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ItemSelectionProvider, useItemSelection, type SelectedItem } from "./ItemSelection";

afterEach(cleanup);

const item = (id: string, status: SelectedItem["status"] = "ACTIVE"): SelectedItem => ({
  id, make: "HP", model: "ProBook", serialNumber: `SN${id}`, status,
});

function Probe() {
  const { selected, toggle, addMany, removeMany, clear } = useItemSelection();
  return (
    <div>
      <span data-testid="ids">{[...selected.keys()].join(",")}</span>
      <button onClick={() => toggle(item("a"))}>toggle-a</button>
      <button onClick={() => addMany([item("b"), item("c")])}>add-bc</button>
      <button onClick={() => addMany([item("r", "RETIRED")])}>add-retired</button>
      <button onClick={() => removeMany(["b"])}>remove-b</button>
      <button onClick={clear}>clear</button>
    </div>
  );
}

const ids = () => screen.getByTestId("ids").textContent;

describe("ItemSelection", () => {
  it("toggles one item on and off", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("toggle-a"));
    expect(ids()).toBe("a");
    await user.click(screen.getByText("toggle-a"));
    expect(ids()).toBe("");
  });

  it("addMany is additive and idempotent", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("toggle-a"));
    await user.click(screen.getByText("add-bc"));
    await user.click(screen.getByText("add-bc"));
    expect(ids()).toBe("a,b,c");
  });

  // Retired rows render no checkbox and are excluded from every bulk action
  // (selectableIds). A scanned batch must not smuggle one in.
  it("addMany refuses a RETIRED item", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("add-retired"));
    expect(ids()).toBe("");
  });

  it("removeMany and clear", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("add-bc"));
    await user.click(screen.getByText("remove-b"));
    expect(ids()).toBe("c");
    await user.click(screen.getByText("clear"));
    expect(ids()).toBe("");
  });

  it("throws when used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/ItemSelectionProvider/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run ItemSelection`
Expected: FAIL — cannot resolve `./ItemSelection`.

- [ ] **Step 3: Implement the provider**

Create `src/components/ItemSelection.tsx`:

First add the type to `src/components/items-view.ts`, beside `ItemRow`:

```ts
/**
 * What a SELECTION actually consumes — deliberately NOT the full ItemRow.
 *
 * ItemRow carries fifteen fields (readiness, auditState, holderName, deviceUIC,
 * MDM telemetry) derived by two extra page-level queries in order to RENDER A
 * TABLE ROW. A scanned item is not rendered as a table row and is usually not
 * even on the current page, so producing a full ItemRow per scan would mean
 * running those queries to populate fields nobody displays. ItemRow is a
 * superset of this, so every existing caller still typechecks.
 *
 * Declared HERE rather than in the provider because the items service imports
 * it, and this module carries no "use client".
 */
export type SelectedItem = {
  id: string;
  make: string;
  model: string;
  serialNumber: string;
  status: "ACTIVE" | "RETIRED";
};
```

Then create `src/components/ItemSelection.tsx`:

```tsx
"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { SelectedItem } from "./items-view";

export type { SelectedItem };

type ItemSelectionValue = {
  /** id -> item. A Map, not a Set of ids, so it survives paging: the
   *  receipt-group validation needs each selected item's make/model, and an
   *  item selected on page 1 is gone from `items` once you page forward. */
  selected: ReadonlyMap<string, SelectedItem>;
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
 */
export function ItemSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());

  const toggle = useCallback((item: SelectedItem) => {
    setSelected((prev) => {
      const n = new Map(prev);
      if (n.has(item.id)) n.delete(item.id);
      else n.set(item.id, item);
      return n;
    });
  }, []);

  // RETIRED is refused HERE as well as by callers: retired rows render no
  // checkbox and selectableIds excludes them, so a bulk action must never
  // receive one. `toggle` stays permissive on purpose — it is the checkbox's
  // own handler, and a strict toggle could not un-select a row that somehow
  // got in.
  const addMany = useCallback((items: SelectedItem[]) => {
    setSelected((prev) => {
      const n = new Map(prev);
      for (const it of items) if (it.status === "ACTIVE") n.set(it.id, it);
      return n;
    });
  }, []);

  const removeMany = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const n = new Map(prev);
      for (const id of ids) n.delete(id);
      return n;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Map()), []);

  const value = useMemo(
    () => ({ selected, toggle, addMany, removeMany, clear }),
    [selected, toggle, addMany, removeMany, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useItemSelection(): ItemSelectionValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useItemSelection must be used inside <ItemSelectionProvider>");
  return ctx;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ItemSelection`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ItemSelection.tsx src/components/ItemSelection.test.tsx src/components/items-view.ts
git commit -m "feat(items): a selection provider the scan sheet can reach"
```

---

### Task 2: Move `ItemSelectTable` onto the provider (no behaviour change)

**Files:**
- Modify: `src/components/ItemSelectTable.tsx:91-113` (state + `toggle` + `toggleAll`), and the three `setSelected(new Map())` call sites at lines ~673, ~698, ~705
- Modify: `src/app/items/page.tsx:82-129` (wrap in the provider)
- Test: `src/components/ItemSelectTable.test.tsx` (add the wrapper)

**Interfaces:**
- Consumes: `ItemSelectionProvider`, `useItemSelection`, `SelectedItem` from Task 1.
- Produces: no new exports. `ItemSelectTable`'s props are unchanged.

This task must change **no observable behaviour**. Its whole point is that the existing `ItemSelectTable.test.tsx` passes unchanged apart from the provider wrapper.

- [ ] **Step 1: Make the existing tests render inside the provider**

In `src/components/ItemSelectTable.test.tsx`, add the import and wrap every `render(<ItemSelectTable ... />)`. Add near the top:

```tsx
import { ItemSelectionProvider } from "./ItemSelection";

const renderTable = (ui: React.ReactElement) =>
  render(<ItemSelectionProvider>{ui}</ItemSelectionProvider>);
```

Then replace each `render(<ItemSelectTable` call with `renderTable(<ItemSelectTable`. Do not change any assertion.

- [ ] **Step 2: Run them — they should still PASS**

Run: `npx vitest run ItemSelectTable`
Expected: **PASS.** The component still owns its own state, so an extra provider around it changes nothing. This step exists to prove the wrapper itself broke nothing before you touch the component — it is the baseline, not a red test. This task is a pure refactor, so there is no failing test to write: the existing suite IS the specification, and it must stay green at every step.

- [ ] **Step 3: Replace the local state with the context**

In `src/components/ItemSelectTable.tsx`, add to the imports:

```tsx
import { useItemSelection } from "./ItemSelection";
```

Replace lines 87-113 (the comment block through `toggleAll`) with:

```tsx
  // Selection lives in ItemSelectionProvider, not here: the /items Scan sheet
  // is a SIBLING client component and has to commit into the same selection.
  // It is a Map (id -> item), not a Set of ids, so it survives paging — the
  // receipt-group validation below needs each selected item's make/model, and
  // an item selected on page 1 is no longer in `items` once you page forward.
  const { selected, toggle, addMany, removeMany, clear } = useItemSelection();
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);

  const allState = useMemo(() => selectAllState(items, selectedIds), [items, selectedIds]);
  const selectableCount = useMemo(() => selectableIds(items).length, [items]);
  // "Select all" acts on the CURRENT page's selectable rows, leaving off-page
  // selections untouched.
  const toggleAll = () => {
    const pageActive = items.filter((it) => it.status === "ACTIVE");
    const allOnPage = pageActive.length > 0 && pageActive.every((it) => selected.has(it.id));
    if (allOnPage) removeMany(pageActive.map((it) => it.id));
    else addMany(pageActive);
  };
```

Then replace all three occurrences of `setSelected(new Map())` with `clear()`.

Finally, remove `useState` from the React import **only if** nothing else in the file uses it — check first with `npx vitest run ItemSelectTable` and the typecheck in Step 5.

- [ ] **Step 4: Wrap the page**

In `src/app/items/page.tsx`, add the import:

```tsx
import { ItemSelectionProvider } from "@/components/ItemSelection";
```

Wrap the search row and the table together — the provider must contain BOTH, or they get separate selections:

```tsx
        <ItemSelectionProvider>
          {/* The scan button sits with the search box because it does the same
              job by other means: both narrow the list to one device. */}
          <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <ItemsSearchInput q={q ?? ""} sortKeys={result.sortKeys} uic={result.uic} />
            <ItemsScanButton />
          </div>

          <ItemSelectTable
            /* ...every existing prop unchanged... */
          />
        </ItemSelectionProvider>
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run ItemSelectTable ItemSelection`
Expected: PASS, with no assertion changed.

Run: `npx tsc --noEmit`
Expected: no new errors in `ItemSelectTable.tsx`, `ItemSelection.tsx` or `page.tsx`. (Pre-existing errors elsewhere in the repo are not yours.)

- [ ] **Step 6: Commit**

```bash
git add src/components/ItemSelectTable.tsx src/components/ItemSelectTable.test.tsx src/app/items/page.tsx
git commit -m "refactor(items): read the selection from the provider"
```

---

### Task 3: Parse make/model off the label (pure)

**Files:**
- Modify: `src/modules/items/scan-code.ts`
- Test: `src/modules/items/scan-code.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ScanIntent`'s serial variant gains `label?: { make: string; model: string }`.

- [ ] **Step 1: Write the failing test**

Add to the `parseScan` describe block in `src/modules/items/scan-code.test.ts`:

```ts
  // HP's comma list carries a description in its second field, and the stored
  // row for this serial is make "HP" / model "HP ProBook 650 G5" — so the model
  // is the WHOLE field and the make is its first token.
  it("offers make and model from the label as a create hint", () => {
    expect(parseScan("2TK94709FN, HP ProBook 650 G5, ProdID 5PF3AB#ABA")).toEqual({
      kind: "serial",
      serial: "2TK94709FN",
      label: { make: "HP", model: "HP ProBook 650 G5" },
    });
  });

  // A hint is only ever a prefill. Nothing else may depend on it, so the shapes
  // that carry no description must not invent one.
  it("offers no hint for a bare serial or a keyed field string", () => {
    expect(parseScan("5CD1234ABC")).toEqual({ kind: "serial", serial: "5CD1234ABC" });
    expect(parseScan("SN:2TK44202X4;PN:1AB23AV")).toEqual({ kind: "serial", serial: "2TK44202X4" });
  });

  it("offers no hint when the description field is not a description", () => {
    // Second field is itself a serial, so there is no device description here.
    expect(parseScan("2TK94709FN, 5CD1234ABC")).toEqual({ kind: "serial", serial: "2TK94709FN" });
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run scan-code`
Expected: FAIL — received object has no `label` key.

- [ ] **Step 3: Implement**

In `src/modules/items/scan-code.ts`, widen the type:

```ts
export type ScanIntent =
  | { kind: "item"; id: string }
  | {
      kind: "serial";
      serial: string;
      altSerial?: string;
      /** Make/model read off the label, for PREFILLING a create form only.
       *  Never used to look anything up. */
      label?: { make: string; model: string };
    };
```

Change `serialFromList` to return the matched field's index as well, and add the hint reader. Replace the existing `serialFromList` with:

```ts
function serialFieldFromList(raw: string): { serial: string; fields: string[]; at: number } | null {
  const fields = raw.split(/\s*,\s*/);
  if (fields.length < 2) return null;
  const at = fields.findIndex((field) => SERIAL_SHAPE.test(field));
  return at === -1 ? null : { serial: fields[at], fields, at };
}

/**
 * The device description HP prints beside the serial —
 * `2TK94709FN, HP ProBook 650 G5, ProdID …`. The stored row for that serial is
 * make "HP", model "HP ProBook 650 G5", so the MODEL is the whole field and the
 * MAKE is its first token; that is how this data is actually shaped.
 *
 * The field immediately after the serial, and only if it is NOT itself
 * serial-shaped — a list of two serials describes nothing.
 */
function labelHint(fields: string[], at: number): { make: string; model: string } | undefined {
  const desc = fields[at + 1]?.trim();
  if (!desc || SERIAL_SHAPE.test(desc)) return undefined;
  const make = desc.split(/\s+/)[0];
  return make ? { make, model: desc } : undefined;
}
```

Then rewrite the tail of `parseScan`:

```ts
  // A bare serial stays the fast path and is unchanged, so a label that already
  // scans keeps scanning exactly as it did. Otherwise the payload is a list of
  // fields: a KEYED serial is stronger evidence than a positional one, so it is
  // tried first, and only then the "first field that is a serial" rule.
  let serial = SERIAL_SHAPE.test(raw) ? raw : serialFromFields(raw);
  let label: { make: string; model: string } | undefined;
  if (!serial) {
    const list = serialFieldFromList(raw);
    if (list) {
      serial = list.serial;
      label = labelHint(list.fields, list.at);
    }
  }
  if (!serial) return null;

  const altSerial = expressServiceCodeToServiceTag(serial);
  return {
    kind: "serial",
    serial,
    ...(altSerial ? { altSerial } : {}),
    ...(label ? { label } : {}),
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scan-code scan-url`
Expected: PASS — including every existing case (Dell PPID and WIFI still rejected, express code still converted).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/scan-code.ts src/modules/items/scan-code.test.ts
git commit -m "feat(scan): read make/model off the label as a create hint"
```

---

### Task 4: Server actions return the selectable item

**Files:**
- Modify: `src/app/actions/scan.ts`
- Modify: `src/modules/items/items.service.ts` (widen `getItemBySerialForScan`'s `select`)
- Test: `src/app/actions/scan.test.ts`

**Interfaces:**
- Consumes: `SelectedItem` (Task 1).
- Produces:
  - `resolveScannedSerial(serial: string, altSerial?: string): Promise<ScanResolution>`
  - `resolveScannedItemId(itemId: string): Promise<ScanResolution>`
  - `type ScanResolution = { ok: true; item: SelectedItem } | { ok: false; code: "NOT_FOUND" | "UNAUTHORIZED" | "FAILED" }`

Note the **shape change**: `resolveScannedSerial` returned `{ ok: true; itemId }` and now returns `{ ok: true; item }`. Its only caller is `ItemsScanButton` (Task 5). The receipt builder's `lookupScannedItem`/`lookupScannedSerial` are **not** touched.

- [ ] **Step 1: Write the failing tests**

In `src/app/actions/scan.test.ts`, replace the `resolveScannedSerial` describe block's success assertions and add the new action. Follow the file's existing mocking idiom:

```ts
describe("resolveScannedSerial", () => {
  it("returns the whole selectable item, not just an id", async () => {
    getItemBySerialForScan.mockResolvedValue({
      id: "i1", make: "HP", model: "HP ProBook 650 G5", serialNumber: "2TK94709FN", status: "ACTIVE",
    });
    expect(await resolveScannedSerial("2TK94709FN")).toEqual({
      ok: true,
      item: { id: "i1", make: "HP", model: "HP ProBook 650 G5", serialNumber: "2TK94709FN", status: "ACTIVE" },
    });
  });

  // Deliberately UNLIKE lookupScannedSerial: /items is a lookup surface, and a
  // retired device on a shelf is exactly what someone scans to ask why.
  it("returns a RETIRED item rather than refusing it", async () => {
    getItemBySerialForScan.mockResolvedValue({
      id: "i2", make: "Dell", model: "Latitude", serialNumber: "7X2K9L3", status: "RETIRED",
    });
    const res = await resolveScannedSerial("7X2K9L3");
    expect(res).toEqual({
      ok: true,
      item: { id: "i2", make: "Dell", model: "Latitude", serialNumber: "7X2K9L3", status: "RETIRED" },
    });
  });
});

describe("resolveScannedItemId", () => {
  it("resolves our own sticker to the same shape", async () => {
    getItemForScan.mockResolvedValue({
      id: "i1", make: "HP", model: "G5", serialNumber: "SN1", status: "ACTIVE",
    });
    expect(await resolveScannedItemId("i1")).toEqual({
      ok: true,
      item: { id: "i1", make: "HP", model: "G5", serialNumber: "SN1", status: "ACTIVE" },
    });
  });

  it("is NOT_FOUND for an unknown id", async () => {
    getItemForScan.mockResolvedValue(null);
    expect(await resolveScannedItemId("nope")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("is UNAUTHORIZED when the session is gone", async () => {
    requireUser.mockRejectedValue(new AuthError("UNAUTHENTICATED"));
    expect(await resolveScannedItemId("i1")).toEqual({ ok: false, code: "UNAUTHORIZED" });
  });
});
```

Mirror the existing file's mock declarations for `getItemForScan` (a new service export) alongside the existing `getItemBySerialForScan`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/app/actions/scan.test.ts`
Expected: FAIL — `resolveScannedItemId` is not exported; `resolveScannedSerial` returns `itemId`.

- [ ] **Step 3: Widen the service selects**

In `src/modules/items/items.service.ts`, ensure `getItemBySerialForScan` selects exactly `{ id, make, model, serialNumber, status }`, and add its id-keyed twin next to it:

```ts
/** The columns a scan needs, by id. Mirrors getItemBySerialForScan — identity
 *  for display, status so the caller can flag a retired device without a second
 *  query. Deliberately NOT the whole row: the result crosses to a client
 *  component, and `notes` is admin-only. */
export function getItemForScan(id: string) {
  return prisma.item.findUnique({
    where: { id },
    select: { id: true, make: true, model: true, serialNumber: true, status: true },
  });
}
```

- [ ] **Step 4: Rewrite the actions**

In `src/app/actions/scan.ts`, add the type and replace `resolveScannedSerial`, keeping the existing `findBySerial` helper and the `SerialResolution` removal:

```ts
import type { SelectedItem } from "@/components/ItemSelection";

export type ScanResolution =
  | { ok: true; item: SelectedItem }
  | { ok: false; code: "NOT_FOUND" | "UNAUTHORIZED" | "FAILED" };

/**
 * Resolve a scanned serial for the /items scan sheet.
 *
 * Deliberately does NOT apply the ACTIVE filter lookupScannedSerial does: that
 * rule exists because the builder is about to put the item on a signed
 * document. This surface collects, and a retired device is exactly the kind of
 * thing someone scans to ask "why is this on the shelf". The caller flags it.
 */
export async function resolveScannedSerial(serial: string, altSerial?: string): Promise<ScanResolution> {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, code: "UNAUTHORIZED" };
    console.error("[resolveScannedSerial] auth check failed:", e);
    return { ok: false, code: "FAILED" };
  }

  const sn = serial.trim();
  if (!sn) return { ok: false, code: "NOT_FOUND" };

  try {
    const item = await findBySerial(sn, altSerial);
    return item ? { ok: true, item } : { ok: false, code: "NOT_FOUND" };
  } catch (e) {
    console.error("[resolveScannedSerial] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}

/** The same, for our own QR sticker, which names an item id directly. */
export async function resolveScannedItemId(itemId: string): Promise<ScanResolution> {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, code: "UNAUTHORIZED" };
    console.error("[resolveScannedItemId] auth check failed:", e);
    return { ok: false, code: "FAILED" };
  }

  const id = itemId.trim();
  if (!id) return { ok: false, code: "NOT_FOUND" };

  try {
    const item = await getItemForScan(id);
    return item ? { ok: true, item } : { ok: false, code: "NOT_FOUND" };
  } catch (e) {
    console.error("[resolveScannedItemId] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}
```

Add `getItemForScan` to the import from `@/modules/items/items.service`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/actions/scan.test.ts`
Expected: PASS. The `lookupScannedItem` / `lookupScannedSerial` tests in the same file must be untouched and still green.

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/scan.ts src/app/actions/scan.test.ts src/modules/items/items.service.ts
git commit -m "feat(scan): resolve a scan to a selectable item, retired included"
```

---

### Task 5: The scan session and its list

**Files:**
- Modify: `src/components/QrScanner.tsx` (add `children`)
- Create: `src/app/items/scan-session.ts` (the `ScannedEntry` type)
- Modify: `src/app/items/ItemsScanButton.tsx` (rewrite as a session)
- Modify: `src/app/items/page.tsx` (pass `canCreate`)
- Modify: `src/app/globals.css` (list styles, beside the existing `.scan-sheet` block)
- Test: `src/app/items/ItemsScanButton.test.tsx`

**Interfaces:**
- Consumes: `parseScans`, `describeScan`, `ScanIntent.label` (Task 3); `resolveScannedSerial`, `resolveScannedItemId`, `ScanResolution` (Task 4); `useItemSelection` (Task 1).
- Produces:
  - `ItemsScanButton` takes `{ canCreate: boolean }`.
  - `src/app/items/scan-session.ts`:
    ```ts
    import type { SelectedItem } from "@/components/items-view";

    /** One row of a scan session. Its own module, not ItemsScanButton's, because
     *  ScannedCreateForm (Task 7) needs it and ItemsScanButton renders that form
     *  — declaring it in either would be an import cycle. */
    export type ScannedEntry =
      | { key: string; kind: "found" | "retired"; item: SelectedItem }
      | { key: string; kind: "new"; serial: string; label?: { make: string; model: string } };

    export type NewEntry = Extract<ScannedEntry, { kind: "new" }>;
    ```

- [ ] **Step 1: Write the failing tests**

Rewrite `src/app/items/ItemsScanButton.test.tsx`. Keep the existing mock idiom (a button per fixture emitting a decoded frame), wrap in the provider, and mock both actions:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ItemSelectionProvider, useItemSelection } from "@/components/ItemSelection";

const resolveScannedSerial = vi.fn();
const resolveScannedItemId = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  resolveScannedSerial: (sn: string, alt?: string) => resolveScannedSerial(sn, alt),
  resolveScannedItemId: (id: string) => resolveScannedItemId(id),
}));
vi.mock("@/lib/beep", () => ({ beep: vi.fn() }));

vi.mock("@/components/QrScanner", () => ({
  SCAN_FORMATS: ["qr_code"],
  QrScanner: ({ onDecode, onClose, notice, children }: {
    onDecode: (t: string[]) => void; onClose: () => void;
    notice?: { kind: "ok" | "err"; text: string } | null; children?: React.ReactNode;
  }) => (
    <div data-testid="scanner">
      <button onClick={() => onDecode(["2TK94709FN, HP ProBook 650 G5, ProdID 5PF3"])}>emit-hp</button>
      <button onClick={() => onDecode(["7X2K9L3"])}>emit-dell</button>
      <button onClick={() => onDecode(["NOSUCH123"])}>emit-unknown</button>
      <button onClick={onClose}>emit-close</button>
      {notice && <p data-testid="scan-notice">{notice.text}</p>}
      {children}
    </div>
  ),
}));

import { ItemsScanButton } from "./ItemsScanButton";

const HP = { id: "i1", make: "HP", model: "HP ProBook 650 G5", serialNumber: "2TK94709FN", status: "ACTIVE" as const };
const DELL_RETIRED = { id: "i2", make: "Dell", model: "Latitude", serialNumber: "7X2K9L3", status: "RETIRED" as const };

function Selection() {
  const { selected } = useItemSelection();
  return <span data-testid="sel">{[...selected.keys()].join(",")}</span>;
}

const setup = (canCreate = true) =>
  render(<ItemSelectionProvider><ItemsScanButton canCreate={canCreate} /><Selection /></ItemSelectionProvider>);

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^Scan$/i }));
  await screen.findByTestId("scanner");
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  resolveScannedSerial.mockImplementation(async (sn: string) =>
    sn === "2TK94709FN" ? { ok: true, item: HP }
    : sn === "7X2K9L3" ? { ok: true, item: DELL_RETIRED }
    : { ok: false, code: "NOT_FOUND" });
});

describe("ItemsScanButton", () => {
  it("accumulates instead of navigating, and lists what it collected", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    expect(await screen.findByText(/2TK94709FN/)).toBeDefined();
    expect(screen.getByTestId("scanner")).toBeDefined(); // still open
  });

  it("does not add the same item twice", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    await waitFor(() => expect(resolveScannedSerial).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    expect(screen.getAllByText(/2TK94709FN/)).toHaveLength(1);
  });

  it("commits found items to the selection on Done", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    await screen.findByText(/2TK94709FN/);
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    await waitFor(() => expect(screen.getByTestId("sel").textContent).toBe("i1"));
  });

  it("lists a retired item but keeps it out of the selection", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-dell" }));
    expect(await screen.findByText(/Retired/i)).toBeDefined();
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    await waitFor(() => expect(screen.getByTestId("sel").textContent).toBe(""));
  });

  it("flags a serial that is in no item", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    expect(await screen.findByText(/Not in the book/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run ItemsScanButton`
Expected: FAIL — `ItemsScanButton` takes no `canCreate`, and nothing renders a list.

- [ ] **Step 3: Add the `children` slot to `QrScanner`**

In `src/components/QrScanner.tsx`, add to `Props`:

```tsx
  /** Rendered between the video and the Done button. The sheet stays ignorant
   *  of items and schema — the caller passes whatever it has collected, exactly
   *  as it already does for `notice`. */
  children?: ReactNode;
```

Add `type ReactNode` to the React import, accept `children` in the signature, and render it directly above the `<div className="row">` that holds the Done button:

```tsx
      {children}
      <div className="row">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
      </div>
```

- [ ] **Step 4: Rewrite `ItemsScanButton` as a session**

Replace the body of `src/app/items/ItemsScanButton.tsx`:

```tsx
"use client";
import { useRef, useState } from "react";
import { QrScanner, SCAN_FORMATS } from "@/components/QrScanner";
import { parseScans, describeScan } from "@/modules/items/scan-code";
import { resolveScannedSerial, resolveScannedItemId } from "@/app/actions/scan";
import { useItemSelection } from "@/components/ItemSelection";
import type { ScannedEntry } from "./scan-session";
import { beep } from "@/lib/beep";

/**
 * Scan a batch of codes into the /items selection.
 *
 * Every scan APPENDS; nothing navigates. The continuous-scanning rules are the
 * ones ReceiptBuilderForm already proved: one lookup in flight at a time, and a
 * dedupe window so a code still under the camera is not read twice.
 */
export function ItemsScanButton({ canCreate }: { canCreate: boolean }) {
  const { addMany } = useItemSelection();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<ScannedEntry[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const looking = useRef(false);
  // Keys already in the list, so a code still in frame is not re-added. A ref,
  // not derived from `scanned`, because onDecode fires again before React has
  // re-rendered with the previous entry.
  const seen = useRef(new Set<string>());

  const say = (kind: "ok" | "err", text: string) => { setNotice({ kind, text }); beep(kind); };

  const push = (entry: ScannedEntry) => {
    if (seen.current.has(entry.key)) return false;
    seen.current.add(entry.key);
    setScanned((prev) => [...prev, entry]);
    return true;
  };

  const onDecode = async (texts: string[]) => {
    const intent = parseScans(texts);
    if (!intent) return say("err", `Not an item code — read ${describeScan(texts)}`);
    if (looking.current) return; // a lookup is already in flight; drop this frame

    // Cheap pre-check so a code still under the camera costs no round trip.
    const preKey = intent.kind === "item" ? `id:${intent.id}` : `sn:${intent.serial.toLowerCase()}`;
    if (seen.current.has(preKey)) return;

    looking.current = true;
    try {
      const res = intent.kind === "item"
        ? await resolveScannedItemId(intent.id)
        : await resolveScannedSerial(intent.serial, intent.altSerial);

      if (res.ok) {
        const kind = res.item.status === "ACTIVE" ? "found" : "retired";
        seen.current.add(preKey);
        if (push({ key: `id:${res.item.id}`, kind, item: res.item })) {
          say(kind === "found" ? "ok" : "err",
            kind === "found"
              ? `Added ${res.item.make} ${res.item.model}`
              : `${res.item.serialNumber} is retired — not added to the selection`);
        }
        return;
      }

      if (res.code === "NOT_FOUND") {
        if (intent.kind === "item") return say("err", "That item no longer exists");
        if (push({ key: preKey, kind: "new", serial: intent.serial, label: intent.label })) {
          say("err", `${intent.serial} is not in the book`);
        }
        return;
      }

      say("err", res.code === "UNAUTHORIZED"
        ? "Your session expired — sign in again"
        : "Couldn't look up that code — try again");
    } finally {
      looking.current = false;
    }
  };

  // Done commits the ACTIVE items and closes. It ADDS to whatever is already
  // selected rather than replacing it, so a scanned batch can extend a
  // selection made by tapping. Clearing stays the selection bar's own job.
  const finish = () => {
    addMany(scanned.filter((e) => e.kind === "found").map((e) => e.item));
    setScanning(false);
  };

  const start = () => {
    setScanned([]);
    seen.current = new Set();
    setNotice(null);
    setScanning(true);
  };

  if (!scanning) return <button type="button" className="btn btn-secondary" onClick={start}>Scan</button>;

  const foundCount = scanned.filter((e) => e.kind === "found").length;

  return (
    <QrScanner formats={SCAN_FORMATS} onDecode={onDecode} onClose={finish} notice={notice}>
      <div className="scan-list">
        {scanned.length === 0 ? (
          <p className="scan-list__empty subtle">Scanned items appear here.</p>
        ) : (
          <ul className="scan-list__items">
            {scanned.map((e) => (
              <li key={e.key} className="scan-list__row">
                {e.kind === "new" ? (
                  <>
                    <strong>{e.serial}</strong>
                    <span className="scan-list__flag">Not in the book</span>
                  </>
                ) : (
                  <>
                    <strong>{e.item.serialNumber}</strong>
                    <span className="scan-list__meta">{e.item.make} {e.item.model}</span>
                    {e.kind === "retired" && <span className="scan-list__flag">Retired</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="scan-list__count subtle">
          {foundCount} item{foundCount === 1 ? "" : "s"} will be selected
        </p>
      </div>
    </QrScanner>
  );
}
```

Note: the `Done` label with a count comes from `QrScanner`; leave its button text as `Done` for now — Task 7 replaces the footer.

- [ ] **Step 5: Pass `canCreate` from the page**

In `src/app/items/page.tsx`, replace `<ItemsScanButton />` with:

```tsx
            <ItemsScanButton canCreate={user.capabilities.includes("MANAGE_ITEMS")} />
```

`user` is already in scope from `requireUser()`. Gate on the CAPABILITY, not `isAdmin`: a `USER` granted `MANAGE_ITEMS` individually must get this, and a `VIEWER` must not.

- [ ] **Step 6: Add the list styles**

In `src/app/globals.css`, directly after the existing `.scan-sheet` rules, add:

```css
/* The collected-items list, under the video in the scan sheet. Capped and
   scrollable: a long session must scroll inside itself rather than growing off
   the top of the screen. svh (not vh) because the iOS URL bar resizes vh, and
   the safe-area pad because the app installs to the home screen with no
   browser chrome beneath it. */
.scan-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 30svh;
  overflow-y: auto;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.scan-list__items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.scan-list__row { display: flex; align-items: baseline; gap: 8px; min-height: var(--tap); padding: 4px 0; }
.scan-list__meta { color: var(--text-muted); font-size: 0.9rem; }
.scan-list__flag { margin-left: auto; color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
.scan-list__empty, .scan-list__count { margin: 0; }
```

`--muted` is a SURFACE tint — muted text is `--text-muted`. Do not use `var(--muted)` for any colour above.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run ItemsScanButton ItemSelection ItemSelectTable`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/QrScanner.tsx src/app/items/ItemsScanButton.tsx src/app/items/ItemsScanButton.test.tsx src/app/items/page.tsx src/app/globals.css
git commit -m "feat(items): scan a batch into the selection instead of navigating"
```

---

### Task 6: `scannedItemSchema` and the batched create

**Files:**
- Modify: `src/modules/items/items.schema.ts`
- Modify: `src/modules/items/items.service.ts`
- Create: `src/app/admin/actions/scanned-items.ts`
- Test: `src/modules/items/items.schema.test.ts`, `src/modules/items/items.service.scanned.test.ts`, `src/app/admin/actions/scanned-items.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `scannedItemSchema` (Zod) and `type ScannedItemInput`
  - `createScannedItems(rows: ScannedItemInput[], createdById: string): Promise<{ items: SelectedItem[]; created: number; existed: number }>`
  - `createScannedItemsAction(rows: ScannedItemInput[]): Promise<{ ok: true; items: SelectedItem[]; created: number; existed: number } | { error: string }>`

- [ ] **Step 1: Write the failing schema test**

Add to `src/modules/items/items.schema.test.ts`:

```ts
import { newItemSchema, scannedItemSchema } from "./items.schema";

describe("scannedItemSchema", () => {
  const base = { make: "HP", model: "HP ProBook 650 G5", serialNumber: "2TK94709FN" };

  it("accepts a scanned item with no device name", () => {
    expect(scannedItemSchema.parse(base)).toMatchObject(base);
  });

  it("still requires make, model and serial", () => {
    expect(scannedItemSchema.safeParse({ ...base, make: "" }).success).toBe(false);
    expect(scannedItemSchema.safeParse({ ...base, serialNumber: "" }).success).toBe(false);
  });

  // The ONLY difference from newItemSchema. Derived with .extend(), never
  // restated — a restated field list is exactly the drift CLAUDE.md warns of.
  it("differs from newItemSchema in deviceName alone", () => {
    expect(newItemSchema.safeParse(base).success).toBe(false);          // needs deviceName
    expect(newItemSchema.safeParse({ ...base, deviceName: "X" }).success).toBe(true);
    expect(Object.keys(scannedItemSchema.shape).sort())
      .toEqual(Object.keys(newItemSchema.shape).sort());
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run items.schema`
Expected: FAIL — `scannedItemSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `src/modules/items/items.schema.ts`, directly beneath `newItemSchema`:

```ts
/**
 * Creating an item from a SCAN. Identical to newItemSchema except that
 * `deviceName` is optional: a device scanned off a shelf may have no known
 * hostname, and requiring one blocks the create at the moment it is most
 * useful.
 *
 * Built with .extend() and NEVER restated — a second field list is a second
 * answer to "what is an item", and the two would drift. Same pattern as
 * registerSchema (newUserSchema minus role).
 *
 * KNOWN CONSEQUENCE: detectHomeUnit reads the device name, so items created
 * this way carry NO home unit until someone edits them or an import fills it
 * in. The create form says so.
 */
export const scannedItemSchema = newItemSchema.extend({ deviceName: optional });

export type ScannedItemInput = z.infer<typeof scannedItemSchema>;
```

If `optional` is declared after `newItemSchema` in the file, move this block below its declaration — a const cannot be used before it is declared.

- [ ] **Step 4: Run the schema test**

Run: `npx vitest run items.schema`
Expected: PASS.

- [ ] **Step 5: Write the failing service test (mocked Prisma — no database)**

Create `src/modules/items/items.service.scanned.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMany = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({ default: { item: { createMany: (a: unknown) => createMany(a), findMany: (a: unknown) => findMany(a) } } }));

import { createScannedItems } from "./items.service";

beforeEach(() => {
  vi.clearAllMocks();
  createMany.mockResolvedValue({ count: 2 });
  findMany.mockResolvedValue([
    { id: "i1", make: "HP", model: "G5", serialNumber: "AAA1", status: "ACTIVE" },
    { id: "i2", make: "HP", model: "G5", serialNumber: "BBB2", status: "ACTIVE" },
  ]);
});

const rows = [
  { make: "HP", model: "G5", serialNumber: "AAA1" },
  { make: "HP", model: "G5", serialNumber: "BBB2" },
];

describe("createScannedItems", () => {
  // The non-negotiable property: never one create per row.
  it("writes with TWO queries regardless of row count", async () => {
    await createScannedItems(rows, "admin1");
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("leans on the unique constraint rather than pre-checking", async () => {
    await createScannedItems(rows, "admin1");
    expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
  });

  it("reports what was created versus what already existed", async () => {
    createMany.mockResolvedValue({ count: 1 });
    const res = await createScannedItems(rows, "admin1");
    expect(res).toMatchObject({ created: 1, existed: 1 });
    expect(res.items).toHaveLength(2);
  });

  it("is a no-op for an empty batch", async () => {
    const res = await createScannedItems([], "admin1");
    expect(res).toEqual({ items: [], created: 0, existed: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `npx vitest run items.service.scanned`
Expected: FAIL — `createScannedItems` is not exported.

- [ ] **Step 7: Implement the service**

In `src/modules/items/items.service.ts`:

```ts
/**
 * Create items from a scan session, in TWO queries for N rows.
 *
 * createMany + skipDuplicates leans on the citext-unique serial constraint as
 * the race-safe backstop — exactly as the CSV importer does — so a serial
 * created elsewhere between the scan and this call is absorbed rather than
 * throwing. The follow-up findMany recovers ids for everything in the batch,
 * created or pre-existing, because a pre-existing one was still physically
 * scanned and belongs in the caller's selection.
 *
 * Enforces NO permissions — the calling Server Action owns the capability gate.
 */
export async function createScannedItems(
  rows: ScannedItemInput[],
  createdById: string,
): Promise<{ items: SelectedItem[]; created: number; existed: number }> {
  if (rows.length === 0) return { items: [], created: 0, existed: 0 };
  if (rows.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const res = await prisma.item.createMany({
    data: rows.map((r) => ({ ...r, createdById })),
    skipDuplicates: true,
  });

  const items = await prisma.item.findMany({
    where: { serialNumber: { in: rows.map((r) => r.serialNumber) } },
    select: { id: true, make: true, model: true, serialNumber: true, status: true },
  });

  return { items, created: res.count, existed: items.length - res.count };
}
```

Add `import type { ScannedItemInput } from "./items.schema";` and `import type { SelectedItem } from "@/components/items-view";`. **Both must be `import type`** — `items.service.ts` carries `import "server-only"`, and a value import from a component module would pull client code onto the server graph.

- [ ] **Step 8: Run the service test**

Run: `npx vitest run items.service.scanned`
Expected: PASS (4 tests).

- [ ] **Step 9: Write the failing action test (injected session — no database)**

Create `src/app/admin/actions/scanned-items.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireCapability = vi.fn();
vi.mock("@/lib/authz", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
  return { ...actual, requireCapability: (c: string) => requireCapability(c) };
});
const createScannedItems = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ createScannedItems: (r: unknown, id: string) => createScannedItems(r, id) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { AuthError } from "@/lib/authz";
import { createScannedItemsAction } from "./scanned-items";

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue({ id: "admin1", name: "A", role: "ADMIN" });
  createScannedItems.mockResolvedValue({ items: [{ id: "i1", make: "HP", model: "G5", serialNumber: "AAA1", status: "ACTIVE" }], created: 1, existed: 0 });
});

const rows = [{ make: "HP", model: "G5", serialNumber: "AAA1" }];

describe("createScannedItemsAction", () => {
  it("gates on MANAGE_ITEMS, not on a role", async () => {
    await createScannedItemsAction(rows);
    expect(requireCapability).toHaveBeenCalledWith("MANAGE_ITEMS");
  });

  it("refuses a caller without the capability", async () => {
    requireCapability.mockRejectedValue(new AuthError("FORBIDDEN"));
    expect(await createScannedItemsAction(rows)).toEqual({ error: "You do not have permission to create items." });
    expect(createScannedItems).not.toHaveBeenCalled();
  });

  it("rejects a row that fails validation, without writing anything", async () => {
    expect(await createScannedItemsAction([{ make: "", model: "G5", serialNumber: "AAA1" }])).toMatchObject({ error: expect.any(String) });
    expect(createScannedItems).not.toHaveBeenCalled();
  });

  it("returns the created items for the caller's selection", async () => {
    expect(await createScannedItemsAction(rows)).toMatchObject({ ok: true, created: 1, existed: 0 });
  });
});
```

- [ ] **Step 10: Run and confirm failure**

Run: `npx vitest run scanned-items`
Expected: FAIL — module does not exist.

- [ ] **Step 11: Implement the action**

Create `src/app/admin/actions/scanned-items.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireCapability, AuthError } from "@/lib/authz";
import { createScannedItems, MAX_BULK_ITEMS } from "@/modules/items/items.service";
import { scannedItemSchema, type ScannedItemInput } from "@/modules/items/items.schema";
import type { SelectedItem } from "@/components/items-view";
import { z } from "zod";

// The same cap the other bulk actions use — imported, never restated, so the
// action and the service can never disagree about what "too many" means.
const batchSchema = z.array(scannedItemSchema).min(1).max(MAX_BULK_ITEMS);

export type CreateScannedResult =
  | { ok: true; items: SelectedItem[]; created: number; existed: number }
  | { error: string };

/**
 * Create the unknown serials from one scan session.
 *
 * MANAGE_ITEMS, not ADMINISTER: this is item vocabulary, and a USER granted
 * MANAGE_ITEMS individually is entitled to it. The whole batch is validated
 * before anything is written, so a bad row cannot leave a half-created batch.
 */
export async function createScannedItemsAction(rows: ScannedItemInput[]): Promise<CreateScannedResult> {
  let user;
  try {
    user = await requireCapability("MANAGE_ITEMS");
  } catch (e) {
    if (e instanceof AuthError) return { error: "You do not have permission to create items." };
    console.error("[createScannedItemsAction] auth check failed:", e);
    return { error: "Something went wrong. Please try again." };
  }

  const parsed = batchSchema.safeParse(rows);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const res = await createScannedItems(parsed.data, user.id);
    revalidatePath("/items");
    revalidatePath("/admin/analytics");
    return { ok: true, ...res };
  } catch (e) {
    console.error("[createScannedItemsAction] unexpected error:", e);
    return { error: "Something went wrong creating those items. Please try again." };
  }
}
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `npx vitest run scanned-items items.service.scanned items.schema`
Expected: PASS.

- [ ] **Step 13: Document the schema rule**

In `.claude/rules/backend-constraints.md`, under the item-schema material, add:

```markdown
* **`scannedItemSchema` is `newItemSchema.extend({ deviceName: optional })` — derived, never restated.** Creating an item from a scan relaxes exactly one field, because a device scanned off a shelf may have no known hostname and requiring one blocks the create where it is most useful. `.extend()` means a field added to `newItemSchema` flows through automatically; a restated field list would be a second answer to "what is an item". `items.schema.test.ts` pins that `deviceName` is the only difference. **Known consequence:** `detectHomeUnit` reads the device name, so scan-created items carry no home unit until an edit or an import supplies one.
```

In `CLAUDE.md`, add one line to the item-schema bullet list:

```markdown
- **`scannedItemSchema` = `newItemSchema` with `deviceName` optional**, built with `.extend()` so the two cannot drift. Scan-created items carry no home unit — see `.claude/rules/backend-constraints.md`.
```

- [ ] **Step 14: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/items/items.schema.test.ts src/modules/items/items.service.ts src/modules/items/items.service.scanned.test.ts src/app/admin/actions/scanned-items.ts src/app/admin/actions/scanned-items.test.ts .claude/rules/backend-constraints.md CLAUDE.md
git commit -m "feat(items): create scanned serials in one batched write"
```

---

### Task 7: The create form, and the sheet's footer

**Files:**
- Modify: `src/app/items/ItemsScanButton.tsx`
- Create: `src/app/items/ScannedCreateForm.tsx`
- Modify: `src/app/globals.css`
- Modify: `CHANGELOG.md`
- Test: `src/app/items/ScannedCreateForm.test.tsx`, `src/app/items/ItemsScanButton.test.tsx`

**Interfaces:**
- Consumes: `ScannedEntry` (Task 5), `createScannedItemsAction`, `ScannedItemInput` (Task 6), `useItemSelection` (Task 1).
- Produces: `<ScannedCreateForm entries={...} onCancel={...} onCreated={(items: SelectedItem[]) => void} />`

- [ ] **Step 1: Write the failing form test**

Create `src/app/items/ScannedCreateForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createScannedItemsAction = vi.fn();
vi.mock("@/app/admin/actions/scanned-items", () => ({
  createScannedItemsAction: (rows: unknown) => createScannedItemsAction(rows),
}));

import { ScannedCreateForm } from "./ScannedCreateForm";

const entries = [
  { key: "sn:aaa1", kind: "new" as const, serial: "AAA1", label: { make: "HP", model: "HP ProBook 650 G5" } },
  { key: "sn:bbb2", kind: "new" as const, serial: "BBB2" },
];

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  createScannedItemsAction.mockResolvedValue({ ok: true, items: [], created: 2, existed: 0 });
});

describe("ScannedCreateForm", () => {
  it("prefills make and model from the label, and leaves the rest blank", () => {
    render(<ScannedCreateForm entries={entries} onCancel={() => {}} onCreated={() => {}} />);
    expect((screen.getByLabelText(/Make for AAA1/i) as HTMLInputElement).value).toBe("HP");
    expect((screen.getByLabelText(/Model for AAA1/i) as HTMLInputElement).value).toBe("HP ProBook 650 G5");
    expect((screen.getByLabelText(/Make for BBB2/i) as HTMLInputElement).value).toBe("");
  });

  it("sends one row per serial, serial taken from the label not the form", async () => {
    const user = userEvent.setup();
    render(<ScannedCreateForm entries={entries} onCancel={() => {}} onCreated={() => {}} />);
    await user.type(screen.getByLabelText(/Make for BBB2/i), "Dell");
    await user.type(screen.getByLabelText(/Model for BBB2/i), "Latitude");
    await user.click(screen.getByRole("button", { name: /^Create 2/ }));
    await waitFor(() => expect(createScannedItemsAction).toHaveBeenCalledWith([
      { serialNumber: "AAA1", make: "HP", model: "HP ProBook 650 G5" },
      { serialNumber: "BBB2", make: "Dell", model: "Latitude" },
    ]));
  });

  it("refuses to submit while a required field is empty", async () => {
    const user = userEvent.setup();
    render(<ScannedCreateForm entries={entries} onCancel={() => {}} onCreated={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^Create 2/ }));
    expect(createScannedItemsAction).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("surfaces a server error without losing what was typed", async () => {
    createScannedItemsAction.mockResolvedValue({ error: "You do not have permission to create items." });
    const user = userEvent.setup();
    render(<ScannedCreateForm entries={[entries[0]]} onCancel={() => {}} onCreated={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^Create 1/ }));
    expect(await screen.findByText(/do not have permission/i)).toBeDefined();
    expect((screen.getByLabelText(/Make for AAA1/i) as HTMLInputElement).value).toBe("HP");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run ScannedCreateForm`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the form**

Create `src/app/items/ScannedCreateForm.tsx`:

```tsx
"use client";
import { useState } from "react";
import { createScannedItemsAction } from "@/app/admin/actions/scanned-items";
import type { SelectedItem } from "@/components/items-view";
import type { NewEntry } from "./scan-session";

type Draft = { make: string; model: string };

/**
 * Create the serials a scan session found no item for.
 *
 * The serial is FIXED — it came off the label, and letting it be edited here
 * would quietly decouple what was scanned from what is written. Make and model
 * are prefilled from the label where the QR carried a description.
 */
export function ScannedCreateForm({
  entries, onCancel, onCreated,
}: {
  entries: NewEntry[];
  onCancel: () => void;
  onCreated: (items: SelectedItem[], created: number, existed: number) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(entries.map((e) => [e.serial, { make: e.label?.make ?? "", model: e.label?.model ?? "" }])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (serial: string, field: keyof Draft, value: string) =>
    setDrafts((d) => ({ ...d, [serial]: { ...d[serial], [field]: value } }));

  const submit = async () => {
    const rows = entries.map((e) => ({
      serialNumber: e.serial,
      make: drafts[e.serial].make.trim(),
      model: drafts[e.serial].model.trim(),
    }));
    const missing = rows.find((r) => !r.make || !r.model);
    if (missing) return setError(`${missing.serialNumber} needs a make and a model.`);

    setError(null);
    setBusy(true);
    const res = await createScannedItemsAction(rows);
    setBusy(false);
    if ("error" in res) return setError(res.error);
    onCreated(res.items, res.created, res.existed);
  };

  return (
    <div className="scan-create stack-sm">
      <p className="subtle">
        {entries.length} scanned serial{entries.length === 1 ? "" : "s"} {entries.length === 1 ? "is" : "are"} not
        in the book. These are created without a device name, so they will have no home unit until one is
        added.
      </p>
      {entries.map((e) => (
        <div key={e.serial} className="scan-create__row">
          <strong>{e.serial}</strong>
          <label className="sr-only" htmlFor={`make-${e.serial}`}>Make for {e.serial}</label>
          <input
            id={`make-${e.serial}`} className="input" placeholder="Make"
            value={drafts[e.serial].make} onChange={(ev) => set(e.serial, "make", ev.target.value)}
          />
          <label className="sr-only" htmlFor={`model-${e.serial}`}>Model for {e.serial}</label>
          <input
            id={`model-${e.serial}`} className="input" placeholder="Model"
            value={drafts[e.serial].model} onChange={(ev) => set(e.serial, "model", ev.target.value)}
          />
        </div>
      ))}
      {error && <p role="alert" className="alert-error">{error}</p>}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? "Creating…" : `Create ${entries.length}`}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Skip the rest</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the form test**

Run: `npx vitest run ScannedCreateForm`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the form into the sheet**

In `src/app/items/ItemsScanButton.tsx`, add a phase and render the form after Done:

```tsx
  const [phase, setPhase] = useState<"scanning" | "creating">("scanning");
```

Change `start()` to also `setPhase("scanning")`. Replace `finish()` with:

```tsx
  const commitFound = () => addMany(scanned.filter((e) => e.kind === "found").map((e) => e.item));

  const unknowns = scanned.filter((e): e is NewEntry => e.kind === "new");

  // Done commits the ACTIVE items and closes — unless there are unknown serials
  // and the operator may create them, in which case the sheet becomes the
  // create form. It ADDS to whatever is already selected rather than replacing.
  const finish = () => {
    commitFound();
    if (canCreate && unknowns.length > 0) return setPhase("creating");
    setScanning(false);
  };
```

And render the create phase before the scanner return:

```tsx
  if (phase === "creating") {
    return (
      <ScannedCreateForm
        entries={unknowns}
        onCancel={() => setScanning(false)}
        onCreated={(items) => { addMany(items); setScanning(false); }}
      />
    );
  }
```

Change the Done button's label by passing it through — in `QrScanner`, accept an optional `doneLabel?: string` defaulting to `"Done"`, and pass `doneLabel={`Done · ${foundCount} item${foundCount === 1 ? "" : "s"}`}`.

- [ ] **Step 6: Add the create-form tests to the button's suite**

Append to `src/app/items/ItemsScanButton.test.tsx`:

```tsx
  it("offers the create form on Done when a serial was unknown", async () => {
    const user = userEvent.setup();
    setup(true);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    await screen.findByText(/Not in the book/i);
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    expect(await screen.findByRole("button", { name: /^Create 1/ })).toBeDefined();
  });

  it("shows no create path without MANAGE_ITEMS", async () => {
    const user = userEvent.setup();
    setup(false);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    await screen.findByText(/Not in the book/i);
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    expect(screen.queryByRole("button", { name: /^Create/ })).toBeNull();
  });
```

- [ ] **Step 7: Add the form's styles**

In `src/app/globals.css`, after the `.scan-list` block:

```css
.scan-create { padding: 12px; }
.scan-create__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.scan-create__row .input { flex: 1 1 8rem; min-height: var(--tap); }
```

- [ ] **Step 8: Run the full component set**

Run: `npx vitest run ItemsScanButton ScannedCreateForm ItemSelection ItemSelectTable`
Expected: PASS.

- [ ] **Step 9: Write the changelog entry**

Add to `CHANGELOG.md` under a `## 2026-08-10` → `### Added` section (newest section at the top; create the date section if it is not there):

```markdown
- **Scanning now collects items instead of jumping to one.** The Scan button on the items list used to open the first device it read and close the camera. It now keeps the camera open and lists everything you scan at the bottom of the screen, so you can work down a shelf with the kit in your hands. Tap **Done** and everything you scanned comes back **selected** in the list — ready for Create receipt, Print QR codes, Mark as on hand or Set category, exactly as if you had ticked each row.

  A **retired** device is listed and clearly marked but is not selected, matching the list itself, where retired rows can never be part of a bulk action.

  A serial that **is not in the book** is flagged as you scan it rather than ending the session. On Done, anyone who can manage items gets one form to create them all at once, with make and model already filled in from the label where the code carries them. These are created without a device name, so **they have no home unit until one is added** — the form says so.

  Looking up a single device now takes one extra tap: scan it, tap Done, tap the row. That is the trade for having one behaviour instead of a mode to get wrong.
```

- [ ] **Step 10: Commit**

```bash
git add src/app/items/ItemsScanButton.tsx src/app/items/ItemsScanButton.test.tsx src/app/items/ScannedCreateForm.tsx src/app/items/ScannedCreateForm.test.tsx src/components/QrScanner.tsx src/app/globals.css CHANGELOG.md
git commit -m "feat(items): create unknown scanned serials from the sheet"
```

---

### Task 8: Verify in a real browser, then ship

**Files:** none — this is a gate, not a change. Any fix it produces belongs in the task that owns the file.

Neither jsdom nor `next build` has a layout engine, so nothing so far is evidence that this **looks** right. This is the only step that can tell you.

- [ ] **Step 1: Full local verification**

```bash
npx vitest run scan-code scan-url ItemsScanButton ScannedCreateForm ItemSelection ItemSelectTable scanned-items items.service.scanned items.schema src/app/actions/scan.test.ts
npm run lint
npx tsc --noEmit
npm run build
```

Expected: tests PASS; lint 0 errors; no new `tsc` errors in files this plan touched; build clean.

- [ ] **Step 2: Drive it at 390px**

Start the dev server (`npm run dev`) and open `/items` in a real browser at a 390×844 viewport, signed in as an admin. Check:

1. The scan sheet opens and the list region appears **below** the video, above Done.
2. Scanning several codes fills the list; the list scrolls **inside itself** and never pushes Done off screen — add 15 entries and confirm.
3. Every row's tap target is ≥44px; the list does not scroll the page horizontally.
4. `Done · N items` reads correctly, and the count matches the found (non-retired) rows.
5. Tapping Done returns to `/items` with the selection bar showing `N selected`.
6. The bottom nav rail stays **under** the sheet (`z-index` 40 vs 50).
7. Text colours are legible — `--text-muted`, never `--muted`.

- [ ] **Step 3: If a 500 outlives a CSS fix**

`rm -rf .next` — Turbopack caches a CSS syntax error across a dev-server restart.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin worktree-multi-item-scan
gh pr create --base main --title "feat(items): multi-item scanning on /items" --body "<summary + the browser checks performed>"
```

State plainly in the PR body: the tests that ran, the browser checks performed at 390px, and the two accepted gaps — **no live database round-trip against the `citext` unique constraint**, and **scan-created items carry no home unit**.

- [ ] **Step 5: Merge after both required checks pass**

`Semgrep SAST` and `Build (next build)`. No migration in this feature, so migrate-before-push does not apply.

---

## Self-Review

**Spec coverage** — every section maps to a task: provider §1 → T1/T2; `SelectedItem` §2 → T1; scan session §3 → T5; server actions §4 → T4; create flow §5 → T6/T7; label hints §6 → T3; list UI §7 → T5/T7; error handling → T5 (notice paths) and T7 (form errors); testing → each task's own steps plus T8; docs → T6 (rules + CLAUDE.md) and T7 (CHANGELOG).

**Type consistency** — `SelectedItem` is declared once, in `items-view.ts` (T1), and imported by T4, T6 and T7; `ItemSelection.tsx` re-exports it so client code has one obvious import. `ScannedEntry`/`NewEntry` live in `scan-session.ts` (T5) and are consumed by T7. `ScanResolution` replaces `SerialResolution` in T4, whose only caller is rewritten in T5. `scannedItemSchema`/`ScannedItemInput` are defined in T6 and used by T6's action and T7's form.

**Fixed during review** — five issues, all corrected above:
1. T2's "run and confirm failure" step was self-contradictory; a pure refactor has no red test, and the step now says so explicitly.
2. `SelectedItem` was declared in a `"use client"` file and imported by the `server-only` items service. Moved to `items-view.ts`, which carries no directive.
3. `ScannedEntry` in `ItemsScanButton.tsx` + `ScannedCreateForm` importing it, while `ItemsScanButton` renders that form, is an import cycle. Both now read it from `scan-session.ts`.
4. The batch cap was hardcoded `500` in the action while the service reads `MAX_BULK_ITEMS`. Now imported.
5. A dead `{canCreate ? "" : ""}` ternary in the list footer.

**Known ordering constraint** — T5 changes `ItemsScanButton`'s props, so T2's page edit and T5's page edit touch the same lines in `page.tsx`. Do them in order.

**Accepted gaps, to be repeated in the PR body** — no live database round-trip against the `citext` unique constraint (no test DB, by decision); scan-created items carry no home unit; a single-item lookup costs one extra tap.
