# Manufacturer Barcode Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the camera identify an item from a manufacturer's factory barcode (Dell service tag, HP serial) as well as from the QR sticker this app prints.

**Architecture:** A pure parse module turns a decoded string into a *scan intent* (our item id, or a candidate serial). The existing `QrScanner` component gains a `formats` prop and stays ignorant of items. Two small `requireUser()`-gated Server Actions resolve a serial — one for the receipt builder (needs display fields, ACTIVE only), one for the items list (needs an id, any status).

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Prisma 7, Zod, Vitest (node + jsdom), `barcode-detector/ponyfill` over `zxing-wasm`.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-08-manufacturer-barcode-scanning-design.md`. Read it before Task 1.
- **No schema change, no migration, no new index.** `Item.serialNumber` is already `@unique @db.Citext`.
- **Every Server Action starts with `requireUser()` or `requireAdmin()`** from `@/lib/authz` — never bare `auth()`.
- **Never return the Prisma row from an action.** Client-component props are serialized into the RSC payload and reach the browser regardless of what renders. Select an explicit field subset; `Item.notes` is admin-only.
- **Serial candidate shape:** `^[A-Za-z0-9]{4,20}$`. Grounded in production (1,204 ACTIVE items: zero non-alphanumeric, lengths 4–14). It is a filter to avoid pointless round trips, **not** a security control.
- **Express Service Code range:** all digits, length 8–11, converted with `BigInt(v).toString(36).toUpperCase()` then `padStart(7, "0")`.
- **Barcode formats:** `qr_code`, `code_39`, `code_128`, `data_matrix`.
- **The component keeps the name `QrScanner`.** Renaming it touches two call sites, its CSS contract (`.scan-sheet`) and `.claude/rules/ui-styling.md` for no behaviour change. Out of scope.
- **`npm run build` and jsdom are NOT evidence for anything visual or camera-related.** Neither has a layout engine or a camera.
- **Do not run `npm test` if another agent is running it** — the suite shares one test DB and concurrent runs truncate each other, which looks like flaky failures in unrelated files.

---

## File Structure

**Create**
- `src/modules/items/scan-code.ts` — pure: decoded string → `ScanIntent`. No DOM, no network, no Prisma.
- `src/modules/items/scan-code.test.ts` — unit tests for the above.
- `src/app/items/ItemsScanButton.tsx` — client component: the scan button + sheet on `/items`.
- `src/app/items/ItemsScanButton.test.tsx` — jsdom component test.

**Modify**
- `src/modules/items/items.service.ts` — add `getItemBySerialForScan`.
- `src/app/actions/scan.ts` — add `lookupScannedSerial` and `resolveScannedSerial`.
- `src/app/actions/scan.test.ts` — tests for both.
- `src/components/QrScanner.tsx` — `formats` prop, camera resolution hint.
- `src/app/receipts/new/ReceiptBuilderForm.tsx` — intent-based `onDecode`, intent-keyed dedupe, pass `formats`.
- `src/app/receipts/new/ReceiptBuilderForm.test.tsx` — serial-scan cases.
- `src/app/items/page.tsx` — render `ItemsScanButton`.
- `CHANGELOG.md` — user-facing entry.

**Untouched on purpose:** `src/modules/items/scan-url.ts` (wrapped, not replaced — it keeps its behaviour, comments and tests), `prisma/schema.prisma`, `docs/SECURITY.md` (the security-docs CI gate was removed 2026-08-08; no watched-file rule applies, and this change adds no authn/authz/crypto/public surface — both new actions are `requireUser()`-gated like the one beside them).

---

### Task 1: Pure scan parsing (`scan-code.ts`)

**Files:**
- Create: `src/modules/items/scan-code.ts`
- Test: `src/modules/items/scan-code.test.ts`

**Interfaces:**
- Consumes: `parseItemScan(text: string): string | null` from `./scan-url`.
- Produces:
  - `type ScanIntent = { kind: "item"; id: string } | { kind: "serial"; serial: string; altSerial?: string }`
  - `parseScan(text: string): ScanIntent | null`
  - `expressServiceCodeToServiceTag(code: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/modules/items/scan-code.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseScan, expressServiceCodeToServiceTag } from "./scan-code";

describe("expressServiceCodeToServiceTag", () => {
  // A Dell service tag is 7 chars of base 36; the Express Service Code printed
  // beside it on the same label is that same value in base 10.
  it("converts an express service code back to its service tag", () => {
    expect(expressServiceCodeToServiceTag("17237164935")).toBe("7X2K9L3");
    expect(expressServiceCodeToServiceTag("42938741054")).toBe("JQ4M8N2");
    expect(expressServiceCodeToServiceTag("38814517047")).toBe("HTX5T13");
  });

  // A tag beginning with 0 loses that character in the numeric form. Padding is
  // what restores it — without padStart this returns a 6-char string that
  // matches no item.
  it("restores a leading zero the numeric form drops", () => {
    expect(expressServiceCodeToServiceTag("623698779")).toBe("0ABC123");
  });

  it("refuses anything that is not an 8-11 digit number", () => {
    expect(expressServiceCodeToServiceTag("7X2K9L3")).toBeNull(); // the tag itself
    expect(expressServiceCodeToServiceTag("1234567")).toBeNull(); // too short
    expect(expressServiceCodeToServiceTag("123456789012")).toBeNull(); // too long
    expect(expressServiceCodeToServiceTag("")).toBeNull();
  });
});

