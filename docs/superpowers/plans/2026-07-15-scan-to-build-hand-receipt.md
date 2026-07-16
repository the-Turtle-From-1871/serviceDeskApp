# Scan to Build a Hand Receipt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator start a hand receipt from an item's page and then fill it by scanning more QR codes with the phone camera, without losing work already entered.

**Architecture:** The builder's item list moves from a fixed server prop into client state, seeded from the existing `?items=` URL param and kept in sync with it via `replaceState`. Scans decode to an item URL, are parsed to a cuid client-side, and resolve through a new `lookupScannedItem` server action. Nothing navigates, so the drawn signature and typed fields survive — which is the entire point.

**Tech Stack:** Next.js 16.2.9 (App Router, RSC), React 19.2.4, TypeScript 5, Vitest 4 (`node` default, `jsdom` opt-in per file), Testing Library, `barcode-detector@^3` (ponyfill of the standard `BarcodeDetector` API, backed by `zxing-wasm`).

**Spec:** `docs/superpowers/specs/2026-07-15-scan-to-build-hand-receipt-design.md`

## Global Constraints

- **Auth first in every server action:** `const user = await requireUser();` before any data access. Catch `AuthError` and return a code — do not let it escape to the client.
- **Never return a whole Prisma `Item` to the client.** `Item.notes` is admin-only; `i/[itemId]/page.tsx:59-65` gates it server-side precisely because client-component props are serialized into the RSC payload. Return an explicit field subset.
- **The server remains authoritative.** `createTransfer` re-validates every posted item (`ITEM_NOT_FOUND`, `ITEM_RETIRED`, `TOO_MANY_LINES`, `TOO_MANY_PER_ROW` — `app/actions/receipts.ts:101-109`). Client checks are UX, not enforcement.
- **Validate any new package with `npm view <name>` before installing.** Already done for `barcode-detector` (3.2.1, published 2026-07-12).
- **No inline `justifyContent` in table cells.** Use `.actions` / `.actions--end`. Inline styles outrank the mobile re-alignment rule — `a08d9e5` fixed exactly this bug three times.
- **Every new `<td>` needs `data-label`.** `globals.css:920-993` builds the mobile card from it. Use `data-label=""` for a cell with no label (`globals.css:952`). Multi-child cells need `.is-stacked` or their children collide.
- **`npm test` runs DB-backed integration tests against a shared database.** Two agents running it concurrently truncate each other and it looks like flakiness in unrelated files. Prefer `npm run test:ui` and targeted single-file runs while working.
- **Limits:** `MAX_RECEIPT_ROWS = 18`, `MAX_ITEMS_PER_ROW = 10` (`modules/transfers/receipt-lines.ts:1-2`). Import them; never re-type the numbers.
- **Copy is fixed by the spec.** Use the exact refusal strings in Task 9's table.

---

## File Structure

**Create:**
- `src/modules/items/scan-url.ts` — pure: decoded text → itemId. No DOM, no network.
- `src/modules/items/scan-url.test.ts` — node.
- `src/app/actions/scan.ts` — `lookupScannedItem` server action.
- `src/app/actions/scan.test.ts` — node, services mocked.
- `src/components/QrScanner.tsx` — camera + decode loop. Knows nothing of items.
- `src/lib/beep.ts` — audio feedback.

**Modify:**
- `src/app/i/[itemId]/page.tsx` — the entry-point button.
- `src/app/receipts/new/page.tsx:57-76` — pass `initialItems` instead of `itemIds`/`lines`.
- `src/app/receipts/new/ReceiptBuilderForm.tsx` — client-owned items, lifted qty/service, signature invalidation, scan wiring.
- `src/app/receipts/new/ReceiptBuilderForm.test.tsx` — extend.
- `src/app/globals.css` — scanner sheet only.

**Boundary note:** `QrScanner` emits strings; the builder decides what they mean. Keep it that way — it's what makes the decode loop testable without the builder, and reusable for the returns flow later.

---

### Task 1: Entry-point button on the item page

Independently shippable. Nothing else depends on it.

**Files:**
- Modify: `src/app/i/[itemId]/page.tsx:38-49`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. The builder's `?items=` contract already exists (`receipts/new/page.tsx:11-20`).

- [ ] **Step 1: Add the button under the title row**

In `src/app/i/[itemId]/page.tsx`, immediately after the closing `</div>` of the title `.row` (currently line 49) and before the `{loggedIn && (<ItemDetailsCard ...` block:

```tsx
        {/* Gated on ACTIVE as well as auth: the builder filters retired items out
            on load (receipts/new/page.tsx:17), so offering the button for one
            would hand the operator a dead end. `?items=` is the builder's
            existing contract — no new plumbing. */}
        {loggedIn && item.status === "ACTIVE" && (
          <div className="row">
            <Link className="btn btn-primary" href={`/receipts/new?items=${item.id}`}>
              Create hand receipt
            </Link>
          </div>
        )}
```

`Link` is already imported at line 1.

- [ ] **Step 2: Verify in a browser**

There is deliberately no unit test here: the page is an async Server Component, Testing Library cannot render it, and a test asserting an `href` string would only restate the code. The honest check is the real thing.

```bash
npm run dev
```

Visit an item page for an ACTIVE item while logged in. Confirm: the button renders; it opens `/receipts/new?items=<that id>`; the builder shows that one item. Then visit a RETIRED item and confirm the button is absent. Log out and confirm it is absent.

- [ ] **Step 3: Commit**

```bash
git add src/app/i/[itemId]/page.tsx
git commit -m "feat(items): start a hand receipt from the item page"
```

---

### Task 2: The scan-URL parser

**Files:**
- Create: `src/modules/items/scan-url.ts`
- Create: `src/modules/items/scan-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseItemScan(text: string): string | null` — returns the item id, or `null` if the text is not one of our item URLs.

- [ ] **Step 1: Write the failing test**

