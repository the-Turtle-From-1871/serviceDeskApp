# Create Item From Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin's `/items` search returns nothing, offer a one-click path to create that item with the searched text prefilled as its serial, landing back on the filtered list afterwards.

**Architecture:** The `/items` zero-results state (inside `ItemSelectTable`) gains an admin-only link to `/admin/items/new?serialNumber=…`. That page reads the prefill from `searchParams`, widens its form by two fields (`deviceUIC`, `deviceCategory`) plus two datalists, and posts to the existing `createItemAction`, which gains category registration, revalidation, duplicate-serial handling, and a conditional redirect back to `/items?q=<serial>`. No new route, no new table, no migration.

**Tech Stack:** Next.js 16 (App Router, Server Components, Server Actions), React 19, TypeScript 5, Prisma 7 on PostgreSQL, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-create-item-from-search-design.md` (revision 3, verified against `main` at `0602bd4`). Read it before starting — it records *why* several of these choices are what they are, including three that were wrong in an earlier draft.

## Global Constraints

- **Branch:** work on `docs/create-item-from-search` (already rebased onto `main`). Never push to `main` — it is branch-protected and needs a PR with three green checks.
- **Every Server Action starts with `requireUser()` or `requireAdmin()`** from `@/lib/authz`, never bare `auth()`. `createItemAction` already calls `requireAdmin()`; do not remove it.
- **`z.object()` strips unknown keys.** Any field a form renders MUST be declared in the schema, or it saves nothing while reporting success. This bug has shipped twice in this codebase.
- **Do not import `categories.service` (server-only) into a client component.** `normalizeCategoryName` lives in the pure `items.schema.ts` for exactly this reason.
- **Two CSS systems coexist.** `ItemSelectTable` and `NewItemForm` are entirely legacy (`globals.css`) — use `.btn` / `.card` / `.field`, NOT Tailwind or shadcn. Legacy `.btn`/`.btn-sm` already meet the 44px `--tap` floor at ≤720px via `globals.css:1086-1091`.
- **`npm run build` and jsdom are NOT evidence for a CSS change.** Neither has a layout engine. Task 8 requires a real browser.
- **Docs ship in the same commit as the code** — `CHANGELOG.md` for any user-facing change, `CLAUDE.md` when a rule it states stops being true.
- **Test commands:** `npx vitest run <path>` for one file. Integration tests hit a real DB; you are the only agent using it, so do not spawn parallel agents that run tests.
- **Commit message trailer:** end every commit with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/modules/items/items.schema.ts` | `categoryNew` variant; `deviceUIC` + `deviceCategory` on `newItemSchema`; `.max(64)` on `serialNumber` | 1 |
| `src/modules/items/items.schema.test.ts` | Schema unit tests (existing file, extended) | 1 |
| `src/modules/items/items.service.ts` | `getItemBySerial` — the P2002 branch's lookup | 2 |
| `src/modules/items/items.service.test.ts` | Real-DB test for `getItemBySerial` (existing file, extended) | 2 |
| `src/app/admin/actions/items.ts` | `createItemAction`: learn, revalidate, P2002, redirect | 3, 4 |
| `src/app/actions/items.test.ts` | Action tests (existing file — already covers admin actions) | 3, 4 |
| `src/app/admin/items/new/page.tsx` | Read `searchParams`; fetch category + unit vocabularies | 5 |
| `src/app/admin/items/new/NewItemForm.tsx` | Prefill, 2 new fields, 2 datalists, hidden inputs, collision link | 6 |
| `src/components/ItemSelectTable.tsx` | The empty-state affordance | 7 |
| `src/components/ItemSelectTable.test.tsx` | **New** — jsdom render test for the affordance | 7 |
| `src/app/globals.css` | `.truncate-inline` helper for the button label | 7 |
| `CHANGELOG.md`, `CLAUDE.md` | Docs | 8 |

**Note on test placement:** the spec's §5 said `createItemAction` tests need a new `src/app/admin/actions/items.test.ts`. That is wrong — `src/app/actions/items.test.ts` already imports and tests `updateItemIdentityAction` from `@/app/admin/actions/items` (`:54`, `:185-283`) and already has every mock this needs. Extend it. Fix the spec's §5 in Task 8.

---

## Task 1: Schema — `categoryNew`, two new fields, serial length bound

**Files:**
- Modify: `src/modules/items/items.schema.ts` (`identityItemFields` at `:51-55`, `newItemSchema` at `:57-62`)
- Test: `src/modules/items/items.schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `newItemSchema` accepting `deviceUIC?: string` and `deviceCategory?: string`; `NewItemInput` gains both as `string | undefined`.

**Why `.max(64)` on the serial:** production holds 1,201 items whose longest serial is **14 characters** (p99 also 14), so 64 is 4.5× headroom and cannot reject real data. The bound is needed because the prefill arrives from a URL — capping only the input's `defaultValue` would protect nothing. Note `identityItemFields` is shared with `itemIdentitySchema`, so this also bounds the admin identity-edit form. That is intended.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/items/items.schema.test.ts`:

```ts
describe("newItemSchema — deviceUIC and deviceCategory", () => {
  const base = { make: "Dell", model: "5540", serialNumber: "ABC123", deviceName: "LT-01" };

  it("retains deviceUIC and deviceCategory instead of stripping them", () => {
    const parsed = newItemSchema.parse({ ...base, deviceUIC: "WABC01", deviceCategory: "Laptop" });
    expect(parsed.deviceUIC).toBe("WABC01");
    expect(parsed.deviceCategory).toBe("Laptop");
  });

  it("normalizes a category's internal whitespace and trims it", () => {
    const parsed = newItemSchema.parse({ ...base, deviceCategory: "  Docking   Station  " });
    expect(parsed.deviceCategory).toBe("Docking Station");
  });

  it("maps a blank category to undefined rather than an empty string", () => {
    const parsed = newItemSchema.parse({ ...base, deviceCategory: "   " });
    expect(parsed.deviceCategory).toBeUndefined();
  });

  it("REJECTS an over-long category with a message instead of silently dropping it", () => {
    const result = newItemSchema.safeParse({ ...base, deviceCategory: "x".repeat(MAX_CATEGORY_NAME + 1) });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/limited to 60 characters/);
  });

  // createItem re-parses its own input at the service boundary, so the schema
  // must accept its own output. Without the trailing .optional() on categoryNew,
  // a blank category becomes undefined on the first parse and fails z.string()
  // on the second — i.e. EVERY create without a category would break.
  it("round-trips its own output when the category is blank", () => {
    const once = newItemSchema.parse({ ...base, deviceCategory: "" });
    expect(() => newItemSchema.parse(once)).not.toThrow();
  });

  it("rejects a serial longer than the bound", () => {
    const result = newItemSchema.safeParse({ ...base, serialNumber: "x".repeat(65) });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/64 characters/);
  });

  it("still accepts a realistic serial", () => {
    expect(newItemSchema.parse({ ...base, serialNumber: "5CG1234ABC" }).serialNumber).toBe("5CG1234ABC");
  });
});
```

Add whatever is missing to the file's existing import line — it needs `newItemSchema` and `MAX_CATEGORY_NAME` from `./items.schema`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/items/items.schema.test.ts`
Expected: FAIL — `deviceUIC`/`deviceCategory` come back `undefined` (stripped), and the over-long serial parses fine.

- [ ] **Step 3: Add `categoryNew` to `items.schema.ts`**

**Placement matters.** `newItemSchema` is at `:57`, but the `clearable` helper
(`z.string().trim()`) and `categoryClearable` are declared at `:113-126` —
*below* it. A `const` cannot be used before it is declared, so `categoryNew`
must sit **immediately above `newItemSchema`** and spell out `z.string().trim()`
itself rather than reusing `clearable`. Do not move `clearable` up to
"tidy" this; that reshuffles a heavily-commented file for no gain.

Insert directly above `export const newItemSchema`:

```ts
/** Category cell for the CREATE form. Blank -> undefined like `categoryOptional`
 *  (there is no prior value to clear on a row that does not exist yet, and
 *  writing "" would put an empty string into an indexed column that every
 *  filter and count treats as a value). But over-long names are REJECTED with a
 *  message like `categoryClearable`, not silently dropped: a form that says
 *  "Created" while discarding what was typed is the exact bug the note on
 *  `categoryClearable` warns about.
 *
 *  The trailing `.optional()` is load-bearing, not decoration. `createItem`
 *  re-parses its input through `newItemSchema` as defense at the service
 *  boundary, so the schema must accept its OWN output — and a blank category's
 *  output is `undefined`. Without it every create with no category fails on the
 *  second parse. `categoryOptional` and the `optional` helper end the same way
 *  for the same reason.
 *
 *  Spells out `z.string().trim()` rather than reusing the `clearable` helper
 *  below, because that helper is declared after `newItemSchema` and a const
 *  cannot be used before its declaration. */
const categoryNew = z
  .string()
  .trim()
  .transform((v) => normalizeCategoryName(v))
  .refine(
    (v) => v.length <= MAX_CATEGORY_NAME,
    `Category names are limited to ${MAX_CATEGORY_NAME} characters.`,
  )
  .transform((v) => v || undefined)
  .optional();
```

- [ ] **Step 4: Widen `newItemSchema` and bound the serial**

Replace `identityItemFields`' serial line and `newItemSchema`:

```ts
const identityItemFields = {
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  // Bounded because the create form's serial can be PREFILLED FROM A URL
  // (?serialNumber=…, see the create-from-search flow). Production's longest
  // real serial is 14 characters, so 64 is generous headroom that cannot
  // reject a genuine device. Shared with itemIdentitySchema, so it bounds the
  // admin identity-edit form too.
  serialNumber: z.string().trim().min(1, "Serial number is required")
    .max(64, "Serial numbers are limited to 64 characters"),
} as const;

export const newItemSchema = z.object({
  ...identityItemFields,
  deviceName: z.string().trim().min(1, "Device name is required"),
  homeUnit: optional,
  deviceUIC: optional,
  deviceCategory: categoryNew,
  notes: optional,
});
```

Leave `categoryOptional` and `categoryClearable` exactly where they are — only `categoryNew` is new, and it sits above `newItemSchema` per Step 3.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/items/items.schema.test.ts`
Expected: PASS, all of them, including the pre-existing tests in that file.

- [ ] **Step 6: Run the schemas' other consumers**

Run: `npx vitest run src/modules/items/item-diff.test.ts src/app/actions/items.test.ts`
Expected: PASS. These exercise `itemIdentitySchema` and the editable-field schemas; the serial bound is the only thing that could disturb them.

- [ ] **Step 7: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/items/items.schema.test.ts
git commit -m "feat(items): new-item schema gains deviceUIC, deviceCategory and a serial bound

A category typed on the create form now survives parsing instead of being
stripped by z.object(), with its own schema variant: blank collapses to
undefined (no prior value to clear on a row that does not exist), while an
over-long name is rejected with a message rather than silently dropped.

The trailing .optional() matters — createItem re-parses its own input at the
service boundary, so the schema has to accept its own output.

serialNumber gains .max(64) because the create form can be prefilled from a
URL. Production's longest real serial is 14 characters.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `getItemBySerial` — the collision lookup

**Files:**
- Modify: `src/modules/items/items.service.ts` (add beside `getItem` at `:27`)
- Test: `src/modules/items/items.service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getItemBySerial(serialNumber: string): Promise<{ id: string } | null>` — used by Task 3's P2002 branch.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/items/items.service.test.ts` (a real-DB file — follow its existing seeding style):

