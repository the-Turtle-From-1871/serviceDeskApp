# Item Creation Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every item-editing surface mobile-working suggestion dropdowns, add an admin-only permanent delete that leaves signed receipts intact, and let an admin jump straight to the item they just created.

**Architecture:** One new client component (`SuggestCombobox`) replaces every `<datalist>` on an item field, fed by vocabularies resolved server-side per page. Delete becomes possible by widening `TransferItem.itemId` to nullable with `ON DELETE SET NULL` — receipts render snapshot columns and never join `Item`, so detaching the row preserves the whole DA 2062. The creation confirmation screen gains an "open this item" link and absorbs the from-search redirect.

**Tech Stack:** Next.js 16 (App Router, Server Components, Server Actions), React 19, TypeScript 5, Prisma 7 over `@prisma/adapter-pg`, PostgreSQL 16, Vitest (real-DB integration + jsdom component tests), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-04-item-creation-improvements-design.md`

## Global Constraints

- **Never query inside a loop.** Batch with `findMany`/`groupBy`; a fixed number of queries, never one per row.
- **`z.object()` strips unknown keys.** A field a form renders but the schema does not declare saves nothing while reporting "Saved". Read extra form values off `formData`, not off `parsed.data`.
- **Every Server Action starts with `requireUser()` or `requireAdmin()`** from `@/lib/authz` — never bare `auth()`.
- **Errors:** catch in the action, log the stack server-side, return a generic message to the client.
- **Suggestions never constrain input.** Every field stays free text; a value absent from the list must remain submittable. The CSV importer can introduce values the property book has never seen.
- **Touch targets:** interactive elements have a `var(--tap)` (44px) minimum on coarse pointers.
- **Styling:** `/items`, `/i/<id>` and `/admin/items/*` are on the original `globals.css` system. Use its classes (`.card`, `.input`, `.btn`, `.field`, `.label`, `.subtle`, `.sr-only`). Do **not** introduce Tailwind or shadcn primitives on these pages.
- **`npm run build` and jsdom are NOT evidence for a CSS or layout change.** Verify in a real browser.
- **Do not run the test suite in parallel with another agent** — all agents share one `handreceipt_test` database and will truncate each other's fixtures.
- **Docs ship in the same commit as the code** that changes behavior (CHANGELOG under `## 2026-08-04`, plus README/ARCHITECTURE/SECURITY where affected).
- **`prisma migrate dev` cannot run in this environment.** Author migrations with `prisma migrate diff --from-config-datasource --to-schema` and apply with `prisma migrate deploy`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/components/SuggestCombobox.tsx` | **new** — the shared suggestion picker. Owns its own text state, posts through its own `name`. |
| `src/components/SuggestCombobox.test.tsx` | **new** — jsdom component test: filtering, keyboard, free text. |
| `src/components/DeleteItemButton.tsx` | **new** — Delete button + native `<dialog>` confirmation. |
| `src/modules/items/items.service.ts` | gains `listItemFieldSuggestions()` and `deleteItem()`. |
| `src/app/admin/items/new/NewItemForm.tsx` | five comboboxes; datalists removed; confirmation screen. |
| `src/app/admin/items/new/page.tsx` | fetches the make/model/UIC suggestions. |
| `src/app/admin/items/[itemId]/edit/EditItemForm.tsx` | three comboboxes; datalist removed. |
| `src/app/admin/items/[itemId]/edit/EditItemIdentityForm.tsx` | make + model comboboxes. |
| `src/app/admin/items/[itemId]/edit/page.tsx` | adds `listUnits()` + suggestions. |
| `src/app/i/[itemId]/ItemDetailsCard.tsx` | three comboboxes; both datalists removed. |
| `src/app/i/[itemId]/page.tsx` | suggestions, **admin-only** like its existing fetches. |
| `src/app/admin/actions/items.ts` | `deleteItemAction`; from-search redirect becomes `searchHref`. |
| `src/components/ItemSelectTable.tsx` | Delete beside Retire. |
| `prisma/schema.prisma` + migration | `TransferItem.itemId` nullable, `SetNull`. |

**Task order is deliberate.** Task 7 adds `src/app/admin/actions/items.ts` to the `check-security-docs` watch list. Task 4 also edits that file, so it runs **before** Task 7 — otherwise its commit would need a `docs/SECURITY.md` touch it has no reason to make.

---

### Task 1: `listItemFieldSuggestions()` — the make/model/UIC vocabulary

**Files:**
- Modify: `src/modules/items/items.service.ts`
- Test: `src/modules/items/items.service.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `listItemFieldSuggestions(): Promise<ItemFieldSuggestions>` where `type ItemFieldSuggestions = { make: string[]; model: string[]; deviceUIC: string[] }`. Both are exported from `src/modules/items/items.service.ts`. Tasks 3 and 4 consume it.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/items/items.service.test.ts`. Note `createItem` requires `make`, `model`, `serialNumber` and `deviceName`; `base` at the top of the file already supplies `deviceName`.

```ts
test("listItemFieldSuggestions returns distinct values, most-used first", async () => {
  await createItem({ ...base, make: "Dell", model: "Latitude 5420", serialNumber: "S1", deviceUIC: "WPME10" }, adminId);
  await createItem({ ...base, make: "Dell", model: "Latitude 5420", serialNumber: "S2", deviceUIC: "WPME10" }, adminId);
  await createItem({ ...base, make: "HP", model: "EliteBook", serialNumber: "S3", deviceUIC: "WPME11" }, adminId);

  const s = await listItemFieldSuggestions();

  // Dell appears twice, HP once — frequency decides the order, so the make an
  // admin actually logs is the first suggestion rather than the alphabetical one.
  expect(s.make).toEqual(["Dell", "HP"]);
  expect(s.model).toEqual(["Latitude 5420", "EliteBook"]);
  expect(s.deviceUIC).toEqual(["WPME10", "WPME11"]);
});

test("listItemFieldSuggestions omits blank and whitespace-only values", async () => {
  await createItem({ ...base, make: "Dell", model: "XPS", serialNumber: "S1", deviceUIC: "  " }, adminId);
  await createItem({ ...base, make: "Dell", model: "XPS", serialNumber: "S2" }, adminId);

  const s = await listItemFieldSuggestions();

  expect(s.deviceUIC).toEqual([]);
  expect(s.make).toEqual(["Dell"]);
});
```

Add `listItemFieldSuggestions` to the existing import block at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/items/items.service.test.ts -t "listItemFieldSuggestions"`
Expected: FAIL — `listItemFieldSuggestions is not a function` (or a TS resolution error).

- [ ] **Step 3: Write the implementation**

Add to `src/modules/items/items.service.ts`:

```ts
export type ItemFieldSuggestions = { make: string[]; model: string[]; deviceUIC: string[] };

/**
 * The free-text catalogue vocabularies, for the suggestion comboboxes.
 *
 * Make, model and UIC have no managed list (unlike Category and Unit), so the
 * vocabulary IS what the fleet already holds. Category and Home unit are NOT
 * sourced here on purpose: they come from listCategoryNames()/listUnits(), so
 * the picker agrees with the screens that curate them and cannot resurrect a
 * name an admin deleted.
 *
 * ONE query, three UNION ALL arms — not a query per field, and not a query per
 * row. Ordered by frequency so the makes actually in use head an 8-row list.
 * The per-field cap is a guard against a future dirty import turning this into
 * an unbounded payload, not a reflection of today's counts (16 makes, 53
 * models, ~44 UICs).
 *
 * COUNT(*)::int, not COUNT(*): Postgres counts are bigint, which Prisma hands
 * back as BigInt and JSON.stringify refuses to serialize.
 */