Create `src/modules/items/scan-url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseItemScan } from "./scan-url";

const ID = "clx3k9v2p0001abcd1234efgh";

describe("parseItemScan", () => {
  it("reads the id from a production sticker", () => {
    expect(parseItemScan(`https://servicedeskapp.vercel.app/i/${ID}`)).toBe(ID);
  });

  // The origin baked into a sticker is whatever defaultBaseUrl() resolved to at
  // PRINT time (lib/base-url.ts:5-9). These three cases are why we match on the
  // PATH: origin-strict matching would reject stickers that are physically on
  // hardware right now.
  it("reads the id from a sticker printed on a preview deploy", () => {
    expect(parseItemScan(`https://app-git-feat-x.vercel.app/i/${ID}`)).toBe(ID);
  });

  it("reads the id from a sticker printed before a domain change", () => {
    expect(parseItemScan(`https://old-domain.example/i/${ID}`)).toBe(ID);
  });

  it("reads the id from a bare path (printed from local dev, no APP_URL)", () => {
    // defaultBaseUrl() returns "" with neither APP_URL nor a Vercel env, so
    // itemUrl() emits `/i/{cuid}` with no scheme or host at all.
    expect(parseItemScan(`/i/${ID}`)).toBe(ID);
  });

  it("tolerates a trailing slash and a query string", () => {
    expect(parseItemScan(`https://x.example/i/${ID}/`)).toBe(ID);
    expect(parseItemScan(`https://x.example/i/${ID}?utm=1`)).toBe(ID);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseItemScan(`  https://x.example/i/${ID}  `)).toBe(ID);
  });

  it("rejects a Wi-Fi QR", () => {
    // Parses as a URL with protocol "wifi:" — so the reject must come from the
    // PATH shape, not from URL parsing failing.
    expect(parseItemScan("WIFI:S:GuestNet;T:WPA;P:hunter2;;")).toBeNull();
  });

  it("rejects a receipt URL", () => {
    expect(parseItemScan("https://x.example/receipts/HR-2026-0001")).toBeNull();
  });

  it("rejects a nested path that merely contains /i/", () => {
    expect(parseItemScan(`https://x.example/admin/i/${ID}`)).toBeNull();
  });

  it("rejects a bare serial number, plain text, and empty input", () => {
    expect(parseItemScan("7X4K2L9")).toBeNull();
    expect(parseItemScan("hello world")).toBeNull();
    expect(parseItemScan("")).toBeNull();
    expect(parseItemScan("   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run src/modules/items/scan-url.test.ts
```

Expected: FAIL — `Failed to resolve import "./scan-url"`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/items/scan-url.ts`:

```ts
// Decoded QR text -> item id. Pure: no DOM, no network, no Prisma.
//
// Matches on the PATH and ignores the origin, deliberately. A sticker carries
// whatever defaultBaseUrl() resolved to when it was PRINTED (lib/base-url.ts:5-9):
// APP_URL, else Vercel's injected domain, else "" — which prints a bare
// `/i/{cuid}` with no origin at all. Origin-strict matching would reject
// stickers printed from a preview deploy, from local dev, or before a domain
// change, all of which are physically on hardware.
//
// This is not a security relaxation. The origin was never the check that
// mattered: lookupScannedItem calls requireUser() and resolves the id against
// the database. An id from a wrong-origin sticker either names a real item the
// caller may see, or it does not exist.
//
// The charset is permissive (cuid is [a-z0-9], but uuid has dashes) — the path
// SHAPE is what rejects a foreign code; the DB is what rejects a bad id.
const ITEM_PATH = /^\/i\/([A-Za-z0-9_-]+)\/?$/;

export function parseItemScan(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;

  let path: string;
  try {
    // Drops any query/hash for free, and yields a non-matching pathname for
    // foreign schemes like `wifi:` (which DOES parse as a URL).
    path = new URL(raw).pathname;
  } catch {
    // Not absolute — this is the bare-path case a local-dev sticker carries.
    path = raw;
  }

  return ITEM_PATH.exec(path)?.[1] ?? null;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
npx vitest run src/modules/items/scan-url.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/scan-url.ts src/modules/items/scan-url.test.ts
git commit -m "feat(scan): parse an item id out of a scanned QR, by path not origin"
```

---

### Task 3: The `lookupScannedItem` server action

**Files:**
- Create: `src/app/actions/scan.ts`
- Create: `src/app/actions/scan.test.ts`

**Interfaces:**
- Consumes: `getItem` (`modules/items/items.service.ts:15`), `getLastReceiver` (`modules/transfers/transfers.service.ts:139`), `requireUser`/`AuthError` (`lib/authz`).
- Produces:

```ts
export type ScanLookup =
  | { ok: true; item: { id: string; make: string; model: string; serialNumber: string }; holderName: string | null }
  | { ok: false; code: "NOT_FOUND" | "RETIRED" | "UNAUTHORIZED" | "FAILED" };

export async function lookupScannedItem(itemId: string): Promise<ScanLookup>;
```

- [ ] **Step 1: Write the failing test**

Server-action tests in this repo mock the services rather than touching the DB — follow `src/app/actions/receipts.test.ts:1-35`. Create `src/app/actions/scan.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const getItem = vi.fn();
const getLastReceiver = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/items/items.service", () => ({
  getItem: (id: string) => getItem(id),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getLastReceiver: (id: string) => getLastReceiver(id),
}));

import { lookupScannedItem } from "./scan";
import { AuthError } from "@/lib/authz";

const ITEM = {
  id: "i1",
  make: "Dell",
  model: "L5420",
  serialNumber: "SN1",
  status: "ACTIVE",
  notes: "ADMIN ONLY — do not leak",
  homeUnit: "A Co",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "USER", name: "Op" });
  getItem.mockResolvedValue(ITEM);
  getLastReceiver.mockResolvedValue(null);
});

describe("lookupScannedItem", () => {
  it("returns the item's display fields", async () => {
    const res = await lookupScannedItem("i1");
    expect(res).toEqual({
      ok: true,
      item: { id: "i1", make: "Dell", model: "L5420", serialNumber: "SN1" },
      holderName: null,
    });
  });

  // Client-component props are serialized into the RSC payload and reach the
  // browser regardless of what renders. i/[itemId]/page.tsx:59-65 gates notes
  // server-side for this exact reason; returning the whole Item here would
  // undo that for every scan.
  it("never returns admin-only fields", async () => {
    const res = await lookupScannedItem("i1");
    expect(JSON.stringify(res)).not.toContain("ADMIN ONLY");
    expect(res.ok && "notes" in res.item).toBe(false);
  });

  it("names the current holder when there is one", async () => {
    getLastReceiver.mockResolvedValue({ isDcsim: false, name: "CPL Jones" });
    const res = await lookupScannedItem("i1");
    expect(res).toMatchObject({ ok: true, holderName: "CPL Jones" });
  });

  it("refuses an unknown id", async () => {
    getItem.mockResolvedValue(null);
    expect(await lookupScannedItem("nope")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  // Mirrors receipts/new/page.tsx:17 — a scan must not be a backdoor around the
  // ACTIVE filter the builder already applies on load.
  it("refuses a retired item", async () => {
    getItem.mockResolvedValue({ ...ITEM, status: "RETIRED" });
    expect(await lookupScannedItem("i1")).toEqual({ ok: false, code: "RETIRED" });
  });

  it("checks auth before touching any data", async () => {
    requireUser.mockRejectedValue(new AuthError("UNAUTHORIZED"));
    expect(await lookupScannedItem("i1")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(getItem).not.toHaveBeenCalled();
  });

  it("returns FAILED and logs on an unexpected error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getItem.mockRejectedValue(new Error("db is on fire"));
    expect(await lookupScannedItem("i1")).toEqual({ ok: false, code: "FAILED" });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("refuses blank input without a query", async () => {
    expect(await lookupScannedItem("  ")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(getItem).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npx vitest run src/app/actions/scan.test.ts
```

Expected: FAIL — `Failed to resolve import "./scan"`.

- [ ] **Step 3: Write the implementation**

Create `src/app/actions/scan.ts`:

```ts
"use server";
import { requireUser, AuthError } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { getLastReceiver } from "@/modules/transfers/transfers.service";

export type ScanLookup =
  | { ok: true; item: { id: string; make: string; model: string; serialNumber: string }; holderName: string | null }
  | { ok: false; code: "NOT_FOUND" | "RETIRED" | "UNAUTHORIZED" | "FAILED" };

// Resolves a scanned item id for the hand-receipt builder. Any ACTIVE
// authenticated user may look one up — inventory is shared org-wide, matching
// updateItemDetailsAction's reasoning (app/actions/items.ts:8-10).
export async function lookupScannedItem(itemId: string): Promise<ScanLookup> {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, code: "UNAUTHORIZED" };
    throw e;
  }

  const id = itemId.trim();
  if (!id) return { ok: false, code: "NOT_FOUND" };

  try {
    const item = await getItem(id);
    if (!item) return { ok: false, code: "NOT_FOUND" };
    // Mirrors receipts/new/page.tsx:17. A scan must not be a backdoor around
    // the ACTIVE filter the builder applies on load.
    if (item.status !== "ACTIVE") return { ok: false, code: "RETIRED" };

    const holder = await getLastReceiver(item.id);

    // An explicit subset, NOT the Prisma row. This value becomes a client
    // component's state, so it is serialized into the RSC payload and reaches
    // the browser whatever the UI renders — `item.notes` is admin-only and
    // gated server-side for exactly that reason (i/[itemId]/page.tsx:59-65).
    return {
      ok: true,
      item: { id: item.id, make: item.make, model: item.model, serialNumber: item.serialNumber },
      holderName: holder?.name ?? null,
    };
  } catch (e) {
    console.error("[lookupScannedItem] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
npx vitest run src/app/actions/scan.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/scan.ts src/app/actions/scan.test.ts
git commit -m "feat(scan): resolve a scanned item id server-side"
```

---

### Task 4: The builder owns its item list

The load-bearing refactor. No scanning yet — this task only moves ownership and adds removal, so it can be reviewed on its own.

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx`
- Modify: `src/app/receipts/new/page.tsx:57-76`
- Modify: `src/app/receipts/new/ReceiptBuilderForm.test.tsx`

**Interfaces:**
- Consumes: `groupItemsIntoLines`, `type LineItem`, `MAX_RECEIPT_ROWS`, `MAX_ITEMS_PER_ROW` from `@/modules/transfers/receipt-lines` (all pure, client-safe — no `server-only` import).
- Produces: `ReceiptBuilderForm` props become
  `{ initialItems: BuilderItem[]; senderPrefill?: Prefill; signatures: PickableSignature[]; contacts: ContactOption[] }`
  where `export type BuilderItem = LineItem & { holderName: string | null }`.
  The old `itemIds` and `lines` props are **removed**; `BuilderLine` is deleted.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/receipts/new/ReceiptBuilderForm.test.tsx`. First replace the `LINES` constant and `renderForm` helper (currently lines 38-44) with:

```tsx
const ITEMS = [
  { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
];

function renderForm(
  senderPrefill?: Parameters<typeof ReceiptBuilderForm>[0]["senderPrefill"],
  initialItems: Parameters<typeof ReceiptBuilderForm>[0]["initialItems"] = ITEMS,
) {
  return render(
    <ReceiptBuilderForm
      initialItems={initialItems}
      senderPrefill={senderPrefill}
      signatures={[]}
      contacts={[]}
    />
  );
}
```

Then append this describe block:

```tsx
describe("ReceiptBuilderForm — the item list is the form's own state", () => {
  const TWO = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "HP", model: "G8", serialNumber: "SN2", holderName: null },
  ];

  it("posts one itemId per item", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);
    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1", "i2"]);
  });

  it("removes an item and stops posting it", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    expect(screen.queryByText("SN2")).toBeNull();

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1"]);
  });

  // A receipt with no items is not a receipt, and an empty `?items=` would
  // notFound() on reload (receipts/new/page.tsx:15).
  it("will not let the last item be removed", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /Remove Dell L5420, serial SN1/i })).toBeDisabled();
  });

  // Keeps the URL recoverable after an iOS tab eviction. replaceState, not
  // pushState: a scan is not a history entry.
  it("keeps ?items= in step with the list", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(window.history, "replaceState");
    renderForm(undefined, TWO);

    await waitFor(() => expect(spy).toHaveBeenCalledWith(null, "", "?items=i1,i2"));

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(null, "", "?items=i1"));
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm run test:ui
```

Expected: FAIL — the `initialItems` prop does not exist, and there are no Remove buttons.

- [ ] **Step 3: Change the form's props and derive lines**

In `src/app/receipts/new/ReceiptBuilderForm.tsx`, replace the type exports at lines 12-13:

```tsx
import { groupItemsIntoLines, type LineItem } from "@/modules/transfers/receipt-lines";

// `holderName` is the item's current holder, used to warn when a scan brings in
// equipment held by someone other than the sender on the form. It rides along
// with the item because groupItemsIntoLines only carries ids and serials.
export type BuilderItem = LineItem & { holderName: string | null };
```

Delete the `BuilderLine` type. Replace the component signature (line 214) and add state:

```tsx
export function ReceiptBuilderForm({ initialItems, senderPrefill, signatures, contacts }: {
  initialItems: BuilderItem[];
  senderPrefill?: Prefill;
  signatures: PickableSignature[];
  contacts: ContactOption[];
}) {
  const [state, action, pending] = useActionState(createReceiptAction, undefined);
  // The item list is now the form's own state, seeded from the URL. It must NOT
  // go back to being a prop: re-deriving it from `?items=` on each change would
  // remount this component and discard the drawn signature and every typed
  // field — the exact bug class the comments above already exist to prevent.
  const [items, setItems] = useState<BuilderItem[]>(initialItems);
  const lines = useMemo(() => groupItemsIntoLines(items), [items]);
```

Add `useMemo` to the React import on line 2.

- [ ] **Step 4: Keep `?items=` in sync**

Add below the state declarations:

```tsx
  // Keep the URL in step so a reload rebuilds the same list. This restores
  // PARITY with today (where items survive a refresh because they come from the
  // URL) rather than adding a feature — and it matters most on the device this
  // targets: iOS Safari evicts background tabs, and a page holding a live
  // camera plus a WASM decoder is a prime candidate. A reload here is the
  // operator switching apps for ten seconds, not fat-fingering refresh.
  //
  // replaceState, NOT pushState: a scan is not a history entry. Back must leave
  // the builder, not un-scan one laptop at a time. Next 16 integrates the
  // native History API with its router — see
  // node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md
  useEffect(() => {
    if (items.length === 0) return; // `?items=` empty would notFound() on reload
    window.history.replaceState(null, "", `?items=${items.map((i) => i.itemId).join(",")}`);
  }, [items]);

  const removeItem = (itemId: string) => setItems((prev) => prev.filter((i) => i.itemId !== itemId));
```

- [ ] **Step 5: Render from derived lines, and add the Remove column**

Replace the hidden item inputs (line 251):

```tsx
      {items.map((it) => <input key={it.itemId} type="hidden" name="itemId" value={it.itemId} />)}
```

Replace the `<thead>` (line 256) — the new column has an empty header because the buttons name themselves:

```tsx
            <thead><tr><th>#</th><th>Item</th><th>Serial</th><th>Service</th><th>Auth</th><th>Issued</th><th></th></tr></thead>
```

Replace the `<tbody>` contents. Note `ln.serials[k]` / `ln.itemIds[k]` — `groupItemsIntoLines` returns parallel arrays (`receipt-lines.ts:6-14`), not objects:

```tsx
            <tbody>
              {lines.map((ln, i) => (
                <Fragment key={`${ln.make} ${ln.model}`}>
                  {ln.itemIds.map((itemId, k) => (
                    <tr key={itemId}>
                      {k === 0 ? (
                        <>
                          <td data-label="Line">{i + 1}</td>
                          <td data-label="Item">{ln.make} {ln.model}
                            <input type="hidden" name={`line[${i}][make]`} value={ln.make} />
                            <input type="hidden" name={`line[${i}][model]`} value={ln.model} />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="is-empty"></td>
                          <td className="is-empty"></td>
                        </>
                      )}
                      <td className="mono" data-label="Serial">{ln.serials[k]}</td>
                      <td className="is-stacked" data-label="Service"><ServiceControls itemId={itemId} /></td>
                      {k === 0 && (
                        <>
                          {/* rowSpan stays. The quantities are per LINE, not per serial —
                              one pair of inputs covers every serial of this make/model.
                              Splitting them per row would emit duplicate
                              `line[i][qtyAuth]` fields and change what the form submits. */}
                          <td rowSpan={ln.itemIds.length} data-label={ln.itemIds.length > 1 ? `Qty authorized (all ${ln.itemIds.length} serials)` : "Qty authorized"}>
                            <QtyInput name={`line[${i}][qtyAuth]`} defaultQty={ln.defaultQty} label={`Quantity authorized, ${ln.make} ${ln.model}`} />
                          </td>
                          <td rowSpan={ln.itemIds.length} data-label={ln.itemIds.length > 1 ? `Qty issued (all ${ln.itemIds.length} serials)` : "Qty issued"}>
                            <QtyInput name={`line[${i}][qtyIssued]`} defaultQty={ln.defaultQty} label={`Quantity issued, ${ln.make} ${ln.model}`} />
                          </td>
                        </>
                      )}
                      {/* `.actions--end`, never an inline justifyContent — an inline style
                          outranks the mobile rule that re-aligns actions inside a stacked
                          card, which is the bug a08d9e5 fixed in three places. */}
                      <td className="actions actions--end" data-label="">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => removeItem(itemId)}
                          disabled={items.length === 1}
                          aria-label={`Remove ${ln.make} ${ln.model}, serial ${ln.serials[k]}`}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
```

The `<legend>` at line 253 keeps working — `lines.length` is still in scope.

- [ ] **Step 6: Update the page to pass `initialItems`**

In `src/app/receipts/new/page.tsx`, replace lines 57-64 (the `itemIds` and `lines` props) with:

```tsx
          <ReceiptBuilderForm
            initialItems={loaded.map((i, k) => ({
              itemId: i.id,
              make: i.make,
              model: i.model,
              serialNumber: i.serialNumber,
              // The item's CURRENT holder, already fetched at line 34
              // (`lastReceivers`, index-aligned with `loaded`). Do NOT hardcode
              // null: `senderPrefill` is derived from these items ONLY when every
              // holder matches (`allSame`, lines 38-41) — when holders DIFFER the
              // prefill is undefined and the operator types a sender that can
              // absolutely disagree with them. And `replaceState` now feeds every
              // SCANNED item back into `?items=`, so a mixed-holder list reaches
              // this page through the URL on an iOS reload — exactly the reload
              // the sync exists to survive. Discarding holderName here would drop
              // the spec's persistent warning on precisely that path.
              holderName: lastReceivers[k]?.name ?? null,
            }))}
```

Leave `senderPrefill`, `signatures`, and `contacts` as they are. The `lines` local (line 20) stays — the `tooMany` / `tooManyPerRow` server gate still uses it. `lastReceivers` already exists (line 34); no new fetch.

- [ ] **Step 7: Run the tests**

```bash
npm run test:ui
npx tsc --noEmit
```

Expected: PASS. The five pre-existing tests must still pass — if the DCSIM or typed-quantity tests broke, the refactor regressed a fix that already shipped; stop and repair rather than editing those tests.

- [ ] **Step 8: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx src/app/receipts/new/ReceiptBuilderForm.test.tsx src/app/receipts/new/page.tsx
git commit -m "refactor(receipts): the builder owns its item list, and items can be removed"
```

---

### Task 5: Quantities track the item count (defect #1)

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx` (`QtyInput`, lines 131-154)
- Modify: `src/app/receipts/new/ReceiptBuilderForm.test.tsx`

**Interfaces:**
- Consumes: `lines` and `items` state from Task 4.
- Produces: `QtyInput` signature becomes `{ name: string; value: string; onChange: (v: string) => void; label: string }` — `defaultQty` is gone from it.

- [ ] **Step 1: Write the failing test**

Append to `ReceiptBuilderForm.test.tsx`:

```tsx
describe("ReceiptBuilderForm — quantities track the item count", () => {
  const auth = () => screen.getByLabelText("Quantity authorized, Dell L5420") as HTMLInputElement;
  const issued = () => screen.getByLabelText("Quantity issued, Dell L5420") as HTMLInputElement;

  const TWO_SAME = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "Dell", model: "L5420", serialNumber: "SN2", holderName: null },
  ];

  // The defect: QtyInput used to seed its state once from defaultQty. With a
  // growable list that leaves the line holding two serials while Issued still
  // reads 1 — a custody document filed for the wrong count.
  it("shows the item count for an untouched line", () => {
    renderForm(undefined, TWO_SAME);
    expect(auth().value).toBe("2");
    expect(issued().value).toBe("2");
  });

  it("drops to the new count when an item is removed", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);
    expect(issued().value).toBe("2");

    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN2/i }));
    expect(issued().value).toBe("1");
  });

  // An explicitly typed quantity is the operator's, and outranks the count.
  it("leaves an edited quantity alone when the list changes", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);

    await user.clear(auth());
    await user.type(auth(), "5");
    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN2/i }));

    expect(auth().value).toBe("5");
    expect(issued().value).toBe("1"); // untouched, so it still tracks
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:ui
```

Expected: FAIL — `expect(auth().value).toBe("2")` receives `"1"`, because `QtyInput` froze its seed at mount.

- [ ] **Step 3: Make `QtyInput` fully controlled**

Replace `QtyInput` (lines 131-154):

```tsx
// Controlled by the FORM, not by itself. Two reasons, both load-bearing:
//
// 1. React resets the form after any settled action, including a failed one. An
//    uncontrolled qty snapped a typed value back to its default, so the
//    operator fixed the real error, resubmitted, and filed the wrong count.
//    (Verified by ReceiptBuilderForm.test.tsx.)
// 2. The value must TRACK the line's item count while untouched. Seeding state
//    from defaultQty froze it at mount — fine when the list could not change,
//    wrong the moment a scan can grow a line.
//
// `label` is announced via aria-label: the column's <th> orients a sighted user
// but gives the input no accessible name.
function QtyInput({ name, value, onChange, label }: { name: string; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input
      className="input"
      style={{ width: 72 }}
      type="number"
      min={1}
      name={name}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required
    />
  );
}
```

- [ ] **Step 4: Hold the overrides in the form**

Add to `ReceiptBuilderForm`, below `removeItem`:

```tsx
  // Keyed by line (make+model), matching how groupItemsIntoLines groups. An
  // ABSENT entry means "untouched" and renders the live item count; a present
  // one is the operator's explicit value and wins from then on. Storing only
  // overrides is what makes tracking-until-edited fall out for free.
  const [qtyEdits, setQtyEdits] = useState<Record<string, { auth?: string; issued?: string }>>({});
  const lineKey = (ln: { make: string; model: string }) => `${ln.make} ${ln.model}`;
  const qtyValue = (ln: { make: string; model: string; defaultQty: number }, field: "auth" | "issued") =>
    qtyEdits[lineKey(ln)]?.[field] ?? String(ln.defaultQty);
  const setQty = (ln: { make: string; model: string }, field: "auth" | "issued", v: string) =>
    setQtyEdits((prev) => ({ ...prev, [lineKey(ln)]: { ...prev[lineKey(ln)], [field]: v } }));

  // Drop overrides for a make/model no longer on the receipt. Without this,
  // removing every item of a type and then re-scanning it resurrects the old
  // edited count — the same wrong-count-on-a-custody-document class as defect
  // #1. Identity-guarded so it can't loop.
  useEffect(() => {
    const keys = new Set(lines.map(lineKey));
    setQtyEdits((prev) => {
      const kept = Object.entries(prev).filter(([k]) => keys.has(k));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [lines]);
```

- [ ] **Step 5: Wire the two call sites**

In the `<tbody>`, replace the two `QtyInput` elements:

```tsx
                          <td rowSpan={ln.itemIds.length} data-label={ln.itemIds.length > 1 ? `Qty authorized (all ${ln.itemIds.length} serials)` : "Qty authorized"}>
                            <QtyInput name={`line[${i}][qtyAuth]`} value={qtyValue(ln, "auth")} onChange={(v) => setQty(ln, "auth", v)} label={`Quantity authorized, ${ln.make} ${ln.model}`} />
                          </td>
                          <td rowSpan={ln.itemIds.length} data-label={ln.itemIds.length > 1 ? `Qty issued (all ${ln.itemIds.length} serials)` : "Qty issued"}>
                            <QtyInput name={`line[${i}][qtyIssued]`} value={qtyValue(ln, "issued")} onChange={(v) => setQty(ln, "issued", v)} label={`Quantity issued, ${ln.make} ${ln.model}`} />
                          </td>
```

- [ ] **Step 6: Run the tests**

```bash
npm run test:ui
```

Expected: PASS. The pre-existing "keeps a typed quantity after the server rejects" test must still pass — it now exercises the override path.

- [ ] **Step 7: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx src/app/receipts/new/ReceiptBuilderForm.test.tsx
git commit -m "fix(receipts): quantities track the item count until edited"
```

---

### Task 6: Regression-guard the row key that protects service flags (defect #2)

**No production change.** Defect #2 — removing a line's first item silently clearing a
surviving item's "Needs service?" flag — was caused by keying rows on the *line's first*
itemId. **Task 4 already fixed it** by keying every row on its OWN itemId
(`<tr key={itemId}>`), so the existing internal-state `ServiceControls` (which this task
deliberately leaves unchanged) stays mounted through a sibling's removal. Internal state is
in fact *safer* here than a lifted map: removing an item unmounts its controls, so a
remove-then-rescan starts from an honest default with no stale flag to resurrect.

This task adds the test that **pins that key**, so a later refactor can't silently
reintroduce the remount. There is no red step because there is no bug left to fix — this is
a characterization/regression test, and that is stated honestly rather than dressed up as
TDD-red. (An earlier draft lifted service state into the form here; that was redundant work
riding on a test that would have started green, and it was removed.)

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.test.tsx` only.

**Interfaces:** none. `ServiceControls` keeps its current signature `{ itemId: string }`.

- [ ] **Step 1: Add the regression test**

Append to `ReceiptBuilderForm.test.tsx`:

```tsx
describe("ReceiptBuilderForm — service flags survive a sibling's removal", () => {
  const TWO_SAME = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "Dell", model: "L5420", serialNumber: "SN2", holderName: null },
  ];

  // Guards Task 4's per-item row key. If a future change keys rows on the line's
  // first itemId again, removing SN1 remounts SN2's row and this goes red.
  // NOTE: getAllByRole("checkbox") also returns the two party DCSIM boxes, so
  // scope to the Needs-service accessible name — do not index a mixed list.
  it("keeps the surviving item's flag when the first item of its line is removed", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);

    const flags = () => screen.getAllByRole("checkbox", { name: /Needs service/i });
    expect(flags()).toHaveLength(2);
    await user.click(flags()[1]); // flag SN2 (the second item)
    expect((flags()[1] as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN1/i }));

    const left = flags();
    expect(left).toHaveLength(1);
    expect((left[0] as HTMLInputElement).checked).toBe(true);
  });

  it("posts the flag under the surviving item's id", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);

    await user.click(screen.getAllByRole("checkbox", { name: /Needs service/i })[1]);
    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN1/i }));
    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.get("service[i2][needs]")).toBe("on");
    expect(posted.get("service[i1][needs]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests — they should PASS immediately**

```bash
npm run test:ui
```

Expected: PASS. That is correct here — the fix already shipped in Task 4, and these tests
guard it. If either FAILS, Task 4's row key regressed; fix the key, not the test.

To prove the guard actually bites (optional, recommended once): temporarily change the row
key in `ReceiptBuilderForm.tsx` back to `key={ln.itemIds[0]}` and confirm the first test
goes red, then revert. A guard you never saw fail is a guard you don't know works.

- [ ] **Step 3: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.test.tsx
git commit -m "test(receipts): pin the row key that keeps a service flag through a sibling removal"
```

---

### Task 7: A signature attests to a specific item list (defect #3)

The integrity rule, and the one the review hit hardest. Two failure modes it must cover,
BOTH of which the first draft missed:

1. **The DCSIM path is the common case, not an edge.** `receipts/new/page.tsx:33` passes
   `signatures={[]}` to any non-ADMIN operator, so a DCSIM recipient's field renders
   `TechnicianSignatureField` in its DRAW state every time. That component exports its own
   `onChange` (`TechnicianSignatureField.tsx:35,50`), and if the builder doesn't wire it,
   the `key` remount wipes the ink with **no notice** — the exact silent-glitch this rule
   exists to prevent. So `onChange` must be wired to BOTH signature components.
2. **The test must see the ink actually clear, not just the notice.** A mock with a
   constant hidden-input value can't tell "remounted and blanked" from "notice appeared" —
   delete `key={itemsKey}` and it stays green. The mocks below reflect the drawn/picked
   value into the input so a test asserts `value === ""` after a list change.

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx`
- Modify: `src/app/receipts/new/ReceiptBuilderForm.test.tsx:17-26` (the signature mocks)

**Interfaces:**
- Consumes: `SignaturePad.onChange?: (dataUrl: string) => void` (`SignaturePad.tsx:7`, fires on stroke-end and clear) AND `TechnicianSignatureField.onChange?: (value: string) => void` / `onPickedChange?: (id: string | null) => void` (`TechnicianSignatureField.tsx:35-36,50-51`). No change to either component.

- [ ] **Step 1: Teach the mocks to sign, draw, and pick**

Replace the two mocks at `ReceiptBuilderForm.test.tsx:17-26`. Both reflect their value into
the hidden input via an UNCONTROLLED `defaultValue=""` set imperatively on click — so a
`key` remount recreates the input blank, exactly as the real canvas + hidden input do. No
`React` import needed in the hoisted factory (no hooks used).

```tsx
// jsdom has no canvas. These stand-ins mirror the real components' report paths
// (SignaturePad.tsx:21,28 and TechnicianSignatureField.tsx:50-51) so a test can
// drive signing without one — and reflect the value into the hidden input so a
// test can prove the ink is DISCARDED on a list change, not just that a notice
// shows. defaultValue (uncontrolled) resets to "" on the key remount.
vi.mock("@/components/SignaturePad", () => ({
  SignaturePad: ({ name, onChange }: { name: string; onChange?: (dataUrl: string) => void }) => (
    <>
      <input type="hidden" name={name} defaultValue="" />
      <button type="button" onClick={() => {
        (document.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = "data:image/png;base64,DRAWN";
        onChange?.("data:image/png;base64,DRAWN");
      }}>simulate-sign</button>
    </>
  ),
}));
vi.mock("@/components/TechnicianSignatureField", () => ({
  TechnicianSignatureField: ({ name, onChange, onPickedChange }: { name: string; onChange?: (v: string) => void; onPickedChange?: (id: string | null) => void }) => (
    <>
      <input type="hidden" name={name} defaultValue="" />
      {/* DCSIM recipient DRAWS (the common case: signatures=[] for non-admins) */}
      <button type="button" onClick={() => {
        (document.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = "data:image/png;base64,DRAWN";
        onChange?.("data:image/png;base64,DRAWN");
      }}>dcsim-draw</button>
      {/* DCSIM recipient PICKS a saved signature: reports both signals, like the real one */}
      <button type="button" onClick={() => { onPickedChange?.("sig-1"); onChange?.("data:image/png;base64,PICKED"); }}>dcsim-pick</button>
    </>
  ),
}));
```

- [ ] **Step 2: Write the failing test**

Append to `ReceiptBuilderForm.test.tsx`:

```tsx
describe("ReceiptBuilderForm — a signature attests to a specific item list", () => {
  const TWO = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "HP", model: "G8", serialNumber: "SN2", holderName: null },
  ];
  const sig = (c: HTMLElement) => c.querySelector('input[name="receiverSignature"]') as HTMLInputElement;

  // Today the list is frozen at mount, so signing last is inherently safe. Once
  // a scan can grow it, an operator can have the recipient sign and THEN add
  // laptops — filing a receipt with a signature over a list the signer never
  // saw. So a list change invalidates the ink.
  it("clears the DRAWN signature (ink, not just the notice) when the list changes", async () => {
    const user = userEvent.setup();
    const { container } = renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: "simulate-sign" }));
    expect(sig(container).value).toBe("data:image/png;base64,DRAWN");
    expect(screen.queryByText(/please sign again/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));

    // The ink is GONE — proves key={itemsKey} remounted the pad. Deleting that
    // key leaves this line red while the notice still appears; that is the whole
    // point of asserting the value, not just the message.
    expect(sig(container).value).toBe("");
    expect(await screen.findByText(/Items changed — please sign again/i)).toBeDefined();
  });

  it("says nothing when the list changes before anyone has signed", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));

    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });

  it("drops the notice once the recipient signs again", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: "simulate-sign" }));
    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    expect(await screen.findByText(/please sign again/i)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "simulate-sign" }));
    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });

  // The COMMON case: a DCSIM recipient with no saved signatures draws. If onChange
  // is not wired to TechnicianSignatureField, the remount wipes the ink with NO
  // notice — the silent glitch the rule exists to prevent.
  it("clears a DCSIM recipient's DRAWN signature, with the notice", async () => {
    const user = userEvent.setup();
    const { container } = renderForm(undefined, TWO);
    await user.click(dcsimBox("Recipient")); // recipient is DCSIM -> TechnicianSignatureField
    await user.click(screen.getByRole("button", { name: "dcsim-draw" }));
    expect(sig(container).value).toBe("data:image/png;base64,DRAWN");

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));

    expect(sig(container).value).toBe("");
    expect(await screen.findByText(/Items changed — please sign again/i)).toBeDefined();
  });

  // A picked saved signature is also an attestation to a list. And the notice must
  // CLEAR on re-pick, or it sticks forever under a valid, freshly-picked signature.
  it("clears a DCSIM recipient's PICKED signature and drops the notice on re-pick", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);
    await user.click(dcsimBox("Recipient"));
    await user.click(screen.getByRole("button", { name: "dcsim-pick" }));

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    expect(await screen.findByText(/please sign again/i)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "dcsim-pick" }));
    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npm run test:ui