```ts
describe("getItemBySerial", () => {
  it("finds an item by serial REGARDLESS of casing (citext) and returns just its id", async () => {
    const created = await createItem(
      { make: "Dell", model: "5540", serialNumber: "CaSe-1", deviceName: "LT-case" },
      admin.id,
    );
    expect(await getItemBySerial("case-1")).toEqual({ id: created.id });
    expect(await getItemBySerial("CASE-1")).toEqual({ id: created.id });
  });

  it("returns null for a serial that does not exist", async () => {
    expect(await getItemBySerial("NO-SUCH-SERIAL")).toBeNull();
  });
});
```

Use whatever the file already uses for `admin` — read the top of the file and match it rather than inventing a fixture.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/items/items.service.test.ts -t getItemBySerial`
Expected: FAIL — `getItemBySerial is not a function`.

- [ ] **Step 3: Implement it**

Add directly below `getItem` in `items.service.ts`:

```ts
/** Resolve an item id from a serial. Used ONLY on the create path's P2002
 *  branch, to turn "that serial is taken" into a link to the item that took it.
 *  `serialNumber` is @unique @db.Citext, so this matches regardless of casing
 *  and can return at most one row. Selects the id alone — the caller needs a
 *  link, not a device. */
export function getItemBySerial(serialNumber: string) {
  return prisma.item.findUnique({
    where: { serialNumber },
    select: { id: true },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/items/items.service.test.ts -t getItemBySerial`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.test.ts
git commit -m "feat(items): getItemBySerial, a citext lookup for the collision branch

Turns a duplicate-serial rejection into a link to the item that already holds
the serial, instead of a dead end. Selects the id alone — the caller needs a
link, not a device.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `createItemAction` — register the category, revalidate, handle a duplicate serial

**Files:**
- Modify: `src/app/admin/actions/items.ts:25-33`
- Test: `src/app/actions/items.test.ts`

**Interfaces:**
- Consumes: `newItemSchema` (Task 1), `getItemBySerial` (Task 2).
- Produces: `createItemAction` returning `{ itemId: string }` on success or `{ error: string; existingItemId?: string }` on failure. Task 6's form reads `existingItemId`.

**Design constraint — `learnCategories` runs OUTSIDE the item write, and swallows its own failure.** This is not a style preference. Both existing single-item write sites do it (`admin/actions/items.ts:61-72`, `app/actions/items.ts:47-63`) with comments explaining that reporting a vocabulary-insert failure as "something went wrong saving your changes" tells the admin their write did not land when it did. Do NOT wrap the create and the learn in one transaction.

- [ ] **Step 1: Promote `createItem` to a controllable mock**

In `src/app/actions/items.test.ts`, the `@/modules/items/items.service` mock (`:17-25`) currently declares `createItem: vi.fn()` inline. Hoist it so tests can drive it, and add `getItemBySerial`:

```ts
const createItem = vi.fn();
const getItemBySerial = vi.fn();
// …inside the existing vi.mock("@/modules/items/items.service", …) factory:
  createItem: (data: unknown, createdById: string) => createItem(data, createdById),
  getItemBySerial: (serial: string) => getItemBySerial(serial),
```

Add to the existing `beforeEach`:

```ts
  createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123" });
  getItemBySerial.mockResolvedValue(null);
```

- [ ] **Step 2: Write the failing tests**

Append to `src/app/actions/items.test.ts` (import `createItemAction` alongside the existing `updateItemIdentityAction` import at `:54`):

```ts
describe("createItemAction", () => {
  const NEW_ITEM = {
    make: "Dell", model: "5540", serialNumber: "ABC123",
    deviceName: "LT-01", homeUnit: "A Co", deviceUIC: "WABC01",
    deviceCategory: "  Docking   Station ", notes: "",
  };

  it("calls requireAdmin BEFORE any write, and writes nothing when it rejects", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(createItemAction(undefined, fd(NEW_ITEM))).rejects.toThrow("FORBIDDEN");
    expect(createItem).not.toHaveBeenCalled();
  });

  it("persists deviceUIC and the NORMALIZED category, with the creator from the SERVER session", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd(NEW_ITEM));
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUIC: "WABC01", deviceCategory: "Docking Station" }),
      ADMIN.id,
    );
  });

  it("teaches a typed category to the managed vocabulary", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd(NEW_ITEM));
    expect(learnCategories).toHaveBeenCalledWith(["Docking Station"]);
  });

  it("does not call learnCategories when no category was typed", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd({ ...NEW_ITEM, deviceCategory: "" }));
    expect(learnCategories).not.toHaveBeenCalled();
  });

  // The item is already committed by the time learnCategories runs. Reporting
  // its failure would tell the admin their item was not created when it was.
  it("still reports success when learnCategories fails", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    learnCategories.mockRejectedValue(new Error("vocabulary down"));
    await expect(createItemAction(undefined, fd(NEW_ITEM))).resolves.toEqual({ itemId: "new-1" });
  });

  it("names the conflicting serial on a P2002 and links to the item holding it", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
    );
    getItemBySerial.mockResolvedValue({ id: "existing-9" });
    const res = await createItemAction(undefined, fd(NEW_ITEM));
    expect(res.error).toContain("ABC123");
    expect(res.existingItemId).toBe("existing-9");
  });

  it("still returns the collision error when the colliding item cannot be resolved", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
    );
    getItemBySerial.mockResolvedValue(null);
    const res = await createItemAction(undefined, fd(NEW_ITEM));
    expect(res.error).toContain("ABC123");
    expect(res.existingItemId).toBeUndefined();
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createItem.mockRejectedValue(new Error("connection reset"));
    const res = await createItemAction(undefined, fd(NEW_ITEM));
    expect(res.error).not.toContain("connection reset");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("revalidates the item list, the category admin page and analytics", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd(NEW_ITEM));
    expect(revalidatePath).toHaveBeenCalledWith("/items");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/categories");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/analytics");
  });

  it("rejects a blank make before touching the DB", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    const res = await createItemAction(undefined, fd({ ...NEW_ITEM, make: "" }));
    expect(res.error).toMatch(/Make is required/);
    expect(createItem).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/app/actions/items.test.ts -t createItemAction`
Expected: FAIL — no `learnCategories` call, no `revalidatePath`, and the P2002 test throws instead of returning an error object.

- [ ] **Step 4: Implement**

Replace `createItemAction` (`src/app/admin/actions/items.ts:25-33`) with:

```ts
export async function createItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  let item;
  try {
    item = await createItem(data, admin.id);
  } catch (e) {
    // P2002 = unique-constraint violation. Item has exactly ONE unique column —
    // serialNumber, which is @db.Citext — so this can only mean an item already
    // holds that serial in some casing. Leaned on rather than pre-checked with a
    // findUnique, which would race. Reachable from the create-from-search flow:
    // /items?q=X&uic=Y shows "no matches" for an item that exists under a
    // DIFFERENT uic, and the empty state still offers to create it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      console.error("[createItemAction] serial collision:", e);
      const existing = await getItemBySerial(data.serialNumber);
      return {
        error: `Serial number "${data.serialNumber}" already belongs to an item. Serial numbers are unique and ignore case — open that item instead.`,
        existingItemId: existing?.id,
      };
    }
    console.error("[createItemAction] unexpected error:", e);
    return { error: "Something went wrong creating this item. Please try again." };
  }

  // A category typed directly into the form joins the vocabulary, so the managed
  // list keeps reflecting what is actually in the fleet. Outside the try, and
  // swallowing its own failure, because it is a SEPARATE transaction that runs
  // after the item write has committed — see the fuller note in
  // src/app/actions/items.ts.
  if (data.deviceCategory) {
    try {
      await learnCategories([data.deviceCategory]);
    } catch (e) {
      console.error("[createItemAction] learnCategories failed (item already created):", e);
    }
  }

  revalidatePath("/items");
  // The in-use counts on the category admin page go stale the moment
  // learnCategories registers a name; analytics counts the fleet.
  revalidatePath("/admin/categories");
  revalidatePath("/admin/analytics");

  return { itemId: item.id };
}
```

Add `getItemBySerial` to the existing `@/modules/items/items.service` import at the top of the file. `Prisma`, `learnCategories` and `revalidatePath` are already imported (`:19`, `:20`, `:2`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/actions/items.test.ts`
Expected: PASS — the new `createItemAction` block and every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/actions/items.ts src/app/actions/items.test.ts
git commit -m "feat(items): createItemAction registers the category and survives a duplicate serial