const SUGGESTION_CAP = 200;

export async function listItemFieldSuggestions(): Promise<ItemFieldSuggestions> {
  const rows = await prisma.$queryRaw<{ field: string; value: string; n: number }[]>(Prisma.sql`
    (SELECT 'make' AS field, "make" AS value, COUNT(*)::int AS n
       FROM "Item" WHERE btrim(COALESCE("make", '')) <> ''
       GROUP BY "make" ORDER BY n DESC, value ASC LIMIT ${SUGGESTION_CAP})
    UNION ALL
    (SELECT 'model' AS field, "model" AS value, COUNT(*)::int AS n
       FROM "Item" WHERE btrim(COALESCE("model", '')) <> ''
       GROUP BY "model" ORDER BY n DESC, value ASC LIMIT ${SUGGESTION_CAP})
    UNION ALL
    (SELECT 'deviceUIC' AS field, "deviceUIC" AS value, COUNT(*)::int AS n
       FROM "Item" WHERE btrim(COALESCE("deviceUIC", '')) <> ''
       GROUP BY "deviceUIC" ORDER BY n DESC, value ASC LIMIT ${SUGGESTION_CAP})
  `);

  // Sorted in JS rather than trusting the UNION ALL to preserve each arm's
  // ORDER BY — Postgres does not guarantee the output order of a set operation,
  // only the order WITHIN each parenthesized arm's LIMIT.
  const bucket = (field: string) =>
    rows
      .filter((r) => r.field === field)
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
      .map((r) => r.value);

  return { make: bucket("make"), model: bucket("model"), deviceUIC: bucket("deviceUIC") };
}
```

`Prisma` is already a value import at the top of this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/items/items.service.test.ts -t "listItemFieldSuggestions"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.test.ts
git commit -m "feat(items): vocabulary query for make/model/UIC suggestions"
```

---

### Task 2: `SuggestCombobox`

**Files:**
- Create: `src/components/SuggestCombobox.tsx`
- Create: `src/components/SuggestCombobox.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `<SuggestCombobox id? name options defaultValue? required? placeholder? inputMode? maxVisible? />`, exported from `src/components/SuggestCombobox.tsx`. Tasks 3 and 4 render it.

- [ ] **Step 1: Write the failing test**

Create `src/components/SuggestCombobox.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestCombobox } from "./SuggestCombobox";

afterEach(cleanup);

const OPTIONS = ["Dell", "HP", "Panasonic", "Getac"];