```

Expected: FAIL — no such notice exists.

- [ ] **Step 4: Implement the invalidation**

Add to `ReceiptBuilderForm`, after `hideReceiverName` (line 233):

```tsx
  // A signature attests to a SPECIFIC item list. If the list changes, the ink no
  // longer covers what will be filed, so it is discarded and the operator is
  // told why (silently clearing it would read as a glitch and get re-signed
  // without anyone understanding what changed).
  //
  // The key remount is what actually clears the pad: SignaturePad owns its
  // canvas and its hidden input, so re-mounting is the only way to blank both.
  // Applies to a picked saved technician signature too — a DCSIM recipient's
  // saved ink is still their attestation to a list, so pickedId is dropped as
  // well (TechnicianSignatureField never reports null on the way out; see the
  // comment on onReceiverDcsimChange above).
  const itemsKey = items.map((i) => i.itemId).join(",");
  const [hasSignature, setHasSignature] = useState(false);
  const [sigCleared, setSigCleared] = useState(false);

  // A guarded render-time write, compared on the KEY and only written when it
  // changes — the "Storing information from previous renders" pattern, matching
  // ItemDetailsCard.tsx:43-47. Not an effect: an effect would clear the ink one
  // paint AFTER the new row is on screen, leaving a frame where the signature
  // and the changed list are both live.
  const [prevItemsKey, setPrevItemsKey] = useState(itemsKey);
  if (itemsKey !== prevItemsKey) {
    setPrevItemsKey(itemsKey);
    if (hasSignature || pickedId !== null) setSigCleared(true);
    setHasSignature(false);
    setPickedId(null);
  }

  const onSignatureChange = (dataUrl: string) => {
    setHasSignature(!!dataUrl);
    if (dataUrl) setSigCleared(false);
  };
