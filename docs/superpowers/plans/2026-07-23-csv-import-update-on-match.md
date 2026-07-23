# CSV Import Update-on-Match + MDM Telemetry Fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CSV item importer update an existing item's changed fields (instead of skipping it as a duplicate) when the serial matches, add an importable assigned-user field plus four MDM telemetry fields, and relax which fields are required.

**Architecture:** Matching stays keyed on the citext-unique `serialNumber`. Pure `planImport` sorts each row into create / update / unchanged / skipped and computes per-field diffs; `commitImport` runs one transaction that `createMany`s new items and issues per-match `update`s (+ an `ItemEdit` for the two logged fields). Four new nullable text columns hold telemetry; make/model stay NOT NULL.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Prisma 7 over Postgres (citext), Zod, Vitest.

## Global Constraints

- Every Server Action starts with `requireAdmin()` (import is admin-only) — already true; do not remove.
- Never query inside a loop for reads; batch with one `findMany`. Per-match `update`/`itemEdit.create` writes are individual (distinct values) and bounded by the 2000-row import cap.
- `select` only the columns a query needs; never pull signature blobs/PII into list/search queries.
- `serialNumber` is `@unique @db.Citext` — compare case-insensitively via `.toLowerCase()` keys.
- Docs are part of the change: `CHANGELOG.md` entry under `## 2026-07-23` + any contradicted `CLAUDE.md` text update ship in the same work (Task 10).
- The public/logged-out `/i/*` view must stay PII-minimal — new telemetry (incl. `lastLogonUserPrincipalName`, an email) renders only for a logged-in session.
- Migrations run via authored SQL + `npx prisma migrate deploy` (interactive `migrate dev` cannot run in this shell). Prod is hand-applied separately.

---

### Task 1: Add DB columns (migration + Prisma schema)

**Files:**
- Modify: `prisma/schema.prisma` (Item model ~line 84-96; ImportBatch model ~line 233-244)
- Create: `prisma/migrations/20260723000000_add_mdm_telemetry_fields/migration.sql`

**Interfaces:**
- Produces: `Item.lastLogonUserPrincipalName`, `Item.lastLogonDate`, `Item.enrollmentDate`, `Item.compliance` (all `String?`); `ImportBatch.updatedCount Int @default(0)`.

- [ ] **Step 1: Add the four Item columns to the schema**

In `prisma/schema.prisma`, in `model Item`, immediately after the `currentPosition String?` line (before `status`):

```prisma
  // MDM telemetry, imported from the asset/MDM CSV export and refreshed on each
  // import. Stored as-is (plain text — no date parsing). Nullable; blank on import
  // leaves the stored value untouched. Not editable from the UI.
  lastLogonUserPrincipalName String?
  lastLogonDate              String?
  enrollmentDate             String?
  compliance                 String?
```

- [ ] **Step 2: Add updatedCount to ImportBatch**

In `model ImportBatch`, after `addedCount   Int`:

```prisma
  updatedCount Int      @default(0)
```

- [ ] **Step 3: Author the migration SQL**

Create `prisma/migrations/20260723000000_add_mdm_telemetry_fields/migration.sql`:

```sql
-- Add MDM telemetry columns to Item (all nullable, plain text)
ALTER TABLE "Item" ADD COLUMN "lastLogonUserPrincipalName" TEXT;
ALTER TABLE "Item" ADD COLUMN "lastLogonDate" TEXT;
ALTER TABLE "Item" ADD COLUMN "enrollmentDate" TEXT;
ALTER TABLE "Item" ADD COLUMN "compliance" TEXT;

-- Track how many items an import updated (in addition to added)
ALTER TABLE "ImportBatch" ADD COLUMN "updatedCount" INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Regenerate the client and validate**

Run: `npx prisma generate && npx prisma validate`
Expected: generates without error; "The schema at prisma/schema.prisma is valid".

- [ ] **Step 5: Apply to the test DB and confirm it deploys**

Run: `npx prisma migrate deploy`
Expected: "Applying migration `20260723000000_add_mdm_telemetry_fields`" then "All migrations have been applied." (No drift error. If deploy reports the migration already recorded, re-check the folder name is unique.)

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260723000000_add_mdm_telemetry_fields/migration.sql
git commit -m "feat: add MDM telemetry columns and ImportBatch.updatedCount"
```

---

### Task 2: Parse the new columns; relax required columns (`csv.ts`)

**Files:**
- Modify: `src/modules/items/csv.ts`
- Test: `src/modules/items/csv.test.ts`

**Interfaces:**
- Produces: `RawRow` gains `assignedUser`, `lastLogonUserPrincipalName`, `lastLogonDate`, `enrollmentDate`, `compliance` (all `string`, default `""`). Only `serialNumber` is a required column now.

- [ ] **Step 1: Update existing tests for the widened RawRow and relaxed required columns**

In `src/modules/items/csv.test.ts`, replace the first test's `toEqual` (it asserts an exact object that no longer matches) and update the "required header" test. Replace lines 5-25 with:

```ts
  it("parses rows and maps case-insensitive, aliased headers", () => {
    const csv = "Make,Model,Serial Number,Device Name,Home Unit,Notes\nM4,Carbine,A1,Radio,A Co,tan\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({
      row: 1, make: "M4", model: "Carbine", serialNumber: "A1", deviceName: "Radio", homeUnit: "A Co", notes: "tan",
      assignedUser: "", lastLogonUserPrincipalName: "", lastLogonDate: "", enrollmentDate: "", compliance: "",
    });
  });

  it("maps the new assignedUser + telemetry headers in any column order and any case", () => {
    const csv =
      "SerialNumber,Compliance,Assigned User,LASTLOGONDATE,lastLogonUserPrincipalName,EnrollmentDate\n" +
      "A1,Compliant,jane@x.mil,2026-07-01,jane@x.mil,2025-01-15\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({
      serialNumber: "A1", compliance: "Compliant", assignedUser: "jane@x.mil",
      lastLogonDate: "2026-07-01", lastLogonUserPrincipalName: "jane@x.mil", enrollmentDate: "2025-01-15",
    });
  });

  it("requires only the serialNumber column (make/model/deviceName optional)", () => {
    const { rows, error } = parseItemsCsv("serialNumber,compliance\nA1,Compliant\n");
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({ serialNumber: "A1", make: "", model: "", deviceName: "" });
  });

  it("handles quoted fields with embedded commas and skips blank lines", () => {
    const csv = 'make,model,serialNumber,deviceName,notes\nM4,Carbine,A1,Radio,"tan, worn"\n\nPVS,14,B7,Radio,\n';
    const { rows } = parseItemsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].notes).toBe("tan, worn");
    expect(rows[1]).toMatchObject({ row: 2, make: "PVS", serialNumber: "B7", notes: "" });
  });

  it("errors when the serialNumber column is missing", () => {
    const { error } = parseItemsCsv("make,model\nM4,Carbine\n");
    expect(error).toMatch(/serialNumber/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/items/csv.test.ts`