Three gaps on the create path, all reachable once an item can be created
straight from a failed search:

- A typed category never joined the managed vocabulary, so a hand-created item
  could hold a string that appears in no picker. It is registered now, after the
  item commits and swallowing its own failure, matching the two existing
  single-item write sites.
- Nothing was revalidated, so the list an admin returns to could omit the item
  they just made.
- A duplicate serial was an unhandled throw. It now returns a message naming the
  serial plus a link to the item that already holds it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Redirect back to the filtered list

**Files:**
- Modify: `src/app/admin/actions/items.ts` (`createItemAction`, from Task 3)
- Test: `src/app/actions/items.test.ts`

**Interfaces:**
- Consumes: Task 3's `createItemAction`.
- Produces: when `formData.get("fromSearch") === "1"`, the action throws `NEXT_REDIRECT` to `/items?q=<serial>[&uic=<returnUic>]` instead of returning `{ itemId }`. Task 6's form supplies both hidden fields.

**Two things that will bite you if you skip them:**

1. **`redirect()` must be called OUTSIDE the try/catch.** It works by throwing `NEXT_REDIRECT`; inside the catch it is swallowed and silently becomes the generic error. Next 16's own docs say so (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`).
2. **Read the hidden fields off `formData`, NEVER off `parsed.data`.** `newItemSchema` is a `z.object()` and strips unknown keys, so they vanish from the parsed result.

**And build the URL with `URLSearchParams`.** Concatenation mangles any serial containing `&`, `#`, `+` or a space, landing the admin on an empty list for the item they just created — the exact opposite of the confirmation this redirect exists to give.

- [ ] **Step 1: Mock `next/navigation` in the test file**

Add near the other `vi.mock` calls in `src/app/actions/items.test.ts`, matching the pattern at `src/app/actions/auth.rate-limit.test.ts:45-48`:

```ts
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { digest: "NEXT_REDIRECT" });
  },
}));
```

- [ ] **Step 2: Write the failing tests**