```

- [ ] **Step 5: Key the signature fieldset and show the notice**

Replace the recipient-signature fieldset (lines 291-306):

```tsx
      <fieldset className="card stack-sm">
        <legend className="card__title">Recipient signature{receiverIsDcsim ? " (DCSIM)" : ""}</legend>
        {sigCleared && (
          <p role="alert" className="alert-error">Items changed — please sign again.</p>
        )}
        {receiverIsDcsim ? (
          // A DCSIM recipient is our own technician at the desk, so they may pick
          // their saved signature. An outside recipient must always draw in person.
          // onChange IS wired here, not only onPickedChange: without it a DCSIM
          // recipient's DRAWN ink (the common case — signatures=[] for non-admins,
          // so this field is always in draw state for them) is wiped by the remount
          // with no "please sign again" notice. onChange fires for both a draw and
          // a pick (TechnicianSignatureField.tsx:47,50), so it feeds hasSignature
          // and resets sigCleared on a re-pick.
          <TechnicianSignatureField
            key={itemsKey}
            name="receiverSignature"
            signatures={signatures}
            label="Who received it?"
            drawHint={null}
            onChange={onSignatureChange}
            onPickedChange={setPickedId}
          />
        ) : (
          <SignaturePad key={itemsKey} name="receiverSignature" onChange={onSignatureChange} />
        )}
      </fieldset>