Expected: FAIL — new headers map to `""`/undefined and the missing-column list still includes make/model/deviceName.

- [ ] **Step 3: Widen RawRow and the header map; require only serialNumber**

In `src/modules/items/csv.ts`:

Replace the `RawRow` type (lines 5-13):

```ts
export type RawRow = {
  row: number;
  make: string;
  model: string;
  serialNumber: string;
  deviceName: string;
  homeUnit: string;
  notes: string;
  assignedUser: string;
  lastLogonUserPrincipalName: string;
  lastLogonDate: string;
  enrollmentDate: string;
  compliance: string;
};
```

Replace the `HEADER_MAP` (lines 16-24):

```ts
const HEADER_MAP: Record<string, keyof Omit<RawRow, "row">> = {
  make: "make",
  model: "model",
  serialnumber: "serialNumber",
  serial: "serialNumber",
  devicename: "deviceName",
  homeunit: "homeUnit",
  notes: "notes",
  assigneduser: "assignedUser",
  lastlogonuserprincipalname: "lastLogonUserPrincipalName",
  lastlogondate: "lastLogonDate",
  enrollmentdate: "enrollmentDate",
  compliance: "compliance",
};
```

Replace the required-column check (lines 48-50):

```ts
  const present = new Set(headers);
  const missing = (["serialNumber"] as const).filter((k) => !present.has(k));
  if (missing.length) return { rows: [], error: `Missing required column(s): ${missing.join(", ")}.` };
```

Replace the row mapping (lines 56-64):

```ts
  const rows = records.map((r, i) => ({
    row: i + 1,
    make: r.make ?? "",
    model: r.model ?? "",
    serialNumber: r.serialNumber ?? "",
    deviceName: r.deviceName ?? "",
    homeUnit: r.homeUnit ?? "",
    notes: r.notes ?? "",
    assignedUser: r.assignedUser ?? "",
    lastLogonUserPrincipalName: r.lastLogonUserPrincipalName ?? "",
    lastLogonDate: r.lastLogonDate ?? "",
    enrollmentDate: r.enrollmentDate ?? "",
    compliance: r.compliance ?? "",
  }));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/items/csv.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/csv.ts src/modules/items/csv.test.ts
git commit -m "feat: parse assignedUser + MDM telemetry columns; require only serial column"
```

---

### Task 3: Import row schema (`items.schema.ts`)

**Files:**
- Modify: `src/modules/items/items.schema.ts`
- Test: `src/modules/items/items.schema.test.ts`

**Interfaces:**
- Produces: `importRowSchema` (Zod) and `ImportRowInput` type. `serialNumber` required (`min(1, "serial number is required")`); `make, model, deviceName, homeUnit, notes, assignedUser, lastLogonUserPrincipalName, lastLogonDate, enrollmentDate, compliance` all optional (`""` → `undefined`).

- [ ] **Step 1: Write the failing test**

Append to `src/modules/items/items.schema.test.ts`:

```ts
import { importRowSchema } from "./items.schema";

describe("importRowSchema", () => {
  it("requires only serialNumber; blanks become undefined", () => {
    const r = importRowSchema.parse({ serialNumber: "A1", make: "", assignedUser: "  " });
    expect(r.serialNumber).toBe("A1");
    expect(r.make).toBeUndefined();
    expect(r.assignedUser).toBeUndefined();
  });

  it("rejects a blank serialNumber", () => {
    const res = importRowSchema.safeParse({ serialNumber: "   " });
    expect(res.success).toBe(false);
  });

  it("keeps provided telemetry values", () => {
    const r = importRowSchema.parse({ serialNumber: "A1", compliance: "Compliant", lastLogonDate: "2026-07-01" });
    expect(r.compliance).toBe("Compliant");
    expect(r.lastLogonDate).toBe("2026-07-01");
  });
});
```