Append inside the existing `describe("createItemAction", …)`:

```ts
  it("returns to the filtered list when the form came from a search", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123" });
    await expect(
      createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1", returnUic: "" })),
    ).rejects.toThrow("NEXT_REDIRECT:/items?q=ABC123");
  });

  it("carries the unit filter back with it", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123" });
    await expect(
      createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1", returnUic: "WABC01" })),
    ).rejects.toThrow("NEXT_REDIRECT:/items?q=ABC123&uic=WABC01");
  });

  // Concatenation would produce ?q=A&B C — a different search, matching nothing.
  it("percent-encodes a serial containing URL metacharacters", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "A&B C#1" });
    await expect(
      createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1" })),
    ).rejects.toThrow("NEXT_REDIRECT:/items?q=A%26B+C%231");
  });

  it("does NOT redirect when the form was opened directly", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await expect(createItemAction(undefined, fd(NEW_ITEM))).resolves.toEqual({ itemId: "new-1" });
  });

  // The redirect must not swallow a collision — the admin needs the error.
  it("does NOT redirect when the serial collided", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
    );
    getItemBySerial.mockResolvedValue({ id: "existing-9" });
    const res = await createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1" }));
    expect(res.error).toContain("ABC123");
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/app/actions/items.test.ts -t createItemAction`
Expected: FAIL — the redirect tests resolve to `{ itemId: "new-1" }` instead of throwing.

- [ ] **Step 4: Implement**

In `createItemAction`, read the two hidden fields right after `requireAdmin()`:

```ts
  // Read off formData, NOT parsed.data: newItemSchema is a z.object() and
  // strips unknown keys, so these would silently vanish from the parsed result.
  const fromSearch = formData.get("fromSearch") === "1";
  const returnUic = String(formData.get("returnUic") ?? "").trim();
```

and replace the final `return { itemId: item.id };` with:

```ts
  // OUTSIDE the try/catch above — redirect() works by throwing NEXT_REDIRECT,
  // and a catch would swallow it into the generic error message.
  //
  // The destination is DERIVED, never caller-supplied: the path is hardcoded
  // and q is read back off the row Prisma just wrote, so there is no redirect
  // target for anyone to craft. URLSearchParams does the encoding — building
  // this by concatenation mangles a serial containing &, #, + or a space and
  // lands the admin on an empty list for the item they just created.
  if (fromSearch) {
    const params = new URLSearchParams({ q: item.serialNumber });
    if (returnUic) params.set("uic", returnUic);
    redirect(`/items?${params}`);
  }

  return { itemId: item.id };
```

Add `import { redirect } from "next/navigation";` at the top of the file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/app/actions/items.test.ts`
Expected: PASS, whole file.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/actions/items.ts src/app/actions/items.test.ts
git commit -m "feat(items): return to the filtered list after creating from a search

An admin who created an item from a failed search now lands back on
/items?q=<serial> with their unit filter intact, seeing the row they just made,
already positioned to search the next missing serial.

The destination is derived, not passed: the path is hardcoded and q is read off
the row Prisma just wrote, so there is no redirect target in the URL for anyone
to craft. Built with URLSearchParams — concatenation would mangle a serial
containing &, # or a space into a search matching nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The new-item page reads the prefill and both vocabularies

**Files:**
- Modify: `src/app/admin/items/new/page.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `<NewItemForm serialNumber={string} cameFromSearch={boolean} returnUic={string} categories={string[]} units={string[]} />` — Task 6 implements that signature.

**Next 16 convention:** `searchParams` is a **`Promise`** and must be awaited, then each value passed through `firstParam` (`src/lib/search-params.ts`) because Next supplies an array whenever a key is repeated (`?uic=A&uic=B`). Calling `.trim()` on the array is a 500 for a logged-in admin.

- [ ] **Step 1: Rewrite the page**

```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listCategoryNames } from "@/modules/items/categories.service";
import { listUnits } from "@/modules/items/units.service";
import { firstParam } from "@/lib/search-params";
import { NewItemForm } from "./NewItemForm";

export default async function NewItemPage({
  searchParams,
}: {
  // string[] is reachable: Next supplies an array whenever a key is repeated
  // (`?uic=A&uic=B`). firstParam collapses that before any string method runs.
  searchParams: Promise<{ serialNumber?: string | string[]; uic?: string | string[] }>;
}) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const sp = await searchParams;
  // Arrives from the /items empty state. Inert — it becomes a text input's
  // defaultValue and nothing else; newItemSchema validates it on submit like
  // any other field, including its length bound.
  const prefill = (firstParam(sp.serialNumber) ?? "").trim();
  const returnUic = (firstParam(sp.uic) ?? "").trim();

  const [categories, units] = await Promise.all([listCategoryNames(), listUnits()]);

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">New item</h1>
        <p className="subtle">Log a new item into inventory.</p>
        <Link href="/admin/items/import" className="btn btn-ghost btn-sm">Import CSV instead</Link>
      </div>
      <NewItemForm
        serialNumber={prefill}
        cameFromSearch={Boolean(prefill)}
        returnUic={returnUic}
        categories={categories}
        units={units.map((u) => u.fullName)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: errors ONLY about `NewItemForm` not accepting these props — Task 6 adds them. Any other error is a real problem; fix it before continuing.

- [ ] **Step 3: Commit (with Task 6)**

Do not commit yet — the app does not typecheck until Task 6 lands. Continue straight to Task 6 and commit them together.

---

## Task 6: The form — prefill, two fields, two datalists, collision link

**Files:**
- Modify: `src/app/admin/items/new/NewItemForm.tsx`

**Interfaces:**
- Consumes: the props from Task 5; `createItemAction`'s `{ error, existingItemId? }` from Task 3.
- Produces: a form posting `deviceUIC`, `deviceCategory`, and (when `cameFromSearch`) hidden `fromSearch="1"` and `returnUic`.

**Why `homeUnit` gets a datalist too:** `renameUnit` backfills items by matching the old `Unit.fullName`. A hand-typed spelling that drifts from the vocabulary is silently skipped by every future rename. Suggesting the known spellings prevents that. This does NOT register new units — `learnUnits` keys on an `abbreviation`, which a typed full name does not carry.

- [ ] **Step 1: Rewrite the form**

```tsx
"use client";
import { useActionState } from "react";
import Link from "next/link";
import { createItemAction } from "@/app/admin/actions/items";