```

- [ ] **Step 6: Run the tests**

```bash
npm run test:ui
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx src/app/receipts/new/ReceiptBuilderForm.test.tsx
git commit -m "fix(receipts): changing the item list invalidates the signature"
```

---

### Task 8: The `QrScanner` component

**Files:**
- Create: `src/components/QrScanner.tsx`
- Create: `src/lib/beep.ts`
- Create: `scripts/copy-wasm.mjs`
- Modify: `package.json` (dependency + `dev`/`build` scripts)
- Modify: `.gitignore` (`/public/wasm/`)
- Modify: `src/app/globals.css` (sheet + `.scan-add` styles)

**Interfaces:**
- Produces: `<QrScanner onDecode={(text: string) => void} onClose={() => void} notice?={{ kind: "ok" | "err"; text: string } | null} />`. It emits raw decoded strings and renders `notice` over the video; it knows nothing about items — that boundary is what makes it reusable for the returns flow and testable on its own.
- Produces: `beep(kind: "ok" | "err"): void`.

- [ ] **Step 1: Add the dependency**

Already validated: `barcode-detector@3.2.1`, MIT, published 2026-07-12, one transitive dep (`zxing-wasm@3.1.1`).

```bash
npm view barcode-detector name version license
npm install barcode-detector
```

Expected: `barcode-detector` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Write the beeper**

Create `src/lib/beep.ts`:

```ts
// Audio feedback for scanning. The operator's eyes are on the hardware, not the
// screen, so accept and reject must be tellable apart by ear alone — hence two
// pitches rather than one.
//
// Audio ONLY: navigator.vibrate has never been supported in Safari on iOS, and
// iPhones are the target hardware. Do not add haptics here expecting them to
// fire.
let ctx: AudioContext | null = null;