describe("parseScan", () => {
  it("recognises our own QR sticker, absolute and bare-path", () => {
    expect(parseScan("https://www.dcsim.us/i/abc123")).toEqual({ kind: "item", id: "abc123" });
    expect(parseScan("/i/abc123")).toEqual({ kind: "item", id: "abc123" });
  });

  it("reads a Dell service tag as a serial", () => {
    expect(parseScan("7X2K9L3")).toEqual({ kind: "serial", serial: "7X2K9L3" });
  });

  it("reads an HP serial as a serial", () => {
    expect(parseScan("5CD1234ABC")).toEqual({ kind: "serial", serial: "5CD1234ABC" });
  });

  // The raw value is tried FIRST and the conversion offered as a fallback, so a
  // genuinely numeric serial can never be silently rewritten into a wrong tag.
  it("offers the converted tag as an alternative, never as a replacement", () => {
    expect(parseScan("17237164935")).toEqual({
      kind: "serial",
      serial: "17237164935",
      altSerial: "7X2K9L3",
    });
  });

  it("does not lowercase or otherwise rewrite the value", () => {
    // serialNumber is citext, so matching is already case-insensitive; folding
    // case here would put a second casing rule in a second place.
    expect(parseScan("7x2k9l3")).toEqual({ kind: "serial", serial: "7x2k9l3" });
  });

  it("rejects a Dell PPID and other punctuated strings", () => {
    expect(parseScan("CN-0ABCDE-12345-ABC-1234-A00")).toBeNull();
    expect(parseScan("WIFI:S:guest;T:WPA;P:hunter2;;")).toBeNull();
  });

  it("rejects blank, too-short and too-long input", () => {
    expect(parseScan("")).toBeNull();
    expect(parseScan("   ")).toBeNull();
    expect(parseScan("AB")).toBeNull();
    expect(parseScan("A".repeat(21))).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseScan("  7X2K9L3  ")).toEqual({ kind: "serial", serial: "7X2K9L3" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scan-code`
Expected: FAIL — `Failed to resolve import "./scan-code"`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/items/scan-code.ts`:

```ts
// Decoded barcode text -> what we should look up. Pure: no DOM, no network,
// no Prisma — same contract as scan-url.ts, which this WRAPS rather than
// replaces (that file stays the authority on our own QR sticker).
//
// Two things can be under the camera:
//   * the QR sticker this app prints, carrying an /i/<id> URL;
//   * a manufacturer's factory barcode, carrying a serial.
import { parseItemScan } from "./scan-url";

export type ScanIntent =
  | { kind: "item"; id: string }
  | { kind: "serial"; serial: string; altSerial?: string };

// A shape filter, NOT a security control — it exists so a stray barcode costs
// no round trip. The DB is the authority on whether a serial names an item,
// exactly as scan-url.ts says of its own regex.
//
// Grounded in the fleet: of 1,204 ACTIVE items, ZERO carry a non-alphanumeric
// character and lengths run 4-14 (Dell 7, HP 10, Surface 14, Getac 10).
const SERIAL_SHAPE = /^[A-Za-z0-9]{4,20}$/;

// A 7-char service tag is 36^6 .. 36^7-1, i.e. 10 or 11 digits. A tag starting
// with "0" is worth less and lands as few as 8 — hence the wider floor.
const EXPRESS_CODE = /^[0-9]{8,11}$/;

/**
 * Dell prints the Service Tag and the Express Service Code as two barcodes a
 * centimetre apart, and they are the SAME value in two bases: a service tag is
 * 7 characters of base 36, and the express code is that number in base 10.
 * Converting means the operator can hit either barcode and never notice.
 *
 * Returns null for anything that is not an express code, or that does not
 * convert back to exactly 7 tag characters.
 */
export function expressServiceCodeToServiceTag(code: string): string | null {
  if (!EXPRESS_CODE.test(code)) return null;

  // BigInt, not Number: 36^7-1 is ~7.8e10, which is inside Number's safe
  // integer range today, but the parse/format round trip is exact with BigInt
  // and needs no reasoning about precision.
  const tag = BigInt(code).toString(36).toUpperCase();
  if (tag.length > 7) return null;

  // Load-bearing. A tag beginning with "0" has no leading zero in the numeric
  // form, so the conversion comes back one character short; padding restores
  // it. Without this, "623698779" yields "ABC123" and matches no item.
  return tag.padStart(7, "0");
}

export function parseScan(text: string): ScanIntent | null {
  const raw = text.trim();
  if (!raw) return null;

  // Our own sticker wins: it names an item directly and needs no guessing.
  const id = parseItemScan(raw);
  if (id) return { kind: "item", id };

  if (!SERIAL_SHAPE.test(raw)) return null;

  // The raw value is the PRIMARY candidate and the conversion only ever an
  // alternative. Preferring the conversion would rewrite a genuinely numeric
  // 10-digit serial into a 7-character tag that names a different machine —
  // trying raw first makes that unrepresentable, at the cost of one extra
  // query only when the raw value misses.
  const altSerial = expressServiceCodeToServiceTag(raw);
  return altSerial ? { kind: "serial", serial: raw, altSerial } : { kind: "serial", serial: raw };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scan-code`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/scan-code.ts src/modules/items/scan-code.test.ts
git commit -m "feat(items): parse a manufacturer barcode into a scan intent"
```

---

### Task 2: Serial lookup actions

**Files:**
- Modify: `src/modules/items/items.service.ts` (add one function near `getItemBySerial`, ~line 38)
- Modify: `src/app/actions/scan.ts`
- Test: `src/app/actions/scan.test.ts`

**Interfaces:**
- Consumes: `ScanIntent` from Task 1 (only its field names — this task imports nothing from it).
- Produces:
  - `getItemBySerialForScan(serialNumber: string)` → `Promise<{ id: string; make: string; model: string; serialNumber: string; status: ItemStatus } | null>`
  - `lookupScannedSerial(serial: string, altSerial?: string): Promise<ScanLookup>` — the builder's path. ACTIVE only, returns display fields.
  - `resolveScannedSerial(serial: string, altSerial?: string): Promise<SerialResolution>` — the items-list path. Any status, returns an id only.
  - `type SerialResolution = { ok: true; itemId: string } | { ok: false; code: "NOT_FOUND" | "UNAUTHORIZED" | "FAILED" }`

- [ ] **Step 1: Write the failing test**

Append to `src/app/actions/scan.test.ts`. Also extend the existing `vi.mock("@/modules/items/items.service", ...)` block at the top of that file so it exposes the new function — the current mock factory lists only `getItem`:

```ts
// --- replace the existing items.service mock block (currently lines 4 and 11-13) ---
const getItem = vi.fn();
const getItemBySerialForScan = vi.fn();

vi.mock("@/modules/items/items.service", () => ({
  getItem: (id: string) => getItem(id),
  getItemBySerialForScan: (sn: string) => getItemBySerialForScan(sn),
}));
```

Add `getItemBySerialForScan.mockResolvedValue(ITEM);` to the existing `beforeEach`, and import the two new actions on the existing import line:

```ts
import { lookupScannedItem, lookupScannedSerial, resolveScannedSerial } from "./scan";
```

Then append these suites:

```ts
describe("lookupScannedSerial", () => {
  it("resolves a serial to the item's display fields", async () => {
    const res = await lookupScannedSerial("SN1");
    expect(getItemBySerialForScan).toHaveBeenCalledWith("SN1");
    expect(res).toEqual({
      ok: true,
      item: { id: "i1", make: "Dell", model: "L5420", serialNumber: "SN1" },
      holderName: null,
    });
  });

  it("never returns admin-only fields", async () => {
    const res = await lookupScannedSerial("SN1");
    expect(JSON.stringify(res)).not.toContain("ADMIN ONLY");
  });

  // The Express Service Code fallback. The raw value is tried first, so a
  // numeric serial that really exists can never be overtaken by a conversion.
  it("falls back to the alternate serial only when the first misses", async () => {
    getItemBySerialForScan.mockResolvedValueOnce(null).mockResolvedValueOnce(ITEM);
    const res = await lookupScannedSerial("17237164935", "7X2K9L3");
    expect(getItemBySerialForScan).toHaveBeenNthCalledWith(1, "17237164935");
    expect(getItemBySerialForScan).toHaveBeenNthCalledWith(2, "7X2K9L3");
    expect(res).toMatchObject({ ok: true });
  });

  it("does not query the alternate when the first serial hits", async () => {
    await lookupScannedSerial("SN1", "7X2K9L3");
    expect(getItemBySerialForScan).toHaveBeenCalledTimes(1);
  });

  it("refuses a serial that is in no item", async () => {
    getItemBySerialForScan.mockResolvedValue(null);
    expect(await lookupScannedSerial("NOPE1234")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  // Mirrors lookupScannedItem — a scan must not be a backdoor around the ACTIVE
  // filter the builder applies on load.
  it("refuses a retired item", async () => {
    getItemBySerialForScan.mockResolvedValue({ ...ITEM, status: "RETIRED" });
    expect(await lookupScannedSerial("SN1")).toEqual({ ok: false, code: "RETIRED" });
  });

  it("checks auth before touching any data", async () => {
    requireUser.mockRejectedValue(new AuthError("UNAUTHENTICATED"));
    expect(await lookupScannedSerial("SN1")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(getItemBySerialForScan).not.toHaveBeenCalled();
  });

  it("refuses blank input without a query", async () => {
    expect(await lookupScannedSerial("  ")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(getItemBySerialForScan).not.toHaveBeenCalled();
  });

  it("returns FAILED and logs on an unexpected error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getItemBySerialForScan.mockRejectedValue(new Error("db is on fire"));
    expect(await lookupScannedSerial("SN1")).toEqual({ ok: false, code: "FAILED" });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("resolveScannedSerial", () => {
  it("returns the item id", async () => {
    expect(await resolveScannedSerial("SN1")).toEqual({ ok: true, itemId: "i1" });
  });

  // Deliberately UNLIKE lookupScannedSerial: /items is a lookup surface, not a
  // transfer surface, and a retired item has a perfectly good page to open.
  it("resolves a retired item too", async () => {
    getItemBySerialForScan.mockResolvedValue({ ...ITEM, status: "RETIRED" });
    expect(await resolveScannedSerial("SN1")).toEqual({ ok: true, itemId: "i1" });
  });

  it("falls back to the alternate serial", async () => {
    getItemBySerialForScan.mockResolvedValueOnce(null).mockResolvedValueOnce(ITEM);
    expect(await resolveScannedSerial("17237164935", "7X2K9L3")).toEqual({ ok: true, itemId: "i1" });
  });

  it("refuses an unknown serial", async () => {
    getItemBySerialForScan.mockResolvedValue(null);
    expect(await resolveScannedSerial("NOPE1234")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("checks auth before touching any data", async () => {
    requireUser.mockRejectedValue(new AuthError("UNAUTHENTICATED"));
    expect(await resolveScannedSerial("SN1")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(getItemBySerialForScan).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run actions/scan`
Expected: FAIL — `lookupScannedSerial is not a function`.

- [ ] **Step 3: Add the service function**

In `src/modules/items/items.service.ts`, directly below the existing `getItemBySerial` (which selects `id` only and is used by `createItemAction`'s P2002 branch — leave it alone):

```ts
/** The columns a scan needs, in one query: identity for display, status for the
 *  ACTIVE gate. Deliberately NOT the whole row — the result is returned from a
 *  Server Action into a Client Component, so every column selected here is
 *  serialized into the RSC payload and reaches the browser.
 *
 *  `serialNumber` is @unique @db.Citext, so this matches regardless of casing
 *  and can return at most one row. */
export function getItemBySerialForScan(serialNumber: string) {
  return prisma.item.findUnique({
    where: { serialNumber },
    select: { id: true, make: true, model: true, serialNumber: true, status: true },
  });
}
```

- [ ] **Step 4: Add the two actions**

In `src/app/actions/scan.ts`, add `getItemBySerialForScan` to the existing import from `@/modules/items/items.service`, then append:

```ts
export type SerialResolution =
  | { ok: true; itemId: string }
  | { ok: false; code: "NOT_FOUND" | "UNAUTHORIZED" | "FAILED" };

/** Resolve a scanned serial, trying the raw value first and the alternate
 *  (a converted Dell Express Service Code) only if it misses. At most two
 *  queries, the second only on a miss — see scan-code.ts for why the order
 *  matters. Returns null when neither names an item. */
async function findBySerial(serial: string, altSerial?: string) {
  const first = await getItemBySerialForScan(serial);
  if (first) return first;
  const alt = altSerial?.trim();
  if (!alt || alt === serial) return null;
  return getItemBySerialForScan(alt);
}

/**
 * Resolves a scanned manufacturer serial for the hand-receipt builder — the
 * serial-shaped twin of lookupScannedItem, and it keeps that function's rules:
 * any ACTIVE authenticated user may look one up (inventory is shared org-wide),
 * a non-ACTIVE item is refused, and the return is an explicit field subset
 * rather than the Prisma row.
 */
export async function lookupScannedSerial(serial: string, altSerial?: string): Promise<ScanLookup> {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, code: "UNAUTHORIZED" };
    console.error("[lookupScannedSerial] auth check failed:", e);
    return { ok: false, code: "FAILED" };
  }

  const sn = serial.trim();
  if (!sn) return { ok: false, code: "NOT_FOUND" };

  try {
    const item = await findBySerial(sn, altSerial);
    if (!item) return { ok: false, code: "NOT_FOUND" };
    if (item.status !== "ACTIVE") return { ok: false, code: "RETIRED" };

    const holder = await getLastReceiver(item.id);
    return {
      ok: true,
      item: { id: item.id, make: item.make, model: item.model, serialNumber: item.serialNumber },
      holderName: holder?.name ?? null,
    };
  } catch (e) {
    console.error("[lookupScannedSerial] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}

/**
 * Resolves a scanned serial to an item id for the /items list.
 *
 * Deliberately does NOT apply the ACTIVE filter lookupScannedSerial does: that
 * rule exists because the builder is about to put the item on a hand receipt,
 * and this surface only opens a page. A retired device is exactly the kind of
 * thing someone scans to ask "what is this and why is it on the shelf".
 *
 * Returns an id and nothing else — the item page does its own gated fetch.
 */
export async function resolveScannedSerial(serial: string, altSerial?: string): Promise<SerialResolution> {
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
    return item ? { ok: true, itemId: item.id } : { ok: false, code: "NOT_FOUND" };
  } catch (e) {
    console.error("[resolveScannedSerial] unexpected error:", e);
    return { ok: false, code: "FAILED" };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run actions/scan`
Expected: PASS — the 9 pre-existing `lookupScannedItem` tests plus 14 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/modules/items/items.service.ts src/app/actions/scan.ts src/app/actions/scan.test.ts
git commit -m "feat(items): resolve a scanned serial to an item"
```

---

### Task 3: Teach `QrScanner` other barcode formats

**Files:**
- Modify: `src/components/QrScanner.tsx`

**Interfaces:**
- Produces:
  - `SCAN_FORMATS: readonly string[]` — the shared format list, exported so both call sites pass the same one.
  - `QrScanner` gains an optional prop `formats?: readonly string[]`, defaulting to `["qr_code"]`.

There is no unit test for this task — the component owns a camera and a wasm decoder, neither of which exists in jsdom. It is verified by the device test in Task 6. Keep the change this small precisely because it cannot be tested here.

- [ ] **Step 1: Add the exported format list and the prop**

At the top of `src/components/QrScanner.tsx`, below the existing imports:

```ts
// The formats both scan surfaces enable. Shared so the two cannot drift.
//
// Dell's service-tag barcode is Code 39 on older labels and Code 128 on newer
// ones; recent labels also carry a DataMatrix square. HP prints Code 128.
// Each enabled format costs time in EVERY detect() call, so this list is
// deliberately short — if decoding is visibly slow on a real phone, drop
// data_matrix first.
export const SCAN_FORMATS = ["qr_code", "code_39", "code_128", "data_matrix"] as const;
```

Change the `Props` type (currently line 5):

```ts
type Props = {
  onDecode: (text: string) => void;
  onClose: () => void;
  notice?: Notice;
  /** Defaults to QR only, so an existing caller is unchanged. */
  formats?: readonly string[];
};
```

Change the signature (currently line 18):

```ts
export function QrScanner({ onDecode, onClose, notice, formats = ["qr_code"] }: Props) {
```

- [ ] **Step 2: Pass the formats to the detector**

Replace the detector construction (currently line 74):

```ts
        detector = new BarcodeDetector({ formats: [...formats] });
```

The effect's dependency array stays `[]`. That is deliberate and matches the existing `onDecode` handling: re-running it would tear down and re-acquire the camera. A caller that needs different formats should remount the sheet.

Add a comment above it so the next reader does not "fix" the empty deps:

```ts
      // `formats` is read once, on mount. The effect deliberately does not
      // depend on it — re-running would stop and re-acquire the camera stream
      // mid-scan. Same reasoning as onDecodeRef above.
```

- [ ] **Step 3: Add the camera resolution hint**

Replace the `getUserMedia` call (currently line 37):

```ts
        // A linear barcode needs materially more horizontal resolution than a
        // QR code to resolve — the bars are thin and there is no error
        // correction. `ideal` is a request, not a requirement, so a device that
        // cannot honour it still gets a working camera.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 } },
        });
```

- [ ] **Step 4: Verify it compiles and existing tests still pass**

Run: `npm run build`
Expected: build succeeds.

Run: `npx vitest run ReceiptBuilderForm`
Expected: PASS — the builder's existing tests mock this component, so they must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/components/QrScanner.tsx
git commit -m "feat(scan): let the scan sheet decode 1D and DataMatrix barcodes"
```

---

### Task 4: Wire the receipt builder

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx` (imports ~line 13-15; `lastDecode` ~line 380; `onDecode` lines 402-458; the two `<QrScanner>` render sites)
- Test: `src/app/receipts/new/ReceiptBuilderForm.test.tsx`

**Interfaces:**
- Consumes: `parseScan`, `ScanIntent` (Task 1); `lookupScannedSerial` (Task 2); `SCAN_FORMATS` (Task 3).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing tests**

In `src/app/receipts/new/ReceiptBuilderForm.test.tsx`, extend the existing scan-action mock (currently `lookupScannedItem` only, ~line 64-66):

```ts
const lookupScannedItem = vi.fn();
const lookupScannedSerial = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  lookupScannedItem: (id: string) => lookupScannedItem(id),
  lookupScannedSerial: (sn: string, alt?: string) => lookupScannedSerial(sn, alt),
}));
```

Add to the scan `describe` block (the one with `beforeEach(() => lookupScannedItem.mockResolvedValue(HP))`, ~line 478) — mirror the surrounding file's existing helpers for opening the sheet and firing a decode rather than inventing new ones:

```ts
  it("adds an item scanned from a manufacturer serial", async () => {
    lookupScannedSerial.mockResolvedValue(HP);
    await openScannerAndDecode("5CD1234ABC");
    expect(lookupScannedSerial).toHaveBeenCalledWith("5CD1234ABC", undefined);
    expect(lookupScannedItem).not.toHaveBeenCalled();
  });

  it("passes the converted express service code as the alternate", async () => {
    lookupScannedSerial.mockResolvedValue(HP);
    await openScannerAndDecode("17237164935");
    expect(lookupScannedSerial).toHaveBeenCalledWith("17237164935", "7X2K9L3");
  });

  it("names the serial when nothing in the book matches it", async () => {
    lookupScannedSerial.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    await openScannerAndDecode("5CD1234ABC");
    expect(await screen.findByText(/No item in the book with serial 5CD1234ABC/i)).toBeTruthy();
  });

  // The dedupe window keys on the INTENT, not on an item id — a linear barcode
  // re-decodes every frame exactly as a QR does.
  it("ignores the same serial decoded twice in quick succession", async () => {
    lookupScannedSerial.mockResolvedValue(HP);
    await openScannerAndDecode("5CD1234ABC");
    await openScannerAndDecode("5CD1234ABC");
    expect(lookupScannedSerial).toHaveBeenCalledTimes(1);
  });

  it("still refuses a decode that is neither a sticker nor a serial", async () => {
    await openScannerAndDecode("CN-0ABCDE-12345-ABC-1234-A00");
    expect(lookupScannedSerial).not.toHaveBeenCalled();
    expect(lookupScannedItem).not.toHaveBeenCalled();
  });
```

If the file has no `openScannerAndDecode` helper, write one at the top of that describe block that does exactly what the existing scan tests do to open the sheet and invoke the mocked component's `onDecode` — do not change how the existing tests drive it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ReceiptBuilderForm`
Expected: FAIL — `lookupScannedSerial` never called (the component still calls `parseItemScan` and refuses a bare serial with "Not an item code").

- [ ] **Step 3: Update the imports**

In `src/app/receipts/new/ReceiptBuilderForm.tsx`, replace the `parseItemScan` import (line 13) and extend the others:

```ts
import { parseScan } from "@/modules/items/scan-code";
import { lookupScannedItem, lookupScannedSerial } from "@/app/actions/scan";
import { QrScanner, SCAN_FORMATS } from "@/components/QrScanner";
```

- [ ] **Step 4: Re-key the dedupe ref**

Replace the `lastDecode` declaration (currently ~line 378-380):

```ts
  // A code sitting in frame decodes many times a second, so the same intent
  // inside this window is the camera repeating itself, not a second laptop.
  // Keyed on the INTENT ("id:x" / "sn:y"), not an item id: a linear barcode
  // re-decodes every frame exactly as a QR does, and a serial has no id yet.
  const lastDecode = useRef<{ key: string; at: number }>({ key: "", at: 0 });
```

- [ ] **Step 5: Rewrite `onDecode`**

Replace lines 402-458 (the whole `onDecode`) with:

```ts
  const onDecode = async (text: string) => {
    const intent = parseScan(text);
    // Rejected client-side, so a stray barcode never costs a round trip.
    if (!intent) return say("err", "Not an item code");

    if (looking.current) return; // a lookup is already in flight; drop this frame

    // Time-window dedupe: the same intent within 1.5s of the last PROCESSED
    // decode is the camera repeating a code still in frame. Checked AFTER the
    // in-flight guard and recorded only when we actually proceed — otherwise a
    // decode dropped for concurrency would arm the window against its own retry
    // and suppress a legitimate item for up to 1.5s.
    const key = intent.kind === "item" ? `id:${intent.id}` : `sn:${intent.serial}`;
    const now = Date.now();
    if (lastDecode.current.key === key && now - lastDecode.current.at < 1500) return;
    lastDecode.current = { key, at: now };

    looking.current = true;
    try {
      // Duplicate check, before the round trip. An item scan knows the id; a
      // serial scan does not, so it matches on the serial instead — compared
      // case-insensitively because serialNumber is citext and the label may be
      // printed in either case.
      const dup =
        intent.kind === "item"
          ? itemsRef.current.find((i) => i.itemId === intent.id)
          : itemsRef.current.find((i) => i.serialNumber.toLowerCase() === intent.serial.toLowerCase());
      if (dup) return say("err", `Already added — ${dup.make} ${dup.model} · SN ${dup.serialNumber}`);

      const res =
        intent.kind === "item"
          ? await lookupScannedItem(intent.id)
          : await lookupScannedSerial(intent.serial, intent.altSerial);

      if (!res.ok) {
        // NOT_FOUND means different things on the two paths: our own sticker
        // names an item that existed when it was printed, while a factory label
        // may simply never have been in the book.
        const notFound =
          intent.kind === "item"
            ? "That item no longer exists"
            : `No item in the book with serial ${intent.serial}`;
        const msg: Record<typeof res.code, string> = {
          NOT_FOUND: notFound,
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

- [ ] **Step 6: Pass the formats at both render sites**

Find every `<QrScanner` in this file (there are two) and add the prop:

```tsx
<QrScanner formats={SCAN_FORMATS} onDecode={onDecode} onClose={() => setScanning(false)} notice={toast} />
```

Keep each site's existing props exactly as they are; only add `formats`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run ReceiptBuilderForm`
Expected: PASS — every pre-existing builder test plus the 5 new ones. If a pre-existing test that asserted `"Not an item code"` for a plain string now fails, that string was a valid serial shape: change the fixture to something punctuated (`"CN-0ABC-123"`), not the assertion.

- [ ] **Step 8: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx src/app/receipts/new/ReceiptBuilderForm.test.tsx
git commit -m "feat(receipts): add items to a receipt by scanning the factory label"
```

---

### Task 5: The `/items` scan button

**Files:**
- Create: `src/app/items/ItemsScanButton.tsx`
- Create: `src/app/items/ItemsScanButton.test.tsx`
- Modify: `src/app/items/page.tsx`

**Interfaces:**
- Consumes: `parseScan` (Task 1); `resolveScannedSerial` (Task 2); `QrScanner`, `SCAN_FORMATS` (Task 3).
- Produces: `ItemsScanButton` — no props.

- [ ] **Step 1: Write the failing test**

Create `src/app/items/ItemsScanButton.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const resolveScannedSerial = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  resolveScannedSerial: (sn: string, alt?: string) => resolveScannedSerial(sn, alt),
}));

vi.mock("@/lib/beep", () => ({ beep: vi.fn() }));

// The real component owns a camera and a wasm decoder, neither of which exists
// here. This stand-in exposes its onDecode as a button so the wiring around it
// can be tested.
let decode: (text: string) => void = () => {};
vi.mock("@/components/QrScanner", () => ({
  SCAN_FORMATS: ["qr_code"],
  QrScanner: ({ onDecode }: { onDecode: (t: string) => void }) => {
    decode = onDecode;
    return <div data-testid="scanner" />;
  },
}));

import { ItemsScanButton } from "./ItemsScanButton";

const open = async () => {
  await userEvent.click(screen.getByRole("button", { name: /scan/i }));
  await screen.findByTestId("scanner");
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveScannedSerial.mockResolvedValue({ ok: true, itemId: "i9" });
});

describe("ItemsScanButton", () => {
  it("opens the item when our own sticker is scanned, without a round trip", async () => {
    render(<ItemsScanButton />);
    await open();
    decode("https://www.dcsim.us/i/abc123");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/i/abc123"));
    expect(resolveScannedSerial).not.toHaveBeenCalled();
  });

  it("opens the item a scanned serial resolves to", async () => {
    render(<ItemsScanButton />);
    await open();
    decode("5CD1234ABC");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/i/i9"));
    expect(resolveScannedSerial).toHaveBeenCalledWith("5CD1234ABC", undefined);
  });

  // The create-from-search flow already lives on /items: the empty state offers
  // "+ Create <serial> as a new item" to an admin. Landing there reuses it
  // rather than growing a second create path with its own admin gate.
  it("lands on the filtered list when the serial is in no item", async () => {
    resolveScannedSerial.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    render(<ItemsScanButton />);
    await open();
    decode("NOPE1234");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/items?q=NOPE1234"));
  });

  it("passes the converted express service code as the alternate", async () => {
    render(<ItemsScanButton />);
    await open();
    decode("17237164935");
    await waitFor(() => expect(resolveScannedSerial).toHaveBeenCalledWith("17237164935", "7X2K9L3"));
  });

  it("keeps scanning after an unreadable code", async () => {
    render(<ItemsScanButton />);
    await open();
    decode("CN-0ABCDE-12345-ABC-1234-A00");
    await waitFor(() => expect(screen.getByTestId("scanner")).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ItemsScanButton`
Expected: FAIL — `Failed to resolve import "./ItemsScanButton"`.

- [ ] **Step 3: Write the component**

Create `src/app/items/ItemsScanButton.tsx`:

```tsx
"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QrScanner, SCAN_FORMATS } from "@/components/QrScanner";
import { parseScan } from "@/modules/items/scan-code";
import { resolveScannedSerial } from "@/app/actions/scan";
import { beep } from "@/lib/beep";

// Scan a code to jump to its item. Deliberately thinner than the builder's
// scan flow: this surface navigates away, so there is no list to keep in sync,
// no duplicate check and no dedupe window — the first decode that resolves ends
// the sheet's life.
export function ItemsScanButton() {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Latches on the decode that wins. The decode loop keeps firing while the
  // route transition is in flight, so without this a second frame starts
  // another lookup for a page that is already leaving.
  const done = useRef(false);

  const say = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    beep(kind);
  };

  const onDecode = async (text: string) => {
    if (done.current) return;

    const intent = parseScan(text);
    if (!intent) return say("err", "Not an item code");

    if (intent.kind === "item") {
      done.current = true;
      router.push(`/i/${intent.id}`);
      return;
    }

    done.current = true;
    const res = await resolveScannedSerial(intent.serial, intent.altSerial);
    if (res.ok) {
      router.push(`/i/${res.itemId}`);
      return;
    }
    if (res.code === "NOT_FOUND") {
      // Not a dead end: /items' own empty state offers an admin
      // "+ Create <serial> as a new item", linking to the new-item form with
      // the serial prefilled. Reusing it keeps ONE create path and one admin
      // gate. URLSearchParams does the encoding — a serial containing a
      // character that means something in a query string would otherwise land
      // on the wrong list.
      router.push(`/items?${new URLSearchParams({ q: intent.serial })}`);
      return;
    }

    // Recoverable: let the operator try again rather than closing the sheet.
    done.current = false;
    say("err", res.code === "UNAUTHORIZED" ? "Your session expired — sign in again" : "Couldn't look up that code — try again");
  };

  if (!scanning) {
    return (
      <button type="button" className="btn btn-secondary" onClick={() => { done.current = false; setNotice(null); setScanning(true); }}>
        Scan
      </button>
    );
  }

  return (
    <QrScanner
      formats={SCAN_FORMATS}
      onDecode={onDecode}
      onClose={() => setScanning(false)}
      notice={notice}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run ItemsScanButton`
Expected: PASS, 5 tests.

- [ ] **Step 5: Render it on the items page**

In `src/app/items/page.tsx`, find where `<ItemsSearchInput ... />` is rendered and place the button beside it, inside the same row:

```tsx
import { ItemsScanButton } from "./ItemsScanButton";
```

```tsx
<div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
  <ItemsSearchInput q={q} sortKeys={sortKeys} uic={uic} />
  <ItemsScanButton />
</div>
```

Match the surrounding markup rather than this snippet if the search input is already inside a wrapper — the goal is the button sitting next to the search box, not a new layout. `page.tsx` is a Server Component and `ItemsScanButton` is a Client Component, which is the ordinary direction; no `"use client"` goes in the page.

- [ ] **Step 6: Verify the page still builds and the page tests pass**

Run: `npm run build`
Expected: build succeeds.

Run: `npx vitest run items`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/items/ItemsScanButton.tsx src/app/items/ItemsScanButton.test.tsx src/app/items/page.tsx
git commit -m "feat(items): scan a code from the items list to open its item"
```

---

### Task 6: Changelog, full suite, and the device test

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS. Needs the test DB up. **Do not run this if another agent is running it** — the suite shares one test DB and concurrent runs truncate each other.

- [ ] **Step 2: Run the linter**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Add the changelog entry**

In `CHANGELOG.md`, under a `## 2026-08-08` heading (create it at the top if today's section does not exist yet; if it does, add to its `### Added`):

```markdown
### Added
- **You can now scan the manufacturer's own barcode on a laptop instead of the QR sticker this app prints.** Until now the camera only read our stickers, so a device whose sticker was never applied, has peeled off or has worn illegible could only be added to a hand receipt by finding it in the items list by hand. The scanner now also reads the factory label — a Dell service tag, an HP serial, and the Code 39, Code 128 and DataMatrix barcodes those labels use. It works in two places: on the hand-receipt builder, where a scanned device is added to the receipt exactly as scanning a sticker does; and on the items list, where a new **Scan** button beside the search box opens whatever device you point it at. Our own stickers keep working exactly as before — this is an additional way in, not a replacement.

  Three things worth knowing. Dell prints two barcodes a centimetre apart — the **Service Tag** and the **Express Service Code** — and they are the same number written two ways, so scanning either one finds the same machine rather than leaving you wondering why one of them "doesn't work". If a scanned serial is in no item on the **items list**, you land on the search results for it, where an administrator is offered the usual "create this as a new item" link with the serial already filled in. On the **hand-receipt builder** a serial that matches nothing just says so and keeps scanning: it deliberately does not offer to create the item, because leaving the page would discard the receipt you are part-way through building, signature included.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note manufacturer barcode scanning"
```

- [ ] **Step 5: Verify on a real phone — this is the acceptance test**

Nothing above proves the camera decodes a Dell label. jsdom has no camera and `next build` has no layout engine. The camera also needs a **secure context**, so it will not work over plain `http://<lan-ip>:3000` — serve the dev server through the cloudflared tunnel (see the iPhone tunnel testing notes: `allowedDevOrigins` in `next.config.ts` for hydration, `AUTH_TRUST_HOST=true` for login).

With a physical Dell laptop in hand, confirm each of these:

1. `/receipts/new` → **Scan** → point at the **Service Tag** barcode. The device is added, with the right make, model and serial.
2. Point at the **Express Service Code** barcode on the same label. The same device is added — not a "no item" message.
3. Scan the same label twice in a row. It is added once and the second scan says "Already added", not a duplicate row.
4. Scan a device that is genuinely not in the book. It reports `No item in the book with serial …` and the camera stays open.
5. Scan an existing **QR sticker**. Still works, unchanged.
6. `/items` → **Scan** → a Dell label opens that item's page.
7. `/items` → **Scan** → an unknown serial lands on `/items?q=<serial>`; as an admin, the "+ Create … as a new item" link is present with the serial filled in.
8. Watch the preview while aiming. If it is visibly sluggish compared to QR scanning, drop `"data_matrix"` from `SCAN_FORMATS` and re-test — each enabled format costs time in every frame.

Record the outcome. If a linear barcode will not decode at all, the first thing to check is lighting and distance (linear codes need more resolution than QR), then whether the `width: { ideal: 1920 }` constraint was actually honoured — `stream.getVideoTracks()[0].getSettings()` in the console reports what the camera really gave you.

---

## Self-Review

**Spec coverage.** Pure parse layer → Task 1. `formats` prop + resolution hint → Task 3. `lookupScannedSerial` → Task 2. Express Service Code with the leading-zero pad → Tasks 1 and 2. Builder behaviour, intent-keyed dedupe, no create offer → Task 4. Items-list scan and the `/items?q=` no-match path → Task 5. Testing → per-task, plus the device protocol in Task 6. CHANGELOG → Task 6.

**Two deliberate deviations from the spec**, both to be reflected back into the spec document before implementation starts:

1. **The spec described one action; this plan has two.** `lookupScannedSerial` refuses a non-ACTIVE item because the builder is about to put it on a hand receipt. The items list is a *lookup* surface where a retired device has a perfectly good page to open, and it needs an id rather than display fields. Folding both into one action would have meant a mode flag. `resolveScannedSerial` is the second, ~20 lines, sharing `findBySerial`.
2. **The Express Service Code is a fallback, not a substitution.** The spec said an 8–11 digit value "is converted". Converting outright would rewrite a genuinely numeric serial into a 7-character tag naming a different machine. The raw value is tried first and the conversion offered as `altSerial`, so a wrong conversion cannot win — at the cost of one extra query only when the raw value misses.

**Placeholders:** none. Every code step carries the actual code.

**Type consistency:** `ScanIntent` (Task 1) is consumed by Tasks 4 and 5 with the same field names (`kind`, `id`, `serial`, `altSerial`). `ScanLookup` is the pre-existing type in `scan.ts`, reused unchanged by `lookupScannedSerial`. `SerialResolution` is defined in Task 2 and consumed in Task 5 as `{ok, itemId}` / `{ok, code}`. `getItemBySerialForScan` is defined in Task 2 Step 3 and used in Step 4 with the same name. `SCAN_FORMATS` is defined in Task 3 and imported in Tasks 4 and 5.