(If the file has no top-level `import { describe, it, expect }`, add it — check the file head first.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/items/items.schema.test.ts`
Expected: FAIL — `importRowSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `src/modules/items/items.schema.ts`, after the `newItemSchema`/`NewItemInput` block (after line 18), add:

```ts
// Row shape for the CSV importer. Only serialNumber is hard-required here — the
// make/model-required-for-NEW-items rule lives in planImport, which alone knows
// whether the serial already exists. Reuses the `optional` helper so blank/absent
// cells become undefined ("not provided" → leave untouched on update).
export const importRowSchema = z.object({
  serialNumber: z.string().trim().min(1, "serial number is required"),
  make: optional,
  model: optional,
  deviceName: optional,
  homeUnit: optional,
  notes: optional,
  assignedUser: optional,
  lastLogonUserPrincipalName: optional,
  lastLogonDate: optional,
  enrollmentDate: optional,
  compliance: optional,
});

export type ImportRowInput = z.infer<typeof importRowSchema>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/items/items.schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/items/items.schema.test.ts
git commit -m "feat: add importRowSchema (serial-only required)"
```

---

### Task 4: Extend the diffable field set (`item-diff.ts`)

**Files:**
- Modify: `src/modules/items/item-diff.ts`
- Test: `src/modules/items/item-diff.test.ts`

**Interfaces:**
- Produces: `ItemLoggedFields` gains `lastLogonUserPrincipalName`, `lastLogonDate`, `enrollmentDate`, `compliance` (all `string | null`). `diffItemFields` unchanged in behavior — now also diffs those keys when present in `after`.

- [ ] **Step 1: Write the failing test**

Append a test to `src/modules/items/item-diff.test.ts` (inside the existing `describe`):

```ts
  it("diffs the new telemetry fields when present in after", () => {
    expect(
      diffItemFields(
        { compliance: "Noncompliant", lastLogonDate: "2026-01-01" },
        { compliance: "Compliant", lastLogonDate: "2026-01-01" },
      ),
    ).toEqual([{ field: "compliance", from: "Noncompliant", to: "Compliant" }]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/items/item-diff.test.ts`
Expected: FAIL — TypeScript error: `compliance`/`lastLogonDate` not assignable to `Partial<ItemLoggedFields>`.

- [ ] **Step 3: Extend the type**

In `src/modules/items/item-diff.ts`, add four fields to `ItemLoggedFields` (after `notes: string | null;`, line 21):

```ts
  lastLogonUserPrincipalName: string | null;
  lastLogonDate: string | null;
  enrollmentDate: string | null;
  compliance: string | null;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/items/item-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/item-diff.ts src/modules/items/item-diff.test.ts
git commit -m "feat: make telemetry fields diffable"
```

---

### Task 5: Rewrite `planImport` (create/update/unchanged buckets)

**Files:**
- Modify: `src/modules/items/import.ts`
- Test: `src/modules/items/import.test.ts`

**Interfaces:**
- Consumes: `importRowSchema` (Task 3), `diffItemFields`/`FieldChange`/`ItemLoggedFields` (Task 4), `RawRow` (Task 2), `detectHomeUnit`/`splitSegments`.
- Produces:
  - `ExistingItem = { id; make: string; model: string; deviceName: string | null; currentUserEmail: string | null; lastLogonUserPrincipalName: string | null; lastLogonDate: string | null; enrollmentDate: string | null; compliance: string | null }`
  - `NewItemImport = { make: string; model: string; serialNumber: string; deviceName?: string; homeUnit?: string; notes?: string; currentUserEmail?: string; lastLogonUserPrincipalName?: string; lastLogonDate?: string; enrollmentDate?: string; compliance?: string }`
  - `ItemUpdate = { row: number; itemId: string; serialNumber: string; data: Record<string, string | null>; loggedChanges: FieldChange[]; makeModelMismatch: boolean }`
  - `UnchangedRow = { row: number; serialNumber: string; makeModelMismatch: boolean }`
  - `planImport(rows, existingBySerial: Map<string, ExistingItem>, unitsByAbbrev): { toCreate: NewItemImport[]; toUpdate: ItemUpdate[]; unchanged: UnchangedRow[]; skipped: SkippedRow[]; unresolved: UnresolvedRow[]; detected: number }`
  - `SkippedRow` and `UnresolvedRow` unchanged.

- [ ] **Step 1: Replace the test file**

Replace the whole `src/modules/items/import.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { planImport, type ExistingItem } from "./import";
import type { RawRow } from "./csv";

const UNITS = new Map<string, string>([["DCSIM", "DCSIM"], ["487B", "487FA BATTERY B"]]);

const mk = (row: number, over: Partial<RawRow> = {}): RawRow => ({
  row, make: "M4", model: "Carbine", serialNumber: `S${row}`, deviceName: "Radio",
  homeUnit: "", notes: "", assignedUser: "", lastLogonUserPrincipalName: "",
  lastLogonDate: "", enrollmentDate: "", compliance: "", ...over,
});

const existing = (over: Partial<ExistingItem> = {}): ExistingItem => ({
  id: "id-1", make: "M4", model: "Carbine", deviceName: "Radio", currentUserEmail: null,
  lastLogonUserPrincipalName: null, lastLogonDate: null, enrollmentDate: null, compliance: null, ...over,
});

const map = (serial: string, item: ExistingItem) => new Map([[serial.toLowerCase(), item]]);

describe("planImport", () => {
  it("creates new, non-duplicate rows", () => {
    const { toCreate, toUpdate, skipped } = planImport([mk(1), mk(2)], new Map(), UNITS);
    expect(toCreate).toHaveLength(2);
    expect(toUpdate).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(toCreate[0]).toMatchObject({ make: "M4", model: "Carbine", serialNumber: "S1" });
  });

  it("updates deviceName on a serial match (logged) and leaves make/model", () => {
    const { toUpdate, unchanged } = planImport(
      [mk(1, { serialNumber: "A1", deviceName: "NewName" })],
      map("A1", existing({ id: "x", deviceName: "OldName" })),
      UNITS,
    );
    expect(unchanged).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0]).toMatchObject({ itemId: "x", serialNumber: "A1", makeModelMismatch: false });
    expect(toUpdate[0].data).toEqual({ deviceName: "NewName" });
    expect(toUpdate[0].loggedChanges).toEqual([{ field: "deviceName", from: "OldName", to: "NewName" }]);
  });

  it("updates assignedUser -> currentUserEmail (logged)", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", assignedUser: "jane@x.mil" })],
      map("A1", existing({ id: "x", currentUserEmail: null })),
      UNITS,
    );
    expect(toUpdate[0].data).toEqual({ currentUserEmail: "jane@x.mil" });
    expect(toUpdate[0].loggedChanges).toEqual([{ field: "currentUserEmail", from: null, to: "jane@x.mil" }]);
  });

  it("updates telemetry silently (no loggedChanges)", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", compliance: "Compliant", lastLogonDate: "2026-07-01" })],
      map("A1", existing({ id: "x" })),
      UNITS,
    );
    expect(toUpdate[0].data).toEqual({ compliance: "Compliant", lastLogonDate: "2026-07-01" });
    expect(toUpdate[0].loggedChanges).toEqual([]);
  });

  it("marks a fully-matching row unchanged", () => {
    const { toUpdate, unchanged } = planImport(
      [mk(1, { serialNumber: "A1", deviceName: "Radio" })],
      map("A1", existing({ id: "x", deviceName: "Radio" })),
      UNITS,
    );
    expect(toUpdate).toHaveLength(0);
    expect(unchanged).toEqual([{ row: 1, serialNumber: "A1", makeModelMismatch: false }]);
  });

  it("flags a make/model mismatch on a matched serial", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", make: "Dell", model: "5540", deviceName: "NewName" })],
      map("A1", existing({ id: "x", make: "M4", model: "Carbine", deviceName: "Old" })),
      UNITS,
    );
    expect(toUpdate[0].makeModelMismatch).toBe(true);
    expect(toUpdate[0].data).toEqual({ deviceName: "NewName" }); // make/model NOT written
  });

  it("blank assignedUser on a match leaves the stored value untouched", () => {
    const { toUpdate, unchanged } = planImport(
      [mk(1, { serialNumber: "A1", assignedUser: "" })],
      map("A1", existing({ id: "x", currentUserEmail: "keep@x.mil" })),
      UNITS,
    );
    expect(toUpdate).toHaveLength(0);
    expect(unchanged).toHaveLength(1);
  });

  it("skips a new row missing make or model", () => {
    const { toCreate, skipped } = planImport([mk(1, { serialNumber: "N1", make: "" })], new Map(), UNITS);
    expect(toCreate).toHaveLength(0);
    expect(skipped).toEqual([{ row: 1, serialNumber: "N1", reason: "make and model are required for new items" }]);
  });

  it("skips a row with a blank serial", () => {
    const { skipped } = planImport([mk(1, { serialNumber: "" })], new Map(), UNITS);
    expect(skipped[0].reason).toMatch(/serial number is required/i);
  });

  it("treats serials differing only in case as the same device within a file", () => {
    const { toCreate, skipped } = planImport(
      [mk(1, { serialNumber: "AbC123" }), mk(2, { serialNumber: "abc123" })],
      new Map(), UNITS,
    );
    expect(toCreate).toHaveLength(1);
    expect(skipped).toEqual([{ row: 2, serialNumber: "abc123", reason: "duplicate in file" }]);
  });

  it("auto-fills homeUnit from the device name on create when blank", () => {
    const { toCreate, detected } = planImport(
      [mk(1, { deviceName: "HI-DCSIM-LT-001", homeUnit: "" })], new Map(), UNITS,
    );
    expect(toCreate[0].homeUnit).toBe("DCSIM");
    expect(detected).toBe(1);
  });

  it("reports unresolved device names on create", () => {
    const { unresolved } = planImport(
      [mk(1, { deviceName: "HI-XYZ-LT-001", homeUnit: "" })], new Map(), UNITS,
    );
    expect(unresolved).toEqual([{ row: 1, deviceName: "HI-XYZ-LT-001", segments: ["HI", "XYZ", "LT", "001"] }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/items/import.test.ts`
Expected: FAIL — new exports/signature don't exist yet.

- [ ] **Step 3: Rewrite `import.ts`**

Replace the entire `src/modules/items/import.ts` with:

```ts
import { importRowSchema } from "./items.schema";
import type { RawRow } from "./csv";
import { detectHomeUnit, splitSegments } from "./unit-detect";
import { diffItemFields, type FieldChange, type ItemLoggedFields } from "./item-diff";

export type SkippedRow = { row: number; serialNumber: string; reason: string };
export type UnresolvedRow = { row: number; deviceName: string; segments: string[] };

// The columns of an existing item needed to match a CSV row and diff it. Fetched
// in one findMany by the caller and keyed by lowercased serial (citext identity).
export type ExistingItem = {
  id: string;
  make: string;
  model: string;
  deviceName: string | null;
  currentUserEmail: string | null;
  lastLogonUserPrincipalName: string | null;
  lastLogonDate: string | null;
  enrollmentDate: string | null;
  compliance: string | null;
};

// A row that will create a new item. make/model are required for creates (checked
// below); the rest are set only when the CSV provided a value.
export type NewItemImport = {
  make: string;
  model: string;
  serialNumber: string;
  deviceName?: string;
  homeUnit?: string;
  notes?: string;
  currentUserEmail?: string;
  lastLogonUserPrincipalName?: string;
  lastLogonDate?: string;
  enrollmentDate?: string;
  compliance?: string;
};

// A row that matched an existing serial and has at least one changed field.
// `data` is the exact column set to write; `loggedChanges` is the subset
// (deviceName/currentUserEmail) recorded to ItemEdit — telemetry updates silently.
export type ItemUpdate = {
  row: number;
  itemId: string;
  serialNumber: string;
  data: Record<string, string | null>;
  loggedChanges: FieldChange[];
  makeModelMismatch: boolean;
};

export type UnchangedRow = { row: number; serialNumber: string; makeModelMismatch: boolean };

export type PlanResult = {
  toCreate: NewItemImport[];
  toUpdate: ItemUpdate[];
  unchanged: UnchangedRow[];
  skipped: SkippedRow[];
  unresolved: UnresolvedRow[];
  detected: number;
};

// Pure planning: validate each row (serial required), dedup within the file
// (first occurrence wins), then either UPDATE a matching existing item's changed
// tracked fields, mark it unchanged, or CREATE a new item (make/model required).
// Only when homeUnit is blank on a create is it derived from the device name.
export function planImport(
  rows: RawRow[],
  // Keyed by LOWERCASED serial by the caller — matching is case-insensitive (citext).
  existingBySerial: Map<string, ExistingItem>,
  unitsByAbbrev: Map<string, string>,
): PlanResult {
  const toCreate: NewItemImport[] = [];
  const toUpdate: ItemUpdate[] = [];
  const unchanged: UnchangedRow[] = [];
  const skipped: SkippedRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  const seen = new Set<string>();
  let detected = 0;

  for (const r of rows) {
    const parsed = importRowSchema.safeParse({
      make: r.make,
      model: r.model,
      serialNumber: r.serialNumber,
      deviceName: r.deviceName,
      homeUnit: r.homeUnit,
      notes: r.notes,
      assignedUser: r.assignedUser,
      lastLogonUserPrincipalName: r.lastLogonUserPrincipalName,
      lastLogonDate: r.lastLogonDate,
      enrollmentDate: r.enrollmentDate,
      compliance: r.compliance,
    });
    if (!parsed.success) {
      skipped.push({ row: r.row, serialNumber: r.serialNumber, reason: parsed.error.issues[0]?.message ?? "invalid row" });
      continue;
    }
    const d = parsed.data;
    const sn = d.serialNumber;
    const snKey = sn.toLowerCase();

    if (seen.has(snKey)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "duplicate in file" });
      continue;
    }
    seen.add(snKey);

    const match = existingBySerial.get(snKey);
    if (match) {
      // UPDATE / UNCHANGED path. make/model are never overwritten — only flagged.
      const makeModelMismatch = diffItemFields(match, {
        ...(d.make !== undefined ? { make: d.make } : {}),
        ...(d.model !== undefined ? { model: d.model } : {}),
      }).length > 0;

      // Logged fields (deviceName, currentUserEmail) -> ItemEdit history.
      const loggedAfter: Partial<ItemLoggedFields> = {};
      if (d.deviceName !== undefined) loggedAfter.deviceName = d.deviceName;
      if (d.assignedUser !== undefined) loggedAfter.currentUserEmail = d.assignedUser;
      const loggedChanges = diffItemFields(match, loggedAfter);

      // Silent telemetry fields -> updated but not logged.
      const silentAfter: Partial<ItemLoggedFields> = {};
      if (d.lastLogonUserPrincipalName !== undefined) silentAfter.lastLogonUserPrincipalName = d.lastLogonUserPrincipalName;
      if (d.lastLogonDate !== undefined) silentAfter.lastLogonDate = d.lastLogonDate;
      if (d.enrollmentDate !== undefined) silentAfter.enrollmentDate = d.enrollmentDate;
      if (d.compliance !== undefined) silentAfter.compliance = d.compliance;
      const silentChanges = diffItemFields(match, silentAfter);

      const allChanges = [...loggedChanges, ...silentChanges];
      if (allChanges.length === 0) {
        unchanged.push({ row: r.row, serialNumber: sn, makeModelMismatch });
        continue;
      }
      const data: Record<string, string | null> = {};
      for (const c of allChanges) data[c.field] = c.to;
      toUpdate.push({ row: r.row, itemId: match.id, serialNumber: sn, data, loggedChanges, makeModelMismatch });
      continue;
    }

    // CREATE path — make and model are required for a new item.
    if (!d.make || !d.model) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "make and model are required for new items" });
      continue;
    }
    const item: NewItemImport = {
      make: d.make,
      model: d.model,
      serialNumber: sn,
      deviceName: d.deviceName,
      homeUnit: d.homeUnit,
      notes: d.notes,
      currentUserEmail: d.assignedUser,
      lastLogonUserPrincipalName: d.lastLogonUserPrincipalName,
      lastLogonDate: d.lastLogonDate,
      enrollmentDate: d.enrollmentDate,
      compliance: d.compliance,
    };
    if (!item.homeUnit && item.deviceName) {
      const full = detectHomeUnit(item.deviceName, unitsByAbbrev);
      if (full) {
        item.homeUnit = full;
        detected++;
      } else {
        unresolved.push({ row: r.row, deviceName: item.deviceName, segments: splitSegments(item.deviceName) });
      }
    }
    toCreate.push(item);
  }

  return { toCreate, toUpdate, unchanged, skipped, unresolved, detected };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/items/import.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/import.ts src/modules/items/import.test.ts
git commit -m "feat: planImport update/unchanged buckets with logged+silent diffs"
```

---

### Task 6: Wire `analyzeImport` / `commitImport` to the new plan

**Files:**
- Modify: `src/modules/items/items.service.ts` (lines 1-8 imports; `analyzeImport` 163-185; `commitImport` 187-236)
- Test: `src/modules/items/items.service.import.test.ts`

**Interfaces:**
- Consumes: `planImport`, `ExistingItem` (Task 5).
- Produces:
  - `analyzeImport(text) -> { counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number; autoDetected: number }; skipped: SkippedRow[]; unresolved: UnresolvedRow[]; mismatches: { serialNumber: string }[]; error?: string }`
  - `commitImport(text, filename, resolutions, editor: { id: string; name: string }) -> { added: number; updated: number; skipped: SkippedRow[]; unchanged: number; detected: number; mismatches: { serialNumber: string }[]; error?: string }`

- [ ] **Step 1: Rewrite the integration tests**

Replace `src/modules/items/items.service.import.test.ts` fully with:

```ts
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, analyzeImport, commitImport } from "./items.service";

let admin: { id: string; name: string };
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const a = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  admin = { id: a.id, name: a.name };
});

test("commitImport creates new rows, updates matches, and reports unchanged", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "EXIST1", deviceName: "Radio", homeUnit: undefined, notes: undefined }, admin.id);

  const csv = [
    "make,model,serialNumber,deviceName,assignedUser,compliance",
    "M4,Carbine,NEW1,Radio,,",              // create
    "Dell,5540,EXIST1,Radio,,",             // unchanged (all equal)
    "PVS,14,DUP1,Radio,,",                  // create (first)
    "PVS,14,DUP1,Radio,,",                  // duplicate in file
    ",Carbine,BAD1,Radio,,",                // new row missing make -> skipped
  ].join("\n");

  const res = await commitImport(csv, "items.csv", [], admin);

  expect(res.error).toBeUndefined();
  expect(res.added).toBe(2);            // NEW1, DUP1
  expect(res.updated).toBe(0);
  expect(res.unchanged).toBe(1);        // EXIST1
  expect(res.skipped.map((s) => s.reason).sort()).toEqual(
    ["duplicate in file", "make and model are required for new items"].sort(),
  );
  expect(await prisma.item.count()).toBe(3);

  const batch = await prisma.importBatch.findFirst();
  expect(batch).toMatchObject({ addedCount: 2, updatedCount: 0, createdById: admin.id });
});

test("commitImport updates deviceName + assignedUser (logged) and telemetry (silent)", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "UP1", deviceName: "Old", homeUnit: undefined, notes: undefined }, admin.id);

  const csv = [
    "serialNumber,deviceName,assignedUser,lastLogonDate,compliance",
    "UP1,NewName,jane@x.mil,2026-07-01,Compliant",
  ].join("\n");

  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.added).toBe(0);
  expect(res.updated).toBe(1);

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "UP1" } });
  expect(item.deviceName).toBe("NewName");
  expect(item.currentUserEmail).toBe("jane@x.mil");
  expect(item.lastLogonDate).toBe("2026-07-01");
  expect(item.compliance).toBe("Compliant");

  // Exactly one ItemEdit, covering only the two logged fields (not telemetry).
  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  const fields = (edits[0].changes as { field: string }[]).map((c) => c.field).sort();
  expect(fields).toEqual(["currentUserEmail", "deviceName"]);
});

test("commitImport telemetry-only change writes no ItemEdit", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "UP2", deviceName: "Same", homeUnit: undefined, notes: undefined }, admin.id);
  const csv = "serialNumber,deviceName,compliance\nUP2,Same,Noncompliant\n";
  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.updated).toBe(1);
  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "UP2" } });
  expect(item.compliance).toBe("Noncompliant");
  expect(await prisma.itemEdit.count({ where: { itemId: item.id } })).toBe(0);
});

test("analyzeImport reports mismatches and update counts without writing", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "M1", deviceName: "Old", homeUnit: undefined, notes: undefined }, admin.id);
  const csv = "make,model,serialNumber,deviceName\nHP,x360,M1,New\n"; // make/model differ, deviceName differs
  const res = await analyzeImport(csv);
  expect(res.error).toBeUndefined();
  expect(res.counts).toMatchObject({ toImport: 0, toUpdate: 1, unchanged: 0 });
  expect(res.mismatches).toEqual([{ serialNumber: "M1" }]);
  expect(await prisma.itemEdit.count()).toBe(0); // analyze writes nothing
});

test("commitImport returns a format error and imports nothing when serial column missing", async () => {
  const res = await commitImport("make,model\nM4,Carbine\n", "bad.csv", [], admin);
  expect(res.added).toBe(0);
  expect(res.error).toMatch(/serialNumber/);
  expect(await prisma.item.count()).toBe(0);
  expect(await prisma.importBatch.count()).toBe(0);
});

test("commitImport learns a resolution and applies it to every matching new row", async () => {
  const csv = [
    "make,model,serialNumber,deviceName,homeUnit,notes",
    "M4,Carbine,A1,HI-XYZ-LT-001,,",
    "M4,Carbine,A2,HI-XYZ-DT-002,,",
  ].join("\n");
  const res = await commitImport(csv, "items.csv", [{ abbreviation: "XYZ", fullName: "456th Signal Co" }], admin);
  expect(res.added).toBe(2);
  expect(res.detected).toBe(2);
  const homeUnits = (await prisma.item.findMany({ select: { homeUnit: true } })).map((i) => i.homeUnit);
  expect(homeUnits).toEqual(["456th Signal Co", "456th Signal Co"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/items/items.service.import.test.ts`
Expected: FAIL — `commitImport` signature/return shape and `analyzeImport` counts don't match yet.

- [ ] **Step 3: Update the imports block**

In `src/modules/items/items.service.ts`, replace the import of `planImport` (line 5) so the new types come along:

```ts
import { planImport, type SkippedRow, type UnresolvedRow, type ExistingItem } from "./import";
```

- [ ] **Step 4: Add a shared existing-items loader**

In `src/modules/items/items.service.ts`, add this helper just above `analyzeImport` (before line 163):

```ts
// One query pulls every column planImport needs to match + diff a row. Keyed by
// lowercased serial to mirror the DB's citext identity. Bounded — same single
// findMany as the old serial-only fetch, just more columns.
async function loadExistingBySerial(): Promise<Map<string, ExistingItem>> {
  const rows = await prisma.item.findMany({
    select: {
      id: true, serialNumber: true, make: true, model: true, deviceName: true,
      currentUserEmail: true, lastLogonUserPrincipalName: true, lastLogonDate: true,
      enrollmentDate: true, compliance: true,
    },
  });
  const map = new Map<string, ExistingItem>();
  for (const r of rows) {
    const { serialNumber, ...rest } = r;
    map.set(serialNumber.toLowerCase(), rest);
  }
  return map;
}

// Make/model mismatch summary from a plan, for the UI warning list.
function collectMismatches(plan: { toUpdate: { serialNumber: string; makeModelMismatch: boolean }[]; unchanged: { serialNumber: string; makeModelMismatch: boolean }[] }): { serialNumber: string }[] {
  return [...plan.toUpdate, ...plan.unchanged]
    .filter((r) => r.makeModelMismatch)
    .map((r) => ({ serialNumber: r.serialNumber }));
}
```

- [ ] **Step 5: Rewrite `analyzeImport`**

Replace `analyzeImport` (lines 163-185) with:

```ts
export async function analyzeImport(text: string): Promise<{
  counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number; autoDetected: number };
  skipped: SkippedRow[];
  unresolved: UnresolvedRow[];
  mismatches: { serialNumber: string }[];
  error?: string;
}> {
  const empty = { toImport: 0, toUpdate: 0, unchanged: 0, skipped: 0, autoDetected: 0 };
  const { rows, error } = parseItemsCsv(text);
  if (error) return { counts: empty, skipped: [], unresolved: [], mismatches: [], error };

  const existing = await loadExistingBySerial();
  const units = await loadUnitMap();
  const plan = planImport(rows, existing, units);

  return {
    counts: {
      toImport: plan.toCreate.length,
      toUpdate: plan.toUpdate.length,
      unchanged: plan.unchanged.length,
      skipped: plan.skipped.length,
      autoDetected: plan.detected,
    },
    skipped: plan.skipped,
    unresolved: plan.unresolved,
    mismatches: collectMismatches(plan),
  };
}
```

- [ ] **Step 6: Rewrite `commitImport`**

Replace `commitImport` (lines 187-236) with:

```ts
export async function commitImport(
  text: string,
  filename: string,
  resolutions: UnitResolution[],
  editor: { id: string; name: string }
): Promise<{ added: number; updated: number; skipped: SkippedRow[]; unchanged: number; detected: number; mismatches: { serialNumber: string }[]; error?: string }> {
  const { rows, error } = parseItemsCsv(text);
  if (error) return { added: 0, updated: 0, skipped: [], unchanged: 0, detected: 0, mismatches: [], error };

  // Persist learned units BEFORE planning so detection re-runs with the enriched map.
  await learnUnits(resolutions);

  const existing = await loadExistingBySerial();
  const units = await loadUnitMap();
  const plan = planImport(rows, existing, units);
  const { toCreate, toUpdate, unchanged, skipped, detected } = plan;

  const added = await prisma.$transaction(async (tx) => {
    const created = await tx.item.createMany({
      // The DB unique(serialNumber, citext) is the race-safe backstop: skip rather
      // than throw on a serial a concurrent import inserted after loadExistingBySerial.
      data: toCreate.map((d) => ({ ...d, createdById: editor.id })),
      skipDuplicates: true,
    });

    // Per-match writes carry distinct values, so individual updates are required
    // (no batch-update-with-different-values in Prisma). Before-values already came
    // from planImport — no per-row SELECT here. Bounded by the 2000-row import cap.
    for (const u of toUpdate) {
      await tx.item.update({ where: { id: u.itemId }, data: u.data });
      if (u.loggedChanges.length > 0) {
        await tx.itemEdit.create({
          data: {
            itemId: u.itemId,
            editedById: editor.id,
            editedByName: editor.name,
            changes: u.loggedChanges as unknown as Prisma.InputJsonValue,
          },
        });
      }
    }

    await tx.importBatch.create({
      data: {
        createdById: editor.id,
        filename,
        addedCount: created.count,
        updatedCount: toUpdate.length,
        skippedCount: skipped.length,
        skipped: skipped as unknown as Prisma.InputJsonValue,
      },
    });
    return created.count;
  });

  if (added < toCreate.length) {
    console.warn(`[commitImport] ${toCreate.length - added} row(s) skipped by the DB serialNumber unique constraint (concurrent import or casing variant).`);
  }

  return { added, updated: toUpdate.length, skipped, unchanged: unchanged.length, detected, mismatches: collectMismatches(plan) };
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/modules/items/items.service.import.test.ts`
Expected: PASS (all). (Reviewers: do not run the full suite in parallel with another agent — the test DB is shared.)

- [ ] **Step 8: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.import.test.ts
git commit -m "feat: commitImport updates matched items; analyzeImport reports update/unchanged/mismatch"
```

---

### Task 7: Update the admin action (editor + counts)

**Files:**
- Modify: `src/app/admin/actions/items.ts` (`analyzeImportAction` 60-75; `commitImportAction` 77-103)

**Interfaces:**
- Consumes: `analyzeImport`/`commitImport` new shapes (Task 6).
- Produces: `analyzeImportAction` returns `{ counts, skipped, unresolved, mismatches } | { error }`; `commitImportAction` returns `{ added, updated, skipped, unchanged, detected, mismatches } | { error }`.

- [ ] **Step 1: Update `analyzeImportAction`**

Replace `analyzeImportAction` (lines 60-75) with:

```ts
export async function analyzeImportAction(
  formData: FormData
): Promise<{ counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number; autoDetected: number }; skipped: SkippedRow[]; unresolved: UnresolvedRow[]; mismatches: { serialNumber: string }[] } | { error: string }> {
  await requireAdmin();
  const f = readCsvFile(formData);
  if ("error" in f) return f;
  try {
    const text = await f.file.text();
    const res = await analyzeImport(text);
    if (res.error) return { error: res.error };
    return { counts: res.counts, skipped: res.skipped, unresolved: res.unresolved, mismatches: res.mismatches };
  } catch (e) {
    console.error("[analyzeImportAction] unexpected error:", e);
    return { error: "Something went wrong reading the file. Please try again." };
  }
}
```

- [ ] **Step 2: Update `commitImportAction`**

Replace `commitImportAction` (lines 77-103) with:

```ts
export async function commitImportAction(
  formData: FormData
): Promise<{ added: number; updated: number; skipped: SkippedRow[]; unchanged: number; detected: number; mismatches: { serialNumber: string }[] } | { error: string }> {
  const admin = await requireAdmin();
  const f = readCsvFile(formData);
  if ("error" in f) return f;

  let resolutions: UnitResolution[];
  try {
    const raw = JSON.parse(String(formData.get("resolutions") ?? "[]"));
    resolutions = z.array(resolutionSchema).parse(raw);
  } catch {
    return { error: "The unit assignments were invalid. Please re-check them and try again." };
  }

  try {
    const text = await f.file.text();
    const res = await commitImport(text, f.file.name, resolutions, { id: admin.id, name: admin.name });
    if (res.error) return { error: res.error };
    revalidatePath("/items");
    revalidatePath("/admin/audit");
    return { added: res.added, updated: res.updated, skipped: res.skipped, unchanged: res.unchanged, detected: res.detected, mismatches: res.mismatches };
  } catch (e) {
    console.error("[commitImportAction] unexpected error:", e);
    return { error: "Something went wrong importing the file. Please try again." };
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `src/app/admin/actions/items.ts` (or the items modules). Fix any type mismatches surfaced.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/actions/items.ts
git commit -m "feat: thread editor identity and update/mismatch counts through import actions"
```

---

### Task 8: Import UI — template, help text, and reporting

**Files:**
- Modify: `src/app/admin/items/import/ImportItemsForm.tsx`

**Interfaces:**
- Consumes: `analyzeImportAction`/`commitImportAction` new shapes (Task 7).

- [ ] **Step 1: Update template, types, and constants**

In `ImportItemsForm.tsx`, replace the `TEMPLATE` (line 6):

```tsx
const TEMPLATE = "make,model,serialNumber,deviceName,homeUnit,notes,assignedUser,lastLogonUserPrincipalName,lastLogonDate,enrollmentDate,compliance\n";
```

Replace the `Analysis` type and add a result type (lines 13-17):

```tsx
type Mismatch = { serialNumber: string };
type Analysis = {
  counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number; autoDetected: number };
  skipped: Skipped[];
  unresolved: Unresolved[];
  mismatches: Mismatch[];
};
type CommitResult = { added: number; updated: number; skipped: Skipped[]; unchanged: number; detected: number; mismatches: Mismatch[] };
```

Update the result state type (line 33):

```tsx
  const [result, setResult] = useState<CommitResult | null>(null);
```

- [ ] **Step 2: Update the done screen**

Replace the success block inside `if (phase === "done" && result)` — the `<p className="alert-success">` line (line 88) and add update/unchanged/mismatch lines right after it:

```tsx
          <p className="alert-success">{result.added} item{result.added === 1 ? "" : "s"} added · {result.updated} updated.</p>
          {result.unchanged > 0 && <p className="subtle">{result.unchanged} already up to date.</p>}
          {result.mismatches.length > 0 && (
            <p className="alert-warning">Make/model differ from stored on: {result.mismatches.map((m) => m.serialNumber).join(", ")} (device name / assigned user still updated; make and model were left unchanged).</p>
          )}
```

- [ ] **Step 3: Update the analyze preview**

Replace the summary paragraph inside `if ((phase === "resolve" || phase === "busy") && analysis)` (line 116) with:

```tsx
          <p><strong>{analysis.counts.toImport}</strong> to add · <strong>{analysis.counts.toUpdate}</strong> to update · <strong>{analysis.counts.unchanged}</strong> unchanged · <strong>{analysis.counts.autoDetected}</strong> units auto-detected · <strong>{analysis.counts.skipped}</strong> skipped.</p>
          {analysis.mismatches.length > 0 && (
            <p className="alert-warning">Make/model differ on: {analysis.mismatches.map((m) => m.serialNumber).join(", ")} — these will still update device name / assigned user, but make and model won&apos;t be changed.</p>
          )}
```

Also update the primary commit button label (line 137) to reflect updates:

```tsx
            {phase === "busy" ? "Importing…" : `Import ${analysis.counts.toImport + analysis.counts.toUpdate} items`}
```

- [ ] **Step 4: Update the upload-step help text**

Replace the `<p className="subtle">` under the file input (line 169) with:

```tsx
          <p className="subtle">Only <strong>serialNumber</strong> is required. Columns (any order, case-insensitive): make, model, serialNumber, deviceName, homeUnit, notes, assignedUser, lastLogonUserPrincipalName, lastLogonDate, enrollmentDate, compliance. A row whose serial already exists updates its device name, assigned user and telemetry; make/model are required only for new items. Blank cells are left unchanged on existing items.</p>
```

- [ ] **Step 5: Verify it builds**

Run: `npx tsc --noEmit`
Expected: no errors in `ImportItemsForm.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/items/import/ImportItemsForm.tsx
git commit -m "feat: import UI shows add/update/unchanged/mismatch and new columns"
```

---

### Task 9: Show telemetry on the item detail page (logged-in only)

**Files:**
- Modify: `src/app/i/[itemId]/ItemDetailsCard.tsx`
- Modify: `src/app/i/[itemId]/page.tsx` (props passed to `ItemDetailsCard`, lines 81-106)

**Interfaces:**
- Consumes: `Item` telemetry columns (Task 1). The page already gates the whole `ItemDetailsCard` behind `loggedIn` (page.tsx:80), so passing the telemetry through it keeps it out of the public/PIN view.

- [ ] **Step 1: Extend the card's value type and render**

In `ItemDetailsCard.tsx`, add the four fields to `ItemDetailsValues` (after `notes: string | null;`, line 11):

```tsx
  lastLogonUserPrincipalName: string | null;
  lastLogonDate: string | null;
  enrollmentDate: string | null;
  compliance: string | null;
```

In the read-only `<dl>` (the `else` branch), add rows after the `Current position` `<dd>` (after line 119):

```tsx
          <dt>Assigned user (last logon)</dt>
          <dd>{item.lastLogonUserPrincipalName || dash}</dd>
          <dt>Last logon date</dt>
          <dd>{item.lastLogonDate || dash}</dd>
          <dt>Enrollment date</dt>
          <dd>{item.enrollmentDate || dash}</dd>
          <dt>Compliance</dt>
          <dd>{item.compliance || dash}</dd>
```

(These are read-only telemetry — do NOT add inputs for them in the `editing` form.)

- [ ] **Step 2: Pass the telemetry from the page**

In `page.tsx`, inside the `item={{ ... }}` prop (lines 82-95), add after the `notes:` line:

```tsx
              lastLogonUserPrincipalName: item.lastLogonUserPrincipalName,
              lastLogonDate: item.lastLogonDate,
              enrollmentDate: item.enrollmentDate,
              compliance: item.compliance,
```

- [ ] **Step 3: Verify it builds**

Run: `npx tsc --noEmit`
Expected: no errors. (`getItemWithCreator` returns the full `Item`, so the new columns are present on `item`.)

- [ ] **Step 4: Verify in a browser (real runtime, not jsdom)**

Invoke the `verify` skill (or `npm run dev`). Log in as admin, import a CSV that sets telemetry on an item, open `/i/<id>`, and confirm the four fields render under Item details. Log out (or open in a private window past the PIN gate) and confirm the Item details card — and therefore the telemetry — is absent.
Expected: telemetry visible only when logged in.

- [ ] **Step 5: Commit**

```bash
git add src/app/i/[itemId]/ItemDetailsCard.tsx src/app/i/[itemId]/page.tsx
git commit -m "feat: show imported MDM telemetry on item detail (logged-in only)"
```

---

### Task 10: Documentation (same-change requirement)

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md` (Data Fetching / import notes, only where text is now inaccurate)

**Interfaces:** none (docs).

- [ ] **Step 1: Add the changelog entry**

At the top of `CHANGELOG.md` (newest first), add under a `## 2026-07-23` section (create it if absent):

```markdown
## 2026-07-23

### Added
- CSV item import now updates an existing item instead of skipping it: when a row's `serialNumber` matches, changed `deviceName` / assigned user / MDM telemetry are written, and the item is no longer marked a duplicate.
- New importable fields: `assignedUser` (→ the item's current-user email) and MDM telemetry `lastLogonUserPrincipalName`, `lastLogonDate`, `enrollmentDate`, `compliance`, shown read-only on the item detail page for logged-in users.

### Changed
- Import required-field rules: only `serialNumber` is a required column. New items still require `make`, `model`, `serialNumber`; existing (matched) items require only `serialNumber`. Blank cells leave stored values untouched on an update. `make`/`model` are never overwritten on a match — a difference is reported as a warning. `deviceName` / assigned-user changes are logged to item history; telemetry updates silently.

### Notes
- Migration `20260723000000_add_mdm_telemetry_fields` adds four nullable text columns to `Item` (`lastLogonUserPrincipalName`, `lastLogonDate`, `enrollmentDate`, `compliance`) and `updatedCount` (default 0) to `ImportBatch`. Apply with `npx prisma migrate deploy`; prod is hand-applied via the standard manual process.
```

- [ ] **Step 2: Reconcile CLAUDE.md if any statement is now stale**

Check the CSV-import references in `CLAUDE.md` (the `Item.serialNumber` citext bullet mentions the CSV import dedups and "leans on the DB constraint (`createMany({ skipDuplicates: true })`)"). That statement is still true for *new* rows. Only edit if a sentence now reads as false; append a clause noting matched serials update rather than skip. Keep the edit minimal and truthful.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: changelog + notes for CSV import update-on-match and telemetry fields"
```

---

### Task 11: Full regression pass

**Files:** none (verification).

- [ ] **Step 1: Run the item-related suites**

Run: `npx vitest run src/modules/items` (and, when the shared test DB is free, `npx vitest run integration`)
Expected: PASS. Investigate any failure before proceeding — do not mark complete on red.

- [ ] **Step 2: Full typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

---

## Self-Review

**Spec coverage:**
- Match-on-serial + update buckets → Tasks 5, 6. ✅
- assignedUser + 4 telemetry fields (parse, store, refresh) → Tasks 1, 2, 3, 5, 6. ✅
- Case/space/order-insensitive headers → already in parser; new headers added in Task 2 (test asserts order/case). ✅
- Required-field relaxation (serial-only column; make/model for new only) → Tasks 2, 3, 5. ✅
- Blank = untouched; make/model never overwritten; mismatch warning → Task 5 (tests). ✅
- deviceName/assignedUser logged, telemetry silent → Tasks 5, 6 (tests). ✅
- Telemetry display, logged-in only → Task 9. ✅
- Migration (4 Item cols + ImportBatch.updatedCount, make/model stay NOT NULL) → Task 1. ✅
- Docs (CHANGELOG, CLAUDE.md, help text) → Tasks 8, 10. ✅

**Placeholder scan:** none — every code step carries full code.

**Type consistency:** `ExistingItem`, `NewItemImport`, `ItemUpdate`, `UnchangedRow` defined in Task 5 and consumed by the same names/shapes in Task 6; `editor: { id, name }` consistent across Tasks 6-7; `mismatches: { serialNumber: string }[]` consistent across Tasks 6-8; `counts` object identical in Tasks 6, 7, 8.