export function beep(kind: "ok" | "err"): void {
  try {
    // Constructed lazily: an AudioContext created before a user gesture starts
    // suspended. The tap that opens the scanner is that gesture.
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = kind === "ok" ? 880 : 220;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch {
    // Feedback is a nicety; never let it break a scan.
  }
}
```

- [ ] **Step 3: Write the scanner**

Create `src/components/QrScanner.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";

type Notice = { kind: "ok" | "err"; text: string } | null;
type Props = { onDecode: (text: string) => void; onClose: () => void; notice?: Notice };

type Status = "starting" | "running" | "denied" | "unavailable" | "loadfailed";

// A camera sheet that emits decoded strings. It owns the media stream and the
// decode loop and NOTHING else — no knowledge of items, receipts, or the
// schema. Keep it that way: it is what makes this testable without the builder.
//
// Rendered as an OVERLAY, never a route. Routing away from the builder would
// remount it and discard the drawn signature and every typed field.
//
// `notice` is rendered ON TOP of the sheet: the sheet is opaque and full-screen,
// so scan feedback left in the form behind it is invisible when it fires.
export function QrScanner({ onDecode, onClose, notice }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>("starting");
  // Kept in a ref so the effect below subscribes ONCE and never re-binds on an
  // unstable callback — same reasoning as SignaturePad.tsx:14-15.
  const onDecodeRef = useRef(onDecode);
  useEffect(() => { onDecodeRef.current = onDecode; }, [onDecode]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        // On iOS a denial is permanent for the site: Safari remembers it and JS
        // cannot re-prompt, so getUserMedia just fails forever. The UI below
        // must name the way out rather than say "denied".
        setStatus("denied");
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      // Lazy: pulls zxing-wasm only when the sheet actually opens, keeping it
      // out of the builder's initial bundle. `/ponyfill` exports the class
      // without patching globals (`/polyfill` is the global-patching variant),
      // and re-exports prepareZXingModule from zxing-wasm.
      const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/ponyfill");
      // Serve the .wasm from OUR origin, NOT the default jsDelivr CDN. The npm
      // tarball is what package-lock.json hashes and `npm audit` covers; the CDN
      // copy is a DIFFERENT, unverified binary — and it fails silently offline.
      // The verified copy is staged into public/wasm by scripts/copy-wasm.mjs
      // (Step 4a). locateFile receives the bare filename "zxing_reader.wasm".
      prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith(".wasm") ? `/wasm/${path}` : `${prefix}${path}`,
        },
      });

      let detector: InstanceType<typeof BarcodeDetector>;
      try {
        detector = new BarcodeDetector({ formats: ["qr_code"] });
        // Force the module to load NOW, against a throwaway 1×1 canvas, so a
        // failure (offline, blocked CSP, missing wasm) surfaces as a visible
        // status instead of being swallowed frame-by-frame in tick() — which
        // would leave the camera previewing forever while nothing ever decodes.
        const probe = document.createElement("canvas");
        probe.width = probe.height = 1;
        await detector.detect(probe);
      } catch {
        setStatus("loadfailed");
        return;
      }
      if (stopped) return;
      setStatus("running");

      const tick = async () => {
        if (stopped) return;
        try {
          const hits = await detector.detect(video);
          if (hits[0]?.rawValue) onDecodeRef.current(hits[0].rawValue);
        } catch {
          // A frame that fails to decode is normal; the module already loaded.
        }
        if (!stopped) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      // Load-bearing: without this the camera indicator stays lit after the
      // sheet closes, which reads as spyware.
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="scan-sheet" role="dialog" aria-modal="true" aria-label="Scan an item">
      <div className="scan-sheet__frame">
        {/* playsInline is REQUIRED: without it iOS Safari hijacks playback into
            its fullscreen native player and this overlay breaks entirely. It is
            the single most common way in-page scanners fail on iPhone. */}
        <video ref={videoRef} className="scan-sheet__video" playsInline muted autoPlay />
        {status === "starting" && <p className="scan-sheet__msg">Starting the camera…</p>}
        {status === "denied" && (
          <p className="scan-sheet__msg" role="alert">
            Camera access is blocked. Safari remembers this per site and cannot ask again —
            turn it back on in Settings → Safari → Camera, or the <strong>aA</strong> menu →
            Website Settings. You can also pick items from the Items list instead.
          </p>
        )}
        {status === "unavailable" && (
          <p className="scan-sheet__msg" role="alert">
            This device has no camera available. Pick items from the Items list instead.
          </p>
        )}
        {status === "loadfailed" && (
          <p className="scan-sheet__msg" role="alert">
            The scanner failed to load — check your connection and try again, or pick items
            from the Items list instead.
          </p>
        )}
        {/* Scan feedback, on top of the video. */}
        {notice && (
          <p className={`scan-sheet__notice ${notice.kind === "ok" ? "alert-success" : "alert-error"}`} role="status" aria-live="polite">
            {notice.text}
          </p>
        )}
      </div>
      <div className="row">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Style the sheet**

Append to `src/app/globals.css`. The sheet is new surface outside any table, so it inherits none of the mobile table rules — it must reach for the tokens explicitly:

```css
/* ---------- Scanner sheet ----------
   New surface outside any table, so it inherits nothing from the mobile card
   rules. Uses the ledger palette and the tap tokens directly. Overlays the
   builder rather than routing: a route change would remount the form and
   discard the signature and every typed field. */
.scan-sheet {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--surface);
  color: var(--text);
}
.scan-sheet__frame {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  overflow: hidden;
}
.scan-sheet__video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.scan-sheet__msg {
  position: absolute;
  margin: 0;
  padding: 16px;
  max-width: 42ch;
  text-align: center;
  background: var(--surface);
  border-radius: var(--radius-sm);
}
/* Scan feedback, pinned over the video near the bottom of the frame so it does
   not cover the aiming area. Full-width band, readable at a glance. */
.scan-sheet__notice {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  margin: 0;
  text-align: center;
}
.scan-sheet .btn {
  min-height: var(--tap-lg);
}

/* The "Scan to add" button. Static in the items card on desktop; on a phone it
   lifts to a fixed thumb-reachable bar at the bottom of the viewport, so it is
   reachable one-handed (laptop in the other) without scrolling past a long item
   list. env(safe-area-inset-bottom) clears the iPhone home indicator. */
@media (max-width: 720px) {
  .scan-add {
    position: fixed;
    left: 16px;
    right: 16px;
    bottom: calc(16px + env(safe-area-inset-bottom));
    z-index: 40;
    min-height: var(--tap-lg);
    box-shadow: var(--shadow-md);
  }
}
```

- [ ] **Step 4a: Stage the WASM from the locked package, not the CDN**

The scanner overrides `locateFile` to load `/wasm/zxing_reader.wasm` from our own
origin. Something must put the **lockfile-verified** binary there — and it must be
regenerated on every build so it can never drift from the installed package. A
build script does that; do NOT hand-copy-and-commit the binary (a stale commit
would silently serve a different version than `npm audit` covers).

Create `scripts/copy-wasm.mjs`:

```js
// Stage the installed zxing-wasm reader binary into public/ so QrScanner serves
// it same-origin instead of the default jsDelivr CDN. Resolving through the
// package's own package.json guarantees this is the copy package-lock.json
// pinned and `npm audit` covers — the audited artifact and the executed
// artifact are then the same file. Runs before dev and build.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const src = join(dirname(require.resolve("zxing-wasm/package.json")), "dist/reader/zxing_reader.wasm");
mkdirSync("public/wasm", { recursive: true });
copyFileSync(src, "public/wasm/zxing_reader.wasm");
console.log(`[copy-wasm] ${src} -> public/wasm/zxing_reader.wasm`);
```

Wire it into `package.json` scripts so both dev and the Vercel build stage it:

```json
    "dev": "node scripts/copy-wasm.mjs && next dev",
    "build": "node scripts/copy-wasm.mjs && prisma generate && next build",
```

Ignore the generated copy — it is a build artifact, never committed. Append to `.gitignore`:

```
/public/wasm/
```

Run it once now so local dev and Task 10 work:

```bash
node scripts/copy-wasm.mjs
ls public/wasm/zxing_reader.wasm
```

Expected: the file exists.

- [ ] **Step 5: Verify it builds and lints**

There is no jsdom test here: jsdom has no camera, no WASM, and no layout. The decode loop and the same-origin WASM fetch are verified in a real browser in Task 10.

```bash
npx tsc --noEmit
npm run lint
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

`package-lock.json` is included; the staged WASM under `public/wasm/` is gitignored.

```bash
git add package.json package-lock.json scripts/copy-wasm.mjs .gitignore src/components/QrScanner.tsx src/lib/beep.ts src/app/globals.css
git commit -m "feat(scan): a camera sheet that emits decoded QR text, self-hosted wasm"
```

---

### Task 9: Wire scanning into the builder

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx`
- Modify: `src/app/receipts/new/ReceiptBuilderForm.test.tsx`

**Interfaces:**
- Consumes: `parseItemScan` (Task 2), `lookupScannedItem` / `ScanLookup` (Task 3), `QrScanner` (Task 8), `beep` (Task 8), `groupItemsIntoLines` / `MAX_RECEIPT_ROWS` / `MAX_ITEMS_PER_ROW`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

`QrScanner` is mocked to a button that emits a fixed string — this test is about what the builder *does* with a decode, not about cameras. Add the mock next to the others at the top of `ReceiptBuilderForm.test.tsx`:

```tsx
const lookupScannedItem = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  lookupScannedItem: (id: string) => lookupScannedItem(id),
}));
// The camera is not what these tests are about. This stands in for it: a button
// per fixture that emits one decoded string. (`notice` is accepted and ignored
// here — it's exercised in the real browser, Task 10.)
vi.mock("@/components/QrScanner", () => ({
  QrScanner: ({ onDecode, onClose }: { onDecode: (t: string) => void; onClose: () => void; notice?: unknown }) => (
    <div>
      <button type="button" onClick={() => onDecode("https://x.example/i/i2")}>emit-i2</button>
      <button type="button" onClick={() => onDecode("https://x.example/i/i3")}>emit-i3</button>
      <button type="button" onClick={() => onDecode("https://x.example/i/i1")}>emit-i1</button>
      <button type="button" onClick={() => onDecode("WIFI:S:Guest;;")}>emit-junk</button>
      <button type="button" onClick={onClose}>emit-close</button>
    </div>
  ),
}));
vi.mock("@/lib/beep", () => ({ beep: vi.fn() }));
```

Append the describe block:

```tsx
describe("ReceiptBuilderForm — scanning adds items", () => {
  const HP = { ok: true as const, item: { id: "i2", make: "HP", model: "G8", serialNumber: "SN2" }, holderName: null };

  const openScanner = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /Scan to add/i }));

  beforeEach(() => lookupScannedItem.mockResolvedValue(HP));

  it("adds a scanned item to the list", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText("SN2")).toBeDefined();
    expect(lookupScannedItem).toHaveBeenCalledWith("i2");
  });

  it("posts the scanned item alongside the original", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));
    await screen.findByText("SN2");
    await user.click(screen.getByRole("button", { name: "emit-close" }));

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1", "i2"]);
  });

  it("rejects a foreign QR without calling the server", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-junk" }));

    expect(await screen.findByText(/Not an item code/i)).toBeDefined();
    expect(lookupScannedItem).not.toHaveBeenCalled();
  });

  it("names the duplicate rather than adding it twice", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i1" }));

    expect(await screen.findByText(/Already added — Dell L5420 · SN SN1/i)).toBeDefined();
    expect(lookupScannedItem).not.toHaveBeenCalled();
  });

  it("refuses a retired item", async () => {
    lookupScannedItem.mockResolvedValue({ ok: false, code: "RETIRED" });
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/That item is retired and can't be transferred/i)).toBeDefined();
    expect(screen.queryByText("SN2")).toBeNull();
  });

  it("refuses an unknown item", async () => {
    lookupScannedItem.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/That item no longer exists/i)).toBeDefined();
  });

  it("surfaces a lookup failure", async () => {
    lookupScannedItem.mockResolvedValue({ ok: false, code: "FAILED" });
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/Couldn't look up that item — try again/i)).toBeDefined();
  });

  // A QR sitting in frame decodes many times a second. The SECOND decode here
  // is caught by the duplicate-item check (i2 is already on the list) — that is
  // fine, but it does not exercise the time-window dedupe. The next test does.
  it("does not add the same item twice from repeated decodes", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));
    await screen.findByText("SN2");
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(lookupScannedItem).toHaveBeenCalledTimes(1);
  });

  // Concurrency safety — the CRITICAL bug the review caught. The decode loop
  // fires onDecode without awaiting, so two lookups can be in flight at once. A
  // handler that appended from a captured `items` snapshot would let the second
  // resolution overwrite the first and silently drop a laptop off a custody
  // document, AFTER the operator heard the beep confirming it. The `looking`
  // guard serializes lookups; the live-ref append composes. With a DEFERRED
  // first lookup, the overlapping second decode is dropped (not confirmed, so
  // never falsely reported), and once the first resolves a re-emit of the
  // second lands ON TOP of it — both items survive.
  it("never drops a confirmed item when two scans overlap", async () => {
    const user = userEvent.setup();
    const HP3 = { ok: true as const, item: { id: "i3", make: "Acer", model: "A1", serialNumber: "SN3" }, holderName: null };
    let releaseI2: (v: typeof HP) => void = () => {};
    lookupScannedItem.mockImplementation((id: string) =>
      id === "i2" ? new Promise((r) => { releaseI2 = r; }) : Promise.resolve(HP3));

    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" })); // in flight, not resolved
    await user.click(screen.getByRole("button", { name: "emit-i3" })); // overlaps -> dropped by the guard
    expect(screen.queryByText("SN3")).toBeNull();

    releaseI2(HP);                        // i2 resolves and is added
    expect(await screen.findByText("SN2")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "emit-i3" })); // re-scan i3, now free
    expect(await screen.findByText("SN3")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "emit-close" }));

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    // BOTH survive: i2 was not clobbered by i3 landing on a stale snapshot.
    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1", "i2", "i3"]);
  });

  // Per the spec: added, not blocked — a dead end at the cart is worse. But the
  // toast vanishes while the operator is looking at a laptop, so the row keeps
  // saying it, right up to signature time.
  it("adds an item held by someone else, and keeps saying so on the row", async () => {
    lookupScannedItem.mockResolvedValue({ ...HP, holderName: "CPL Jones" });
    const user = userEvent.setup();
    renderForm({ isDcsim: false, name: "SGT Smith", rank: "SGT", unit: "A Co", contact: "5551112222", email: "s@x.mil" });
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText("SN2")).toBeDefined();
    expect(await screen.findByText(/Held by CPL Jones, not SGT Smith/i)).toBeDefined();
  });

  it("says nothing about a holder that matches the sender", async () => {
    lookupScannedItem.mockResolvedValue({ ...HP, holderName: "SGT Smith" });
    const user = userEvent.setup();
    renderForm({ isDcsim: false, name: "SGT Smith", rank: "SGT", unit: "A Co", contact: "5551112222", email: "s@x.mil" });
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    await screen.findByText("SN2");
    expect(screen.queryByText(/Held by/i)).toBeNull();
  });

  // Replacing a half-filled form with a card (what the server gate does on load)
  // would destroy the operator's work — the exact thing this design avoids.
  it("refuses a scan that would overflow the receipt, leaving the form alone", async () => {
    const full = Array.from({ length: 18 }, (_, k) => ({
      itemId: `f${k}`, make: `Make${k}`, model: "M", serialNumber: `S${k}`, holderName: null,
    }));
    const user = userEvent.setup();
    renderForm(undefined, full);
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/This receipt is full — 18 item types max/i)).toBeDefined();
    expect(screen.queryByText("SN2")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm run test:ui
```

Expected: FAIL — no "Scan to add" button exists.

- [ ] **Step 3: Add the imports**

At the top of `ReceiptBuilderForm.tsx`:

```tsx
import { groupItemsIntoLines, MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW, type LineItem } from "@/modules/transfers/receipt-lines";
import { parseItemScan } from "@/modules/items/scan-url";
import { lookupScannedItem } from "@/app/actions/scan";
import { QrScanner } from "@/components/QrScanner";
import { beep } from "@/lib/beep";
```

- [ ] **Step 4: Implement the scan handler**

Add to `ReceiptBuilderForm`, after `removeItem`.

**This is the concurrency-critical code.** `QrScanner`'s decode loop (Task 8) calls `onDecode` WITHOUT awaiting it, then immediately schedules the next frame — so two different stickers scanned a few hundred ms apart overlap. A handler that read `items` from its render closure, awaited the server, then did `setItems([...items, new])` would build the new list from the PRE-await snapshot: scan A resolves and adds A, scan B (which captured the list before A landed) resolves and overwrites with `[...oldList, B]`, and **A is silently gone from a custody document** — after the operator already heard the beep confirming it. So: one lookup at a time (`looking` ref), read the live list through a ref (never a stale closure), and re-check for a raced duplicate inside the final append.

```tsx
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // A QR sitting in frame decodes many times a second, so the same id inside
  // this window is the camera repeating itself, not a second laptop.
  const lastDecode = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  // Serializes lookups. The decode loop fires onDecode without awaiting, so
  // without this two different ids interleave their read-modify-write of the
  // item list and the second drops the first. One in flight at a time.
  const looking = useRef(false);
  // Mirrors `items` so onDecode reads the LIVE list across its await instead of
  // the snapshot its closure captured. Updated on every render, and eagerly
  // after an append so a second scan landing before the next render still sees
  // the first.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const say = (kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    beep(kind);
  };

  const holderNote = (holder: string | null) =>
    holder && senderName && holder !== senderName ? ` — held by ${holder}, not ${senderName}` : "";

  // Every refusal KEEPS the camera open: rapid-fire only works if a bad scan is
  // a blip, not a dead end.
  const onDecode = async (text: string) => {
    const id = parseItemScan(text);
    // Rejected client-side, so a stray barcode never costs a round trip.
    if (!id) return say("err", "Not an item code");

    if (looking.current) return; // a lookup is already in flight; drop this frame

    // Time-window dedupe: the same id within 1.5s of the last PROCESSED decode is
    // the camera repeating a QR still in frame. Checked AFTER the in-flight guard
    // and recorded only when we actually proceed — otherwise a decode dropped for
    // concurrency would arm the window against its own retry and suppress a
    // legitimate item for up to 1.5s.
    const now = Date.now();
    if (lastDecode.current.id === id && now - lastDecode.current.at < 1500) return;
    lastDecode.current = { id, at: now };

    looking.current = true;
    try {
      const dup = itemsRef.current.find((i) => i.itemId === id);
      if (dup) return say("err", `Already added — ${dup.make} ${dup.model} · SN ${dup.serialNumber}`);

      const res = await lookupScannedItem(id);
      if (!res.ok) {
        const msg: Record<typeof res.code, string> = {
          NOT_FOUND: "That item no longer exists",
          RETIRED: "That item is retired and can't be transferred",
          UNAUTHORIZED: "Your session expired — sign in again",
          FAILED: "Couldn't look up that item — try again",
        };
        return say("err", msg[res.code]);
      }

      const newItem: BuilderItem = {
        itemId: res.item.id, make: res.item.make, model: res.item.model,
        serialNumber: res.item.serialNumber, holderName: res.holderName,
      };
      // Built from the LIVE list (itemsRef), not a captured snapshot.
      const next = [...itemsRef.current, newItem];
      // The server gate on load swaps the whole form for a card
      // (receipts/new/page.tsx:52-55). Doing that here would destroy a
      // half-filled form, so the SCAN is refused and the form left untouched.
      // createTransfer remains the authority.
      const nextLines = groupItemsIntoLines(next);
      if (nextLines.length > MAX_RECEIPT_ROWS) return say("err", `This receipt is full — ${MAX_RECEIPT_ROWS} item types max`);
      if (nextLines.some((l) => l.serials.length > MAX_ITEMS_PER_ROW)) {
        return say("err", `Too many of one item — ${MAX_ITEMS_PER_ROW} per make and model max`);
      }

      itemsRef.current = next; // eager, so a scan landing before re-render sees it
      setItems(next);
      // Spec: the mixed-holder warning does double duty — a toast at scan time
      // AND a persistent row marker (added below). This is the toast half.
      say("ok", `Added: ${newItem.make} ${newItem.model} · SN ${newItem.serialNumber}${holderNote(newItem.holderName)}`);
    } finally {
      looking.current = false;
    }
  };
```

`useEffect` and `useRef` are already imported (line 2).

- [ ] **Step 5: Render the button, the toast, and the sheet**

Replace the items `<fieldset>` opening (lines 252-254). **`<legend>` MUST be a direct child of `<fieldset>`** — wrapping it in a `<div>` strips the fieldset's accessible name, which is the exact a11y regression `b094448` just fixed elsewhere. So the legend stays bare and the button is a following sibling (it becomes the fixed-bottom control on mobile via `.scan-add`, styled in Task 8):

```tsx
      <fieldset className="card stack-sm">
        <legend className="card__title">Items ({lines.length} {lines.length === 1 ? "row" : "rows"})</legend>
        {/* "Scan to add", not "Scan": the phone's own camera app also scans these
            stickers, but it can only OPEN the item page — it cannot feed a form
            that is already open. Naming the action keeps the two apart. */}
        <button type="button" className="btn btn-secondary scan-add" onClick={() => setScanning(true)}>Scan to add</button>
        {/* Shown here for when the sheet is CLOSED. While the sheet is open it
            covers this, so the same toast is ALSO rendered inside the sheet
            (below) — otherwise every scan message fires behind an opaque
            overlay and the operator never sees one. */}
        {toast && !scanning && (
          <p role="status" aria-live="polite" className={toast.kind === "ok" ? "alert-success" : "alert-error"}>{toast.text}</p>
        )}
```

Add the holder marker to the serial cell in the `<tbody>`, replacing the serial `<td>`:

```tsx
                      {/* The warning lives with the SERIAL, which is what the mobile
                          card leads with (globals.css:980-988) and what an operator
                          matches against the sticker. `.is-stacked` only when it is
                          present — a restacked cell is a flex row, so two children
                          would otherwise sit side by side and collide. */}
                      <td className={holderWarning(itemId) ? "mono is-stacked" : "mono"} data-label="Serial">
                        {ln.serials[k]}
                        {holderWarning(itemId) && <span className="subtle">{holderWarning(itemId)}</span>}
                      </td>
```

And define `holderWarning` next to `holderNote` (from Step 4). It is the persistent
row-marker half of the spec's mixed-holder warning; `holderNote` is the scan-time toast
half. Both key off the same rule:

```tsx
  // Warns only when a sender name is present AND differs: an item never
  // transferred has no holder to disagree with, and a blank sender cannot
  // conflict with anything. Added, never blocked — see the spec.
  const holderOf = new Map(items.map((i) => [i.itemId, i.holderName]));
  const holderWarning = (itemId: string) => {
    const holder = holderOf.get(itemId);
    if (!holder || !senderName || holder === senderName) return null;
    return `Held by ${holder}, not ${senderName}`;
  };
```

Finally, render the sheet just before the closing `</form>`. Pass the toast in as `notice` so it renders OVER the video — the sheet is opaque and full-screen, so a toast left in the form behind it is invisible exactly when it fires:

```tsx
      {scanning && <QrScanner onDecode={onDecode} onClose={() => setScanning(false)} notice={toast} />}
```

This requires `QrScanner` to accept and render `notice` — added in Task 8. (Task 8 is authored before this task; if executing strictly in order, its `notice` prop already exists.)

- [ ] **Step 6: Run the tests**

```bash
npm run test:ui
npx tsc --noEmit
npm run lint
```

Expected: PASS, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx src/app/receipts/new/ReceiptBuilderForm.test.tsx
git commit -m "feat(receipts): scan QR codes to add items to an open hand receipt"
```

---

### Task 10: Verify in a real browser

The suite cannot see any of this. jsdom has no layout engine, no camera, and no WASM — and `a08d9e5` documents that a build could not see a single one of the seven mobile defects it fixed. A green suite is not evidence for a layout or camera claim.

**Files:** none — this is verification, plus any fixes it turns up.

- [ ] **Step 1: Drive the desktop builder at 1280**

```bash
npm run dev
```

Confirm: the items table still renders one line per item, the Remove column does not wrap, and the quantity boxes still sit on the same line.

- [ ] **Step 2: Drive the mobile builder at 390×844**

Confirm, with DOM measurement rather than eyeballing:
- No horizontal overflow: `document.documentElement.scrollWidth <= 390`.
- Every card leads with the serial band (`globals.css:980-988`).
- The Remove button is left-aligned inside the card, not pinned right — a pinned button means an inline `justifyContent` slipped in.
- Every tap target ≥ 44px: check `getBoundingClientRect().height` on each `.btn` and `.btn-sm`.
- A line holding two serials labels its quantity "Qty authorized (all 2 serials)".
- The **"Scan to add" button is fixed to the bottom of the viewport** (not scrolled away with the item list), reachable with a thumb, and clears the home-indicator area.

- [ ] **Step 3: Drive the camera in Chromium with a fake stream**

```bash
npx playwright test --headed  # or launch Chromium directly with the flags below
```

Launch flags: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<a y4m of a known item QR>`.

Confirm: the sheet opens; the code decodes; the row appears; **the toast naming the item is visible ON TOP of the sheet** (not hidden behind it — the bug that made every scan message invisible); a second decode of the same code inside 1.5s does not add it twice; closing the sheet stops the stream (`videoRef.current.srcObject.getTracks()` are all `ended`).

- [ ] **Step 4: Confirm the WASM is same-origin and measure it**

This is the supply-chain check, not just a size check. In DevTools → Network, open the scanner and confirm:
- The `.wasm` request goes to **our own origin** (`/wasm/zxing_reader.wasm`), with **no `jsdelivr.net` or `unpkg.com` request anywhere** — the default is the CDN, and `copy-wasm.mjs` + the `locateFile` override are what redirect it. If you see a CDN host, the override didn't take.
- It is NOT in the builder's initial bundle (only loads when the sheet opens).
- Record the transfer size. If it's unreasonable over cellular, raise it — `@zxing/browser` is the recorded fallback.

Then verify offline behaviour: block `jsdelivr.net` in DevTools (or throttle to offline after the page loads, before opening the scanner) and confirm the scanner **still decodes** from the self-hosted copy, and that a genuine load failure shows the "scanner failed to load" message rather than a camera that previews forever while nothing decodes.

- [ ] **Step 5: Verify on a real iPhone**

The two iOS-specific risks cannot be faked and are the ones that sink this feature in the field:
- The video plays **inline**. If it goes fullscreen, `playsInline` was dropped.
- Deny camera permission, then reopen the scanner: confirm the message names Settings → Safari → Camera, and that the Items-list fallback works. This state is unrecoverable from JS by design — confirm the copy actually gets someone out of it.

Also confirm: the beep is audible after the "Scan to add" tap, and that nothing depends on vibration.

- [ ] **Step 6: Run the full suite once, alone**

```bash
npm test
```

Do NOT run this concurrently with another agent — the integration tests share one database and truncate each other, which surfaces as flakiness in unrelated files.

Expected: PASS.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix(scan): browser-verified corrections at 390x844"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Item-page entry button | 1 |
| Path-based parsing, printed stickers keep working | 2 |
| `lookupScannedItem`, auth first, no leaked fields | 3 |
| Client-owned item list; no remount on scan | 4 |
| Per-row remove | 4 |
| `replaceState` URL sync (v1) | 4 |
| Defect #1 — stale quantities (+ override pruning) | 5 |
| Defect #2 — service flags reset on removal (row-key guard) | 6 |
| Defect #3 — signature attests to a list, **incl. DCSIM draw + pick** | 7 |
| **Concurrent scans never drop a confirmed item** | 9 |
| **Scan feedback visible over the sheet, not behind it** | 8, 9 |
| `QrScanner`: playsInline, track cleanup, `facingMode`, lazy WASM | 8 |
| **WASM self-hosted (not jsDelivr CDN); load-failure is visible** | 8 |
| `barcode-detector`, validated | 8 |
| Beep, no haptics | 8 |
| Rapid-fire loop, dedupe (time-window), refusal table | 9 |
| Mixed-holder warning: **scan-time toast + persistent row marker** | 9 |
| Fixed-to-bottom mobile scan button | 8 (css), 9 (markup) |
| Client-side limits refuse the scan, not the form | 9 |
| `<legend>` accessible name preserved (no wrapping `<div>`) | 9 |
| `data-label` / `.is-stacked` / `.actions--end` contract | 4, 8, 9, 10 |
| Browser verification at 390×844 and 1280; real iPhone | 10 |

**Not covered by any task, deliberately:** the `sessionStorage` snapshot (spec: *Deferred*), persisted drafts, and phone-as-peripheral. The spec defers all three.

**Type consistency:** `BuilderItem` (Task 4) is used unchanged in Tasks 5, 6, 7, 9. `ScanLookup` (Task 3) is consumed in Task 9 with all four refusal codes handled. `ServiceControls` keeps its `{ itemId }` signature (Task 6 makes no production change). `QtyInput`'s new signature (Task 5) is used at both call sites. `parseItemScan` returns `string | null`, and Task 9 branches on `!id`. `QrScanner`'s `notice` prop (Task 8) is passed by Task 9.

**Known ordering constraint:** Tasks 4-7 all edit `ReceiptBuilderForm.tsx` and must land in order — each builds on the previous task's state. Task 1 is independent and can ship at any time. Tasks 2, 3, and 8 are independent of each other and of 4-7, so they can be worked in parallel, but Task 9 needs all of them.

---

## Revision log — adversarial review (2026-07-16)

A multi-agent review of the first draft found ~12 real defects (deduped from 27 raw
findings). Folded in here:

- **Critical — concurrent scans dropped a confirmed item.** `onDecode` appended from its
  render-closure `items` snapshot across an un-awaited lookup. Now serialized (`looking`
  ref) and built from a live `itemsRef`; `lastDecode` is recorded only after the in-flight
  guard so a concurrency-dropped scan doesn't suppress its own retry. Task 9 + new
  concurrency test.
- **Critical — scan feedback rendered behind the opaque sheet.** The toast now also renders
  inside `QrScanner` via a `notice` prop. Tasks 8, 9.
- **Critical — Task 7's test couldn't see the ink clear.** Mocks now reflect the value into
  the hidden input; tests assert `value === ""` after a list change.
- **Major — DCSIM signature path unwired.** `onChange` is now passed to
  `TechnicianSignatureField` (the common case for non-admins), and `sigCleared` resets on
  re-pick. DCSIM draw + pick tests added. Task 7.
- **Major — WASM fetched from jsDelivr CDN at runtime.** Self-hosted via
  `prepareZXingModule` + `scripts/copy-wasm.mjs`; module load hoisted so failure is a
  visible status. Task 8 + Task 10 same-origin assertion.
- **Major — mixed-holder scan-time toast and fixed-bottom mobile button were dropped.**
  Both restored (Task 9 markup, Task 8 CSS).
- **Major — `holderName: null` discarded the warning on reload.** Now sourced from
  `lastReceivers`. Task 4.
- **Major — Task 6's red step couldn't go red** (Task 4's re-key already fixed defect #2).
  Task 6 is now an honest regression guard, no production change.
- **Minor — qty override resurrection, and `<legend>` wrapped in a `<div>`.** Both fixed
  (Tasks 5, 9).