describe("SuggestCombobox", () => {
  it("shows options on focus before anything is typed", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("filters case-insensitively on a substring", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    await userEvent.type(screen.getByRole("combobox"), "an");
    const shown = screen.getAllByRole("option").map((o) => o.textContent);
    expect(shown).toEqual(["Panasonic"]);
  });

  it("caps the list at maxVisible", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} maxVisible={2} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("picks the highlighted option with Enter", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "e");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(input).toHaveValue("Dell");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("leaves freely typed text alone when nothing is highlighted", async () => {
    // The whole point: a value absent from the vocabulary must stay submittable,
    // because the CSV importer can introduce one the property book has not seen.
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "Toughbook");
    expect(input).toHaveValue("Toughbook");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("clicking an option fills the field", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Getac" }));
    expect(screen.getByRole("combobox")).toHaveValue("Getac");
  });

  it("Escape closes the list and drops the highlight", async () => {
    // Escape must clear `active`, not just hide the list: focus reopens it, and a
    // stale highlight would make the next Enter silently pick a dismissed option.
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "e");
    await userEvent.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await userEvent.click(input);
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveValue("e");
  });

  it("posts through its own name and honours defaultValue", () => {
    render(<SuggestCombobox name="deviceCategory" options={OPTIONS} defaultValue="Laptop" />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("name", "deviceCategory");
    expect(input).toHaveValue("Laptop");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/SuggestCombobox.test.tsx`
Expected: FAIL — cannot resolve `./SuggestCombobox`.

- [ ] **Step 3: Write the implementation**

Create `src/components/SuggestCombobox.tsx`:

```tsx
"use client";
import { useId, useMemo, useState } from "react";

/**
 * A type-ahead over a small, already-loaded vocabulary that also IS the field —
 * the posted input is the combobox input itself, so a value absent from the
 * list stays fully submittable.
 *
 * WHY NOT <datalist>: it does not render on mobile browsers, and these forms are
 * used from phones. This is the same control in markup we own.
 *
 * WHY NOT ContactCombobox: that one searches server-side because the contact
 * book is PII and unbounded. These are five short public catalogue vocabularies
 * (~170 strings in total), so the options arrive as a prop and filtering is
 * local — no debounce, no request-race guard, no round trip, and suggestions
 * appear on the first keystroke. The markup, ARIA and keyboard handling are
 * deliberately identical so the two controls feel like one idea.
 *
 * Uncontrolled from the parent's point of view: it owns its text state and
 * posts through `name`, so a form does not have to become controlled to use it.
 */
export function SuggestCombobox({
  id,
  name,
  options,
  defaultValue = "",
  required = false,
  placeholder,
  inputMode,
  maxVisible = 8,
}: {
  id?: string;
  name: string;
  options: string[];
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  inputMode?: "email" | "text";
  maxVisible?: number;
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  // `null` means "not navigated" — distinct from index 0, so a first Enter while
  // merely typing submits the form instead of picking the top suggestion.
  const [active, setActive] = useState<number | null>(null);
  const listId = useId();

  const q = value.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? options.filter((o) => o.toLowerCase().includes(q)) : options).slice(0, maxVisible),
    [options, q, maxVisible]
  );

  // An empty query lists the first `maxVisible` options on focus. That is what
  // makes the control useful to someone who does not yet know what the
  // vocabulary contains — the actual problem on a field like Category.
  const show = open && shown.length > 0;
  // Clamp: `shown` can shrink under a stale `active` between renders.
  const activeIndex = active === null ? null : Math.min(active, Math.max(shown.length - 1, 0));

  const pick = (v: string) => {
    setValue(v);
    setOpen(false);
    setActive(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i === null ? 0 : (Math.min(i, shown.length - 1) + 1) % shown.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        i === null ? shown.length - 1 : (Math.min(i, shown.length - 1) - 1 + shown.length) % shown.length
      );
    } else if (e.key === "Enter") {
      // Only swallow Enter while a suggestion is genuinely highlighted. Otherwise
      // let it through so the form submits whatever was typed.
      if (activeIndex === null) return;
      e.preventDefault();
      pick(shown[activeIndex]);
    } else if (e.key === "Escape") {
      // Clearing `active` is load-bearing: onFocus reopens the list, so a
      // surviving highlight would let the next Enter pick a dismissed option.
      setOpen(false);
      setActive(null);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        className="input"
        name={name}
        role="combobox"
        aria-expanded={show}
        aria-controls={show ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={show && activeIndex !== null ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        inputMode={inputMode}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />

      {show && (
        <ul
          id={listId}
          role="listbox"
          className="card"
          style={{
            position: "absolute", zIndex: 20, insetInlineStart: 0, insetInlineEnd: 0,
            marginBlockStart: 4, maxHeight: 260, overflowY: "auto", padding: 4, listStyle: "none",
          }}
          // mousedown fires before the input's blur, so preventing default here
          // stops the blur (and the close) — the click then lands on the option.
          onMouseDown={(e) => e.preventDefault()}
        >
          {shown.map((o, i) => (
            <li
              key={o}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}
              style={{
                // min-height, not padding alone: a 6px-padded row is a ~22px tap
                // target on a phone, under this app's documented 44px floor.
                minHeight: "var(--tap)", display: "flex", alignItems: "center",
                padding: "6px 8px", cursor: "pointer", borderRadius: "var(--ledger-radius-sm)",
                background: i === activeIndex ? "var(--surface-2)" : undefined,
              }}
            >
              {o}
            </li>
          ))}
        </ul>
      )}

      <div aria-live="polite" role="status" className="sr-only">
        {show ? `${shown.length} suggestion${shown.length === 1 ? "" : "s"} available.` : ""}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/SuggestCombobox.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/SuggestCombobox.tsx src/components/SuggestCombobox.test.tsx
git commit -m "feat(ui): SuggestCombobox — mobile-working suggestions over a loaded vocabulary"
```

---

### Task 3: Wire the combobox into all four surfaces

**Files:**
- Modify: `src/app/admin/items/new/NewItemForm.tsx`, `src/app/admin/items/new/page.tsx`
- Modify: `src/app/admin/items/[itemId]/edit/EditItemForm.tsx`, `.../EditItemIdentityForm.tsx`, `.../page.tsx`
- Modify: `src/app/i/[itemId]/ItemDetailsCard.tsx`, `src/app/i/[itemId]/page.tsx`
- Modify: `CHANGELOG.md`, `README.md`

**Interfaces:**
- Consumes: `listItemFieldSuggestions()` and `ItemFieldSuggestions` (Task 1); `SuggestCombobox` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Convert `NewItemForm`**

In `src/app/admin/items/new/NewItemForm.tsx`: import `SuggestCombobox`, add `suggestions` to the props, delete **both** `<datalist>` blocks, and render a combobox for the five catalogue fields. `serialNumber` and `deviceName` keep plain inputs.

```tsx
import { SuggestCombobox } from "@/components/SuggestCombobox";
import type { ItemFieldSuggestions } from "@/modules/items/items.service";
```

Add to the props object: `suggestions,` with type `suggestions: ItemFieldSuggestions;`.

Replace the `fields.map(...)` body's `<input>` with a branch. Add above the `return`:

```tsx
  // Which vocabulary feeds which field. Category and Home unit come from the
  // MANAGED lists (/admin/categories, /admin/units) rather than from observed
  // item values — sourcing them from DISTINCT Item would resurrect names an
  // admin deliberately deleted and make the picker disagree with the screens
  // that curate them. Make/model/UIC have no managed list, so their vocabulary
  // is what the fleet already holds.
  const optionsFor: Record<string, string[] | undefined> = {
    make: suggestions.make,
    model: suggestions.model,
    deviceUIC: suggestions.deviceUIC,
    homeUnit: units,
    deviceCategory: categories,
  };
```

And in the map:

```tsx
        {fields.map(([name, label, req]) => (
          <div className="field" key={name}>
            <label className="label" htmlFor={name}>
              {label}{req && <span className="req"> *</span>}
            </label>
            {optionsFor[name] ? (
              <SuggestCombobox
                id={name}
                name={name}
                options={optionsFor[name]!}
                required={req}
                defaultValue={name === "deviceUIC" ? returnUic : ""}
              />
            ) : (
              <input
                id={name}
                className="input"
                name={name}
                required={req}
                defaultValue={name === "serialNumber" ? serialNumber : undefined}
              />
            )}
          </div>
        ))}
```

Delete the two `<datalist>` elements and the comment above them.

- [ ] **Step 2: Feed it from the page**

`src/app/admin/items/new/page.tsx`:

```tsx
import { listItemFieldSuggestions } from "@/modules/items/items.service";
...
  const [categories, units, suggestions] = await Promise.all([
    listCategoryNames(),
    listUnits(),
    listItemFieldSuggestions(),
  ]);
...
      <NewItemForm
        serialNumber={prefill}
        cameFromSearch={Boolean(prefill)}
        returnUic={returnUic}
        categories={categories}
        units={units.map((u) => u.fullName)}
        suggestions={suggestions}
      />
```

- [ ] **Step 3: Convert `EditItemForm`**

`src/app/admin/items/[itemId]/edit/EditItemForm.tsx` — props become `{ item, categories = [], units = [], suggestions }`. Delete the `<datalist>` and its comment. Keep the long `inputMode`/`type="email"` comment on `currentUserEmail`; that field stays a plain input.

```tsx
  const optionsFor: Record<string, string[] | undefined> = {
    homeUnit: units,
    deviceUIC: suggestions.deviceUIC,
    deviceCategory: categories,
  };
```

In the map, render `<SuggestCombobox id={name} name={name} options={optionsFor[name]!} required={req} defaultValue={item[name] ?? ""} />` when `optionsFor[name]` exists, else the existing `<input>` unchanged.

- [ ] **Step 4: Convert `EditItemIdentityForm`**

`.../EditItemIdentityForm.tsx` — props become `{ item, suggestions }`. `make` and `model` become comboboxes; **`serialNumber` stays a plain input**. Keep the `alert-warning` paragraph exactly as written; it is deliberately worded.

```tsx
  const optionsFor: Record<string, string[] | undefined> = {
    make: suggestions.make,
    model: suggestions.model,
    // serialNumber is deliberately absent: it is an identity, not a vocabulary,
    // and suggesting one would be actively wrong.
  };
```

In the map, `id={`identity-${name}`}`, `required`, `defaultValue={item[name]}`.

- [ ] **Step 5: Feed both edit forms from the page**

`src/app/admin/items/[itemId]/edit/page.tsx` — it currently fetches only categories:

```tsx
import { listUnits } from "@/modules/items/units.service";
import { listItemFieldSuggestions } from "@/modules/items/items.service";
...
  const [item, categories, units, suggestions] = await Promise.all([
    getItem(itemId),
    listCategoryNames(),
    listUnits(),
    listItemFieldSuggestions(),
  ]);
...
      <EditItemForm item={item} categories={categories} units={units.map((u) => u.fullName)} suggestions={suggestions} />
```

and pass `suggestions={suggestions}` to `<EditItemIdentityForm>`.

- [ ] **Step 6: Convert `ItemDetailsCard`**

`src/app/i/[itemId]/ItemDetailsCard.tsx` — add `suggestions: ItemFieldSuggestions` to `Props` and the destructured params. Replace the three admin-only inputs and delete both `<datalist>` blocks:

```tsx
                <div className="field">
                  <label className="label" htmlFor="ed-homeUnit">Home unit</label>
                  <SuggestCombobox
                    id="ed-homeUnit"
                    name="homeUnit"
                    options={units.map((u) => u.fullName)}
                    placeholder="Search units…"
                    defaultValue={item.homeUnit ?? ""}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ed-deviceUIC">Unit (UIC)</label>
                  <SuggestCombobox
                    id="ed-deviceUIC"
                    name="deviceUIC"
                    options={suggestions.deviceUIC}
                    defaultValue={item.deviceUIC ?? ""}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ed-deviceCategory">Category</label>
                  {/* Free text with the managed vocabulary as SUGGESTIONS, never
                      a locked <select> — an unregistered category must stay
                      typeable (it is learned into the list on save). */}
                  <SuggestCombobox
                    id="ed-deviceCategory"
                    name="deviceCategory"
                    options={categories}
                    placeholder="e.g. Laptop"
                    defaultValue={item.deviceCategory ?? ""}
                  />
                </div>
```

`deviceName`, `currentUserEmail`, `currentPosition` and `notes` are untouched.

> The old Home unit `<datalist>` rendered `<option value={fullName}>{abbreviation}</option>` — the abbreviation showed as a hint beside the name. `SuggestCombobox` takes plain strings and displays the value, so that hint is dropped. This is deliberate: the field stores and matches on `fullName`, and the abbreviation was decoration that a single-string list cannot carry. Do not widen the component to option objects for this alone.

- [ ] **Step 7: Feed the item page — admin-only**

`src/app/i/[itemId]/page.tsx`. The existing `listCategoryNames()` call is already guarded (`isAdmin ? listCategoryNames() : []`). **Both new sources must be guarded the same way** — `/i/<id>` is a public page, the fields are admin-only, and an unguarded fetch would ship the unit and UIC catalogue to a logged-out visitor.

```tsx
    isAdmin ? listUnits() : [],
    isAdmin ? listCategoryNames() : [],
    isAdmin ? listItemFieldSuggestions() : { make: [], model: [], deviceUIC: [] },
```

Pass `suggestions={suggestions}` to `<ItemDetailsCard>`.

- [ ] **Step 8: Typecheck and run the affected tests**

Run: `npx tsc --noEmit`
Expected: no NEW errors. Pre-existing failures in `src/modules/service-queue/service-queue.service.test.ts` and `src/modules/transfers/transfers.service.test.ts` are not yours — confirm with `git stash` if unsure.

Run: `npx vitest run src/components/SuggestCombobox.test.tsx src/components/ItemSelectTable.test.tsx`
Expected: PASS.

- [ ] **Step 9: Verify in a real browser at a mobile viewport**

`npm run dev`, then with the Playwright MCP at a 390×844 viewport, on each of `/admin/items/new`, `/admin/items/<id>/edit` and `/i/<id>`: focus each converted field, confirm the list appears, that it **overlays** the fields below rather than reflowing the form, that a row is at least 44px tall, and that typing a value absent from the list leaves it in the field. jsdom cannot show you any of this.

- [ ] **Step 10: Document and commit**

`CHANGELOG.md`, new `## 2026-08-04` section at the top (today already has one — add to it):

```markdown
### Added
- **Make, model, unit and category now suggest what the property book already holds**, everywhere an item is edited — the new-item form, the admin edit page, the item detail card and the identity card. Start typing and matching values appear, most-used first; anything not on the list is still accepted, so a device nobody has logged before is never blocked. Category and Home unit suggest from the managed lists at `/admin/categories` and `/admin/units`; make, model and UIC suggest from the values already in use.

### Fixed
- **Suggestions now appear on a phone.** The previous suggestion lists used a browser feature (`<datalist>`) that mobile browsers do not display at all, so anyone working from a handset saw nothing — which is most of the people logging devices. Coverage was also uneven: category suggested on three screens, home unit on two, UIC and make/model nowhere.
```

`README.md` — the item-registry bullet gains a clause about suggestions on every edit surface, working on mobile.

```bash
git add src/app/admin/items src/app/i CHANGELOG.md README.md
git commit -m "feat(items): suggestion comboboxes on every item-edit surface"
```

---

### Task 4: Confirmation screen — open the new item

**Files:**
- Modify: `src/app/admin/actions/items.ts:27-98`
- Modify: `src/app/admin/items/new/NewItemForm.tsx:33-43`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createItemAction` now returns `{ itemId: string; searchHref?: string }` on success instead of `{ itemId }`, and no longer redirects.

> Runs **before** Task 7, which adds this file to the `check-security-docs` watch list. Reversing the order would force this commit to touch `docs/SECURITY.md` for no reason.

- [ ] **Step 1: Replace the redirect with a derived href**

In `createItemAction`, replace the `if (fromSearch) { ... redirect(...) }` block and the bare `return { itemId: item.id }`:

```ts
  // Was a redirect() to the filtered list, which meant the confirmation screen
  // never rendered on this path — so "open this item" would have been missing
  // exactly where items are created fastest. The destination is now a LINK, but
  // every property of the old redirect is preserved:
  //   * derived, never caller-supplied — the path is hardcoded and q is read off
  //     the row Prisma just wrote, so there is no target for anyone to craft;
  //   * URLSearchParams does the encoding, because concatenation mangles a
  //     serial containing &, #, + or a space and lands the admin on an empty
  //     list for the item they just created;
  //   * uic rides along ONLY when the new item satisfies it, since listItems
  //     filters deviceUIC by exact equality — returning with a filter the item
  //     does not match would hide the very row the link exists to show.
  let searchHref: string | undefined;
  if (fromSearch) {
    const params = new URLSearchParams({ q: item.serialNumber });
    if (returnUic && item.deviceUIC === returnUic) params.set("uic", returnUic);
    searchHref = `/items?${params}`;
  }

  return { itemId: item.id, searchHref };
```

Remove the now-unused `redirect` import if nothing else in the file uses it (check first — `grep -n "redirect" src/app/admin/actions/items.ts`).

- [ ] **Step 2: Render the choices**

In `NewItemForm.tsx`, replace the success branch. Delete the stale comment above it ("Only reachable when the form was NOT opened from a search…") — both paths reach it now.

```tsx
  if (state && "itemId" in state && state.itemId) {
    return (
      <div className="card stack">
        <p className="alert-success">Item created successfully.</p>
        <div className="row">
          <Link href={`/i/${state.itemId}`} className="btn btn-primary">Open this item</Link>
          <Link href="/admin/items/new" className="btn btn-secondary">Add another</Link>
          {"searchHref" in state && state.searchHref && (
            <Link href={state.searchHref} className="btn btn-ghost">Back to search</Link>
          )}
          <Link href="/items" className="btn btn-ghost">Back to items</Link>
        </div>
      </div>
    );
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Verify both paths in a browser**

`npm run dev`. Create an item from `/admin/items/new` — confirm "Open this item" lands on `/i/<id>`. Then from `/items?q=<a serial that does not exist>`, use the empty state's create link, create the item, and confirm the confirmation screen appears (not a redirect) with a "Back to search" link that returns to the list **with the new item visible**.

- [ ] **Step 5: Document and commit**

Add to the `## 2026-08-04` section:

```markdown
### Added
- **After logging an item you can go straight to it.** The confirmation screen now offers "Open this item" alongside "Add another" and "Back to items", so adding a note or printing a label no longer means searching for the device you just created.

### Changed
- **Creating an item from a search result no longer jumps straight back to the list.** It now shows the same confirmation screen as every other path, with an extra link back to the search you came from — so both routes behave the same way and the new "open this item" choice is available from either.
```

```bash
git add src/app/admin/actions/items.ts src/app/admin/items/new/NewItemForm.tsx CHANGELOG.md
git commit -m "feat(items): offer the new item on the creation confirmation screen"
```

---

### Task 5: Migration — `TransferItem.itemId` nullable, `ON DELETE SET NULL`

**Files:**
- Modify: `prisma/schema.prisma:331-342`
- Create: `prisma/migrations/<timestamp>_transfer_item_nullable_item/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `TransferItem.itemId` is `string | null` in generated Prisma types; deleting an `Item` detaches its `TransferItem` rows instead of being refused.

- [ ] **Step 1: Edit the schema**

```prisma
model TransferItem {
  id             String       @id @default(cuid())
  line           TransferLine @relation(fields: [transferLineId], references: [id], onDelete: Cascade)
  transferLineId String
  // NULLABLE, ON DELETE SET NULL — deleting an item DETACHES its receipt lines
  // rather than being refused (this was RESTRICT) or destroying them (Cascade).
  // Receipts survive intact because they never join Item: the page and the DA
  // 2062 render `serialNumber` here plus make/model on TransferLine, all
  // snapshots taken when the receipt was created. processReturn selects on
  // `id`, not `itemId`, so a detached row is still returnable and a receipt
  // cannot become un-closable because someone deleted a device.
  item           Item?        @relation(fields: [itemId], references: [id], onDelete: SetNull)
  itemId         String?
  serialNumber   String
  returnedAt     DateTime?

  @@index([itemId])
  @@index([transferLineId])
}
```

- [ ] **Step 2: Generate the migration SQL**

```bash
mkdir -p prisma/migrations/20260804190000_transfer_item_nullable_item
npx prisma migrate diff --from-config-datasource prisma.config.ts --to-schema prisma/schema.prisma --script > prisma/migrations/20260804190000_transfer_item_nullable_item/migration.sql
```

Read the generated file. It must contain a `DROP CONSTRAINT`, an `ALTER COLUMN "itemId" DROP NOT NULL`, and an `ADD CONSTRAINT … ON DELETE SET NULL`. If `migrate diff` produces anything that drops or recreates the table, discard it and hand-write:

```sql
ALTER TABLE "TransferItem" DROP CONSTRAINT "TransferItem_itemId_fkey";
ALTER TABLE "TransferItem" ALTER COLUMN "itemId" DROP NOT NULL;
ALTER TABLE "TransferItem" ADD CONSTRAINT "TransferItem_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply locally and regenerate the client**

```bash
npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 4: Typecheck the fallout**

Run: `npx tsc --noEmit`
Expected: no new errors. Two places read `TransferItem.itemId` and both are already safe — `holders.query.ts` binds it in an `IN (…)` (SQL `NULL` never matches, so no null map keys) and `custody.sql.ts` joins on it (NULLs drop out). If a new error appears, handle the null rather than casting it away.

- [ ] **Step 5: Confirm the constraint in the database**

```bash
docker exec inventoryapp-db-1 psql -U postgres -d handreceipt -t -c "select rc.delete_rule from information_schema.referential_constraints rc where rc.constraint_name='TransferItem_itemId_fkey';"
```

Expected: `SET NULL`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): detach receipt lines on item delete instead of refusing it"
```

---

### Task 6: `deleteItem()` — and proof the receipts survive

**Files:**
- Modify: `src/modules/items/items.service.ts`
- Test: `src/modules/items/items.service.test.ts`

**Interfaces:**
- Consumes: the nullable FK (Task 5).
- Produces: `deleteItem(id: string): Promise<void>`, exported from `src/modules/items/items.service.ts`. Task 7 calls it.

- [ ] **Step 1: Write the failing tests**

The second test is the one the whole design rests on — do not skip it.

```ts
test("deleteItem removes the item", async () => {
  const item = await createItem({ ...base, make: "Dell", model: "XPS", serialNumber: "S1" }, adminId);
  await deleteItem(item.id);
  expect(await getItem(item.id)).toBeNull();
});

test("deleting an item leaves its hand receipts intact", async () => {
  const item = await createItem({ ...base, make: "Dell", model: "XPS", serialNumber: "SN-KEEP" }, adminId);
  const transfer = await createTransfer({
    itemIds: [item.id],
    lines: [],
    sender: { isDcsim: true, name: "DCSIM Desk" },
    receiver: { isDcsim: false, name: "Doe, Jane", rank: "SGT", unit: "A Co", contact: "(808)-555-0101", email: "jane@x.co" },
    receiverSignature: "data:image/png;base64,iVBORw0KGgo=",
    createdByUserId: adminId,
  });

  await deleteItem(item.id);

  // The line survives, detached, with its serial snapshot untouched.
  const rows = await prisma.transferItem.findMany();
  expect(rows).toHaveLength(1);
  expect(rows[0].itemId).toBeNull();
  expect(rows[0].serialNumber).toBe("SN-KEEP");

  // And the receipt still renders everything the DA 2062 prints.
  const receipt = await getTransferByReceiptNumber(transfer.receiptNumber);
  expect(receipt?.lines[0].make).toBe("Dell");
  expect(receipt?.lines[0].model).toBe("XPS");
  expect(receipt?.lines[0].items[0].serialNumber).toBe("SN-KEEP");
});

test("deleteItem cascades the item's own history", async () => {
  const item = await createItem({ ...base, make: "Dell", model: "XPS", serialNumber: "S1" }, adminId);
  // ItemEdit stores a JSON diff array plus a denormalized editor name — there
  // are no field/oldValue/newValue columns.
  await prisma.itemEdit.create({
    data: {
      itemId: item.id,
      editedByName: "Admin",
      changes: [{ field: "notes", from: null, to: "x" }],
    },
  });
  await deleteItem(item.id);
  expect(await prisma.itemEdit.count()).toBe(0);
});
```

Import `deleteItem` from `./items.service`, and `createTransfer` + `getTransferByReceiptNumber` from `@/modules/transfers/transfers.service`.

`CreateInput` (`transfers.service.ts:11`) is `{ itemIds, lines, sender, receiver, receiverSignature, createdByUserId?, dueAt? }` — the call above matches it. `lines: []` is valid: `createTransfer` groups items into lines itself and only reads `lines` for per-line quantity overrides.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/items/items.service.test.ts -t "delet"`
Expected: FAIL — `deleteItem is not a function`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Permanently delete an item. There is no undo; Retire is the reversible one.
 *
 * A single delete does the whole job. ServiceQueueItem, ItemEdit and ItemAudit
 * are ON DELETE CASCADE — item-scoped history that has nothing to describe once
 * the item is gone — and TransferItem is ON DELETE SET NULL, so hand receipts
 * keep every line they were signed with.
 *
 * No ItemEdit row is written for the deletion: it would belong to the item
 * being deleted, and would cascade away in the same statement.
 */
export async function deleteItem(id: string): Promise<void> {
  await prisma.item.delete({ where: { id } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/items/items.service.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.test.ts
git commit -m "feat(items): deleteItem, with receipts proven to survive"
```

---

### Task 7: The Delete button, its dialog, and the security docs

**Files:**
- Create: `src/components/DeleteItemButton.tsx`
- Modify: `src/app/admin/actions/items.ts`, `src/components/ItemSelectTable.tsx`
- Modify: `scripts/check-security-docs.mjs`, `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `README.md`

**Interfaces:**
- Consumes: `deleteItem()` (Task 6).
- Produces: `deleteItemAction(formData: FormData): Promise<{ error: string } | void>`.

- [ ] **Step 1: Write the action**

Add to `src/app/admin/actions/items.ts`, importing `deleteItem` from `@/modules/items/items.service`:

```ts
export async function deleteItemAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "No item was specified." };
  try {
    await deleteItem(id);
  } catch (e) {
    // P2025 = record not found. A double submit, or two admins on the same row.
    // Not an error worth alarming anyone with: the outcome they asked for holds.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      revalidatePath("/items");
      return;
    }
    console.error("[deleteItemAction] unexpected error:", e);
    return { error: "Something went wrong deleting this item. Please try again." };
  }
  revalidatePath("/items");
  revalidatePath("/admin/analytics");
}
```

- [ ] **Step 2: Write the button**

Create `src/components/DeleteItemButton.tsx`:

```tsx
"use client";
import { useRef, useState } from "react";
import { deleteItemAction } from "@/app/admin/actions/items";

/**
 * Permanent delete, behind an explicit confirmation.
 *
 * A native <dialog>, not a shadcn Dialog: there is no Dialog primitive in this
 * repo, /items is on the original globals.css system that CLAUDE.md says not to
 * rewrite as a drive-by, and because Tailwind preflight is deliberately not
 * imported a new shadcn primitive has to re-supply border-solid, appearance-none
 * and the 44px tap floor by hand. <dialog> avoids that whole class of bug and
 * gives us Escape-to-close for free.
 */
export function DeleteItemButton({
  id, make, model, serialNumber,
}: { id: string; make: string; model: string; serialNumber: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => ref.current?.showModal()}>
        Delete
      </button>
      <dialog ref={ref} className="card stack" style={{ maxWidth: "32rem", border: "none" }}>
        <div className="card__title">Delete this item permanently?</div>
        <p>
          <strong>{make} {model}</strong> · {serialNumber}
        </p>
        <p>
          This cannot be undone. The item is removed from inventory along with its
          audit and edit history. To take a device out of service without erasing
          it, use <strong>Retire</strong> instead.
        </p>
        {/* Says so explicitly, because a careful admin will otherwise assume the
            opposite and never use this control. */}
        <p className="subtle">
          Hand receipts are not affected — every receipt keeps the serial number,
          make, model and signatures it was issued with.
        </p>
        {error && <p role="alert" className="alert-error">{error}</p>}
        <div className="row">
          <form
            action={async (fd) => {
              setPending(true);
              setError(null);
              const res = await deleteItemAction(fd);
              setPending(false);
              if (res?.error) setError(res.error);
              else ref.current?.close();
            }}
          >
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={pending} className="btn btn-danger">
              {pending ? "Deleting…" : "Delete permanently"}
            </button>
          </form>
          <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  );
}
```

- [ ] **Step 3: Put it beside Retire**

`src/components/ItemSelectTable.tsx`, in the row-actions cell, immediately after the existing Retire `<form>` and inside the same `isAdmin &&` region:

```tsx
          {isAdmin && (
            <DeleteItemButton id={it.id} make={it.make} model={it.model} serialNumber={it.serialNumber} />
          )}
```

Import it at the top. `ItemRow` (`src/components/items-view.ts:36`) already carries `make`, `model` and `serialNumber`, so nothing new needs fetching and there is no per-row query to add.

- [ ] **Step 4: Typecheck and run the table's tests**

Run: `npx tsc --noEmit && npx vitest run src/components/ItemSelectTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the file to the security-docs watch list**

In `scripts/check-security-docs.mjs`, add to the watch list:

```js
  [/^src\/app\/admin\/actions\/items\.ts$/, "item create/edit/delete actions — permanent delete is admin-only (§2)"],
```

It is not currently watched and now carries a permanent-delete action; the sibling `admin/actions/readiness.ts` is watched for a strictly weaker reason.

- [ ] **Step 6: Document**

`docs/SECURITY.md` — under the authorization section, a new control entry: permanent item deletion is `requireAdmin()`-gated, has no undo, and **does not delete receipt evidence** (`TransferItem` detaches; serial, make, model and signatures are snapshots). Bump that entry's *Last reviewed* to 2026-08-04. Also note that `/i/<id>`'s suggestion vocabularies stay behind its existing `isAdmin` guard, so the public surface does not widen.

`docs/ARCHITECTURE.md` — in **Supporting models**, update `TransferLine` / `TransferItem` to say `itemId` is nullable with `SET NULL` and why detaching preserves the document. In the `Item` section, note delete alongside retire.

`README.md` — the admin-console bullet gains delete.

`CHANGELOG.md`, into `## 2026-08-04`:

```markdown
### Added
- **Admins can now permanently delete an item**, alongside Retire on the items list. It is for rows that should never have existed — a duplicate from a mistyped serial, a bad CSV import — and it asks for confirmation first, naming the device. Deleting an item removes it from inventory along with its audit and edit history. **Hand receipts are not affected:** every receipt keeps the serial number, make, model and signatures it was issued with, because a receipt records what was signed for at the time rather than looking the device up afresh. Retire remains the reversible option for a device that is simply out of service.

### Notes
- Database: adds `<timestamp>_transfer_item_nullable_item`, which lets a receipt line outlive the item it points at. **Apply it to production before this merges** — a `next build` never runs `migrate deploy`, and the deployed code deletes items on the assumption the constraint has changed.
```

- [ ] **Step 7: Check the guardrail passes**

Run: `npm run check:security-docs`
Expected: pass (locally it may report "no security-relevant files changed" — it diffs the merge base, which is only meaningful on a PR; the real check runs there).

- [ ] **Step 8: Verify in a real browser**

`npm run dev`. On `/items` as an admin: Delete opens the dialog, Cancel and Escape both close it without deleting, and confirming removes the row. Then **at a 390×844 viewport**, confirm the dialog fits, does not overflow horizontally, and its buttons are at least 44px tall. Finally, open a receipt that contained the deleted item at `/receipts/<rn>` and its `/pdf` and confirm both still show the serial, make and model.

- [ ] **Step 9: Commit**

```bash
git add src/components/DeleteItemButton.tsx src/components/ItemSelectTable.tsx src/app/admin/actions/items.ts scripts/check-security-docs.mjs docs CHANGELOG.md README.md
git commit -m "feat(items): admin-only permanent delete, leaving receipts intact"
```

---

### Task 8: Full verification and PR

**Files:** none — this is the gate.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS except the pre-existing failures noted in Task 3, Step 8. **Do not run this while another agent is working** — the test database is shared and truncated between tests.

- [ ] **Step 2: Lint and build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Apply the migration to production BEFORE the PR merges**

Per `DEPLOY.md` and the migrate-before-push rule. The prod `DIRECT_URL` is pulled empty, so apply the DDL and the `_prisma_migrations` row by hand through the Supabase MCP in one transaction; the checksum must be the CRLF sha256 of the committed migration file.

- [ ] **Step 4: Open the PR**

Branch from `main`, push, and open a PR. All three checks must pass: `Semgrep SAST`, `Build (next build)`, `Security docs current`.

---

## Self-Review

**Spec coverage:** §1.1–1.4 → Task 2. §1.5–1.6 → Task 1. §1.7–1.9 → Task 3. §2.1 → Task 5. §2.2 → Task 6. §2.3–2.4 → Task 7. §3 → Task 4. §5 testing → Tasks 1, 2, 6 plus the browser steps in 3, 4 and 7. §6 documentation → Tasks 3, 4 and 7. §7 risks → Task 5 (migration) and Task 8 Step 3 (migrate-before-merge).

**Type consistency:** `ItemFieldSuggestions` is defined in Task 1 and consumed by name in Tasks 3 and 4. `listItemFieldSuggestions`, `deleteItem`, `deleteItemAction`, `SuggestCombobox` and `DeleteItemButton` keep the same names and signatures throughout. `createItemAction`'s new return shape is stated in Task 4's Interfaces block and consumed only there.

**Soft spots, checked rather than left as caveats.** Three assumptions were verified against the code after the first draft:

- `ItemEdit` has **no** `field`/`oldValue`/`newValue`/`editorName` columns — it stores a JSON `changes` array plus a denormalized `editedByName`. The first draft's test would not have compiled; Task 6 Step 1 is corrected.
- `createTransfer`'s `CreateInput` matches the call in Task 6 Step 1 as written.
- `ItemRow` already carries `make`, `model` and `serialNumber`, so Task 7 Step 3 needs no extra fetch.

**One assumption left standing:** Task 5 Step 2 predicts what `prisma migrate diff` emits. The step includes the hand-written SQL to use if it emits anything that drops or recreates the table, so the task is executable either way.