const fields = [
  ["make", "Make", true],
  ["model", "Model", true],
  ["serialNumber", "Serial number", true],
  ["deviceName", "Device Name", true],
  ["homeUnit", "Home unit", false],
  ["deviceUIC", "UIC", false],
  ["deviceCategory", "Category", false],
] as const;

export function NewItemForm({
  serialNumber = "",
  cameFromSearch = false,
  returnUic = "",
  categories = [],
  units = [],
}: {
  serialNumber?: string;
  cameFromSearch?: boolean;
  returnUic?: string;
  categories?: string[];
  units?: string[];
}) {
  const [state, action, pending] = useActionState(createItemAction, undefined);

  // Only reachable when the form was NOT opened from a search — that path
  // redirects to /items instead of returning, so it never renders this.
  if (state && "itemId" in state && state.itemId) {
    return (
      <div className="card stack">
        <p className="alert-success">Item created successfully.</p>
        <div className="row">
          <Link href="/admin/items/new" className="btn btn-secondary">Add another</Link>
          <Link href="/items" className="btn btn-ghost">Back to items</Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="card stack">
      {cameFromSearch && (
        <>
          {/* Read directly off formData in the action — newItemSchema is a
              z.object() and would strip them from the parsed result. */}
          <input type="hidden" name="fromSearch" value="1" />
          <input type="hidden" name="returnUic" value={returnUic} />
        </>
      )}
      <div className="form-grid">
        {fields.map(([name, label, req]) => (
          <div className="field" key={name}>
            <label className="label" htmlFor={name}>
              {label}{req && <span className="req"> *</span>}
            </label>
            <input
              id={name}
              className="input"
              name={name}
              required={req}
              defaultValue={name === "serialNumber" ? serialNumber : undefined}
              list={
                name === "deviceCategory" ? "device-category-options"
                : name === "homeUnit" ? "home-unit-options"
                : undefined
              }
            />
          </div>
        ))}
        {/* Suggestions only — both fields stay free text. An unknown category is
            registered on save (the CSV import can introduce one, so the form
            must not be stricter); an unknown unit is not, because a Unit is
            keyed on an abbreviation a typed full name does not carry. */}
        <datalist id="device-category-options">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <datalist id="home-unit-options">
          {units.map((u) => <option key={u} value={u} />)}
        </datalist>
        <div className="field col-span-2">
          <label className="label" htmlFor="notes">Notes</label>
          <textarea id="notes" className="textarea" name="notes" placeholder="Optional details about this item" />
        </div>
      </div>
      {state?.error && (
        <p role="alert" className="alert-error">
          {state.error}
          {"existingItemId" in state && state.existingItemId && (
            <> <Link href={`/i/${state.existingItemId}`}>Open that item</Link></>
          )}
        </p>
      )}
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Saving…" : "Create item"}
        </button>
        <Link href="/items" className="btn btn-ghost">Cancel</Link>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Verify the whole app typechecks**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Verify nothing else broke**

Run: `npm run lint`
Expected: clean. Watch for `react/no-unescaped-entities` — if it fires, the fix is HTML entities, not deleting the text.

- [ ] **Step 4: Commit Tasks 5 and 6 together**

```bash
git add src/app/admin/items/new/page.tsx src/app/admin/items/new/NewItemForm.tsx
git commit -m "feat(items): the new-item form takes a prefilled serial, UIC and category

Opened with ?serialNumber=, the form prefills the serial and posts two hidden
fields so the action knows to return to the filtered list. Opened directly it
behaves exactly as before.

Adds UIC and category inputs — the category was previously unreachable from
this form, so a hand-created item started life outside the managed vocabulary.
Category and home unit both get a datalist of known values: suggesting the
existing spelling of a unit is what keeps a hand-typed homeUnit inside
renameUnit's backfill instead of drifting into a second spelling.

A duplicate serial now renders a link to the item that already holds it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The empty-state affordance

**Files:**
- Modify: `src/components/ItemSelectTable.tsx:295-301`
- Modify: `src/app/globals.css` (add `.truncate-inline`)
- Create: `src/components/ItemSelectTable.test.tsx`

**Interfaces:**
- Consumes: `isAdmin` and `q`, already props on this component (destructured `:40-41`, typed `:52-53`).
- Produces: nothing other tasks depend on.

**CSS, and why it is not a one-liner:** `.btn` is `display:inline-flex` with `white-space:nowrap` (`globals.css:333-350`). `text-overflow:ellipsis` on the button does nothing — the label is an anonymous flex item. It needs an inner `<span>` that is itself the overflow container. Untreated, a long serial forces the `.card` to overflow horizontally on a phone. This goes in `globals.css` (the legacy system), NOT Tailwind — see the Global Constraints.

- [ ] **Step 1: Write the failing component test**

Create `src/components/ItemSelectTable.test.tsx`. Its FIRST line must be the jsdom pragma — the suite is node-environment by default and opts in per file:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ItemSelectTable } from "./ItemSelectTable";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/items",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/admin/actions/items", () => ({ toggleItemStatusAction: vi.fn() }));

function renderEmpty(props: Partial<Parameters<typeof ItemSelectTable>[0]> = {}) {
  return render(
    <ItemSelectTable
      items={[]}
      isAdmin
      q="ABC123"
      sort="deviceName"
      dir="asc"
      page={1}
      totalPages={1}
      sortKeys={[]}
      uic=""
      uics={[]}
      categories={[]}
      {...props}
    />,
  );
}

describe("ItemSelectTable — empty state", () => {
  it("offers an admin a prefilled create link for the searched text", () => {
    renderEmpty();
    const link = screen.getByRole("link", { name: /create .*ABC123.* as a new item/i });
    expect(link).toHaveAttribute("href", "/admin/items/new?serialNumber=ABC123");
  });

  it("carries the active unit filter into the link", () => {
    renderEmpty({ uic: "WABC01" });
    expect(screen.getByRole("link", { name: /as a new item/i }))
      .toHaveAttribute("href", "/admin/items/new?serialNumber=ABC123&uic=WABC01");
  });

  it("percent-encodes a searched value containing URL metacharacters", () => {
    renderEmpty({ q: "A&B C" });
    expect(screen.getByRole("link", { name: /as a new item/i }))
      .toHaveAttribute("href", "/admin/items/new?serialNumber=A%26B%20C");
  });

  it("offers nothing to a non-admin", () => {
    renderEmpty({ isAdmin: false });
    expect(screen.queryByRole("link", { name: /as a new item/i })).toBeNull();
  });

  // A UIC-only empty result gives us nothing to prefill and no evidence the
  // admin was hunting a specific device.
  it("offers nothing when the search box is empty", () => {
    renderEmpty({ q: "   ", uic: "WABC01" });
    expect(screen.queryByRole("link", { name: /as a new item/i })).toBeNull();
  });

  it("still shows the plain message", () => {
    renderEmpty();
    expect(screen.getByText(/No items match/i)).toBeTruthy();
  });
});
```

If `@testing-library/react` or `@testing-library/jest-dom` is not already a devDependency, check how `src/components/ContactCombobox.test.tsx` renders and match it exactly rather than adding a package.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ItemSelectTable.test.tsx`
Expected: FAIL — no link is rendered.

- [ ] **Step 3: Add the affordance**

Replace the empty-state block at `src/components/ItemSelectTable.tsx:295-301`:

```tsx
      {/* Rendered below the toolbar, so the controls that produced an empty
          result stay on screen and the filter can be undone. */}
      {items.length === 0 && (
        <div className="card empty stack">
          <div>No items match {uic ? "this unit and " : ""}your search.</div>
          {/* Admin-only because creation is admin-only (createItemAction calls
              requireAdmin) — the server check is the authority, this is
              presentation. Deliberately NOT suppressed while a uic filter is
              active: q + uic can return nothing for an item that exists under a
              DIFFERENT uic, so this can be clicked for a serial already in the
              book. That is accepted — the action's P2002 branch names the
              collision and links to the item — because an admin filtered to a
              unit may legitimately be adding a device. */}
          {isAdmin && q.trim() && (
            <Link
              href={`/admin/items/new?serialNumber=${encodeURIComponent(q.trim())}${uic ? `&uic=${encodeURIComponent(uic)}` : ""}`}
              className="btn btn-secondary btn-sm"
            >
              <span className="truncate-inline">
                + Create &ldquo;{q.trim()}&rdquo; as a new item
              </span>
            </Link>
          )}
        </div>
      )}
```

`Link` is already imported in this file (`:9` region — verify).

- [ ] **Step 4: Add the CSS helper**

Append to `src/app/globals.css`, near the other utility classes:

```css
/* Truncate a label INSIDE a .btn. `.btn` is inline-flex with white-space:nowrap,
   so text-overflow on the button itself does nothing — the label is an anonymous
   flex item with no box to clip. This gives it one. Without it a long serial in
   the /items empty-state create button overflows the card horizontally on a
   phone. */
.truncate-inline {
  min-width: 0;
  max-width: 22rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/ItemSelectTable.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/ItemSelectTable.tsx src/components/ItemSelectTable.test.tsx src/app/globals.css
git commit -m "feat(items): create a missing item straight from the search empty state

A search that finds nothing was a dead end — the only way forward was to notice
the button at the top of the page, navigate away, and retype the serial. The
empty state now offers admins a prefilled create link.

Not suppressed while a unit filter is active, because an admin filtered to a
unit may legitimately be adding a device; the action's duplicate-serial branch
handles the case where the item exists under a different UIC.

The label needs an inner span to truncate: .btn is inline-flex with nowrap, so
text-overflow on the button clips nothing and a long serial would overflow the
card on a phone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Docs, guardrails, and real-browser verification

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-30-create-item-from-search-design.md` (§5's test-placement claim)

- [ ] **Step 1: Append to `CHANGELOG.md`**

A `## 2026-07-30` section already exists with `### Added` and `### Fixed`. Append to those existing subsections — do NOT create a second `## 2026-07-30` heading.

Under `### Added`:

```markdown
- **A search that finds nothing can now create the item.** When an admin searches the items list and nothing matches, the empty state offers to log that device — opening the new-item form with the searched text already filled in as the serial, and returning to the same filtered search afterwards so the new row is visible. The new-item form also gained UIC and Category fields, and suggests the unit and category names already in use.
```

Under `### Fixed`:

```markdown
- **Logging a new item no longer silently drops its category, and says so when the serial is taken.** A category typed on the new-item form now joins the managed category list instead of leaving the device holding a value that appeared in no picker, and the items list is refreshed so a newly created item is not missing from it. Creating an item whose serial already exists used to fail with a generic error; it now names the serial and links to the item that already has it.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Find the line reading **"Normalization now runs at FOUR write sites"** (in the categories section) and update it to five, naming the create form:

```markdown
  * **Normalization now runs at FIVE write sites** — CSV import, the admin edit page, the item card, the bulk selection-bar control, and the new-item form — and all five call `normalizeCategoryName` (from the pure `items.schema.ts`, never the `server-only` service) and then `learnCategories`. Miss either half at a new write site and you get the exact drift this design exists to prevent: an item holding a string that matches no vocabulary row, so the in-use count under-reports and an admin can delete a category still in use.
```

In the same section, after the `categoryOptional` / `categoryClearable` bullet, add the third variant:

```markdown
  * **`categoryNew` is the CREATE form's variant** — blank → `undefined` like `categoryOptional` (a row that does not exist yet has no value to clear, and `""` in an indexed column is a value every filter counts), but over-long names are *rejected* like `categoryClearable`. Its trailing `.optional()` is load-bearing: `createItem` re-parses its own input at the service boundary, so the schema must accept its own output.
```

- [ ] **Step 3: Correct two claims in the spec**

Implementation proved two of the spec's statements wrong. Fix both in
`docs/superpowers/specs/2026-07-30-create-item-from-search-design.md`:

1. **§5's "NEW FILE" instruction.** `createItemAction`'s tests live in the
   existing `src/app/actions/items.test.ts`, which already imports and tests
   `updateItemIdentityAction` from the admin actions module and carries every
   mock needed. No new test file.
2. **§4's claim that `src/modules/items/items.service.ts` is not touched.** It
   is — `getItemBySerial` was added there for the P2002 branch's link. Add it
   to the files table.

- [ ] **Step 4: Run the security-docs guardrail**

Run: `npm run check:security-docs`
Expected: "no security-relevant files changed". If it FAILS, a watched file was touched — update `docs/SECURITY.md` rather than reaching for `[skip security-doc]`.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. You are the only agent on the shared test database; do not run this concurrently with anything else.

- [ ] **Step 6: Build**

Run: `npm run build && npm run lint`
Expected: clean. Remember this proves nothing about the CSS — Step 7 does.

- [ ] **Step 7: Verify in a real browser**

`npm run dev`, sign in as an admin, then:

1. `/items` → search a serial that does not exist → the create button appears, showing the searched text.
2. Click it → the new-item form opens with the serial prefilled.
3. Type a category not in the list → save → you land on `/items?q=<serial>` with the new row visible.
4. `/admin/categories` → the typed category is registered.
5. Repeat with a unit filter active → confirm you return with the filter intact.
6. Search an EXISTING serial while filtered to a unit that does not hold it → create → confirm the error names the serial and the "Open that item" link works.
7. **At a phone width (≤400px), search a 40-character string** → confirm the button truncates with an ellipsis and the card does not scroll horizontally, and that the button is at least 44px tall.
8. Sign in as a non-admin `USER` → search for nothing → confirm no create button.

- [ ] **Step 8: Commit**

```bash
git add CHANGELOG.md CLAUDE.md docs/superpowers/specs/2026-07-30-create-item-from-search-design.md
git commit -m "docs: record the create-from-search flow and the fifth category write site

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Open the PR**

```bash
git push -u origin docs/create-item-from-search
gh pr create --base main \
  --title "feat(items): create an item from the /items search empty state" \
  --body "$(cat <<'BODY'
When an admin's item search finds nothing, the empty state now offers to log
that device — opening the new-item form with the searched text prefilled as the
serial, and returning to the same filtered search afterwards so the new row is
visible.

Three pre-existing gaps on the create path had to close first, all of them
reachable once an item can be created straight from a failed search:

- A category typed on the form was stripped by `z.object()` and never joined the
  managed vocabulary.
- Nothing was revalidated, so the list an admin returned to could omit the item.
- A duplicate serial was an unhandled throw. It now names the serial and links
  to the item that already holds it.

Spec: `docs/superpowers/specs/2026-07-30-create-item-from-search-design.md`
Plan: `docs/superpowers/plans/2026-07-30-create-item-from-search.md`

No migration. `deviceUIC` and `deviceCategory` are existing nullable columns.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

`main` requires all three checks green: `Semgrep SAST`, `Build (next build)`, `Security docs current`. Note the repo's `xhigh` review marker convention before pushing — run `/code-review xhigh` and record `git rev-parse HEAD > .git/xhigh-review-ok`.

---

## Notes for the implementer

- **No migration.** `deviceUIC` and `deviceCategory` are existing nullable columns on `Item`; this only makes them reachable from a form that did not render them.
- **A hand-typed `homeUnit` is not permanent.** The CSV importer is the source of truth for a matched row's `homeUnit` and overwrites it on every import that carries one. This is documented behavior, not a bug you introduced.
- **If a test in `src/app/actions/items.test.ts` starts failing in an unrelated `describe`,** you probably changed a shared mock's shape in Task 3 Step 1. The `items.service` mock factory declares several functions solely because the admin actions module names them at import time.
