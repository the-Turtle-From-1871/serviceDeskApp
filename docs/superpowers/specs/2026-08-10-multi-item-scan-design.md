# Multi-item scan on `/items` — design

**Date:** 2026-08-10
**Status:** approved, not yet implemented
**Surface:** `/items` Scan button only. The hand-receipt builder's scan is unchanged.

## Problem

`/items`' Scan button resolves the first code it can and navigates away. That makes it a
lookup tool for exactly one device. Two things follow from it that the desk actually needs
and cannot do:

1. **Collecting a batch.** Selecting thirty devices for a hand receipt, a QR sheet or a
   readiness sweep means tapping thirty rows. The kit is physically in hand with labels
   facing up — scanning is the natural input, and every scan currently throws the previous
   one away by navigating.
2. **A device that is not in the book.** A scan that resolves to nothing lands the operator
   on `/items?q=<serial>`, whose empty state offers an admin "+ Create <serial> as a new
   item". That works, but it ends the scan session, and the serial is the only thing
   carried across — everything else is re-typed.

## What changes, from the operator's side

- Every scan **adds to a list at the bottom of the camera sheet** instead of navigating.
  The sheet stays open; scanning is continuous.
- **Done commits the list to the `/items` selection.** The existing selection bar then
  offers Create receipt, Print QR codes, Mark as on hand and Set category — unchanged.
- A scanned serial **not in the book** joins the list flagged *Not in the book*. On Done,
  anyone holding `MANAGE_ITEMS` gets one form to create them all, with make and model
  **prefilled from the label** where the QR carries them.
- A **retired** device is listed and clearly flagged, but does not join the selection.

Scanning one device to look at it now costs Done + a tap, rather than being automatic.
That was a deliberate trade: one flow, no mode.

## Non-goals

- No change to the receipt builder's scan flow, which already accumulates a list.
- No offline queue or persistence. A closed sheet loses an uncommitted session.
- No camera/decoder changes beyond a `children` slot on `QrScanner`.
- No new public surface, and no new capability.

## Architecture

### 1. `ItemSelection` — a provider, because the two controls are siblings

`ItemsListPage` is a Server Component rendering `<ItemsScanButton />` and
`<ItemSelectTable />` as sibling Client Components. The selection Map lives inside
`ItemSelectTable`, so the scan sheet has no way to reach it.

`src/components/ItemSelection.tsx` (new, client) owns the Map and exposes
`{ selected, add, addMany, toggle, clear }` through context. `page.tsx` wraps the search
row and the table in it. Neither control moves on screen — the Scan button stays beside the
search box, which is deliberate and commented there.

`ItemSelectTable` drops its own `useState` and reads the context. `toggle(row)` keeps
taking an `ItemRow`, so its call sites are untouched.

**Rejected:** moving the Scan button inside `ItemSelectTable` (disturbs the documented
toolbar layout and the `.toolbar:has(.btn-primary)` sizing rule, and drags camera concerns
into the table); handing ids over via URL or `sessionStorage` (the Map holds item data, not
just ids, so the table would have to re-fetch what the scan already knew — two sources of
truth).

### 2. `SelectedItem` — narrow the Map to what the selection consumes

```ts
type SelectedItem = { id: string; make: string; model: string; serialNumber: string; status: "ACTIVE" | "RETIRED" };
```

The Map is `Map<string, ItemRow>` today, and `ItemRow` carries fifteen fields —
`readiness`, `auditState`, `holderName`, `deviceUIC`, MDM telemetry — derived by two extra
page-level queries **to render a table row**. A scanned item is not rendered as a table row
and is usually not on the current page, so producing a full `ItemRow` per scan would mean
running the readiness and holder queries to populate fields nobody displays.

`ItemRow` is a superset of `SelectedItem`, so existing calls still typecheck, and the group
validation (`MAX_RECEIPT_ROWS` / `MAX_ITEMS_PER_ROW`) reads only `make`/`model`.

### 3. `ItemsScanButton` becomes a session

State: `scanned: ScannedEntry[]`, ordered, newest last.

| kind | when | joins selection on Done |
| --- | --- | --- |
| `found` | resolved, `ACTIVE` | yes |
| `retired` | resolved, `RETIRED` | no — listed, flagged |
| `new` | resolved to nothing | no — feeds §5 |

Done **adds to** whatever is already selected rather than replacing it, so a scanned batch
can extend a selection made by tapping, and two scan sessions accumulate. Nothing in the
scan flow clears the selection — that stays the selection bar's own job.

If `canCreate` is false, Done commits the `found` entries and closes; the `new` ones are
reported in the list and then discarded with the session.

Carried over from `ReceiptBuilderForm`, which already solved continuous scanning: an
in-flight guard so one lookup runs at a time; a 1.5s dedupe window keyed on the resolved
identity, checked **after** the in-flight guard and recorded only when the lookup actually
proceeds; and an "already scanned" notice when a code repeats. The `done` latch is deleted
— nothing navigates any more, so there is no route transition to race.

### 4. Server actions

`resolveScannedSerial` returns `{ item: SelectedItem }` rather than `{ itemId }` — the same
query with a wider `select`, no extra round trip. A sibling `resolveScannedItemId` does the
same for our own QR sticker.

Both keep the existing, deliberate choice **not** to filter on `ACTIVE`: `/items` is a
lookup surface, and a retired device on a shelf is exactly what someone scans to ask why it
is there. That choice is what makes the `retired` row above representable.

The receipt builder's `lookupScannedItem` / `lookupScannedSerial` are untouched — different
surface, and their ACTIVE gate exists because the builder is about to put the item on a
signed document.

### 5. Creating the unknowns

Gated on **`MANAGE_ITEMS`**, passed as `canCreate` from `page.tsx`
(`user.capabilities.includes("MANAGE_ITEMS")`), not on `role === "ADMIN"`. A `USER` granted
`MANAGE_ITEMS` individually gets this; a `VIEWER` does not. Without it the unknown rows
still show, flagged — only the create button is absent.

Done with `new` entries present swaps the sheet for a form, one row per unknown serial, the
serial fixed and uneditable because it came off the label. "Create 3 · Skip the rest" is
always available.

**Schema — derived, never restated:**

```ts
// items.schema.ts, directly beneath newItemSchema
export const scannedItemSchema = newItemSchema.extend({ deviceName: optional });
```

`newItemSchema` requires `deviceName`; a device scanned off a shelf may not have a known
hostname, and requiring one would block the create at the moment it is most useful.
`.extend()` overrides exactly that field and inherits everything else, so a field added to
`newItemSchema` later flows through automatically and the two cannot disagree about
anything but `deviceName`. This mirrors `registerSchema` (`newUserSchema` minus `role`) and
the three `category*` variants. **Restating the field list here would be the drift
`CLAUDE.md` warns about; a test pins that `deviceName` is the only difference.**

**Known consequence:** `detectHomeUnit` reads the device name, so items created this way get
**no home unit** until someone edits them or an import fills it in. The form says so.

**The write** — `createScannedItemsAction(rows)`:

1. `requireCapability("MANAGE_ITEMS")`
2. validate each row with `scannedItemSchema`
3. `createMany({ skipDuplicates: true })`
4. one `findMany` over the serials to recover ids

Two queries for N rows, never one create per row. `skipDuplicates` makes it race-safe
against the same serial being created elsewhere between the scan and the create — leaning
on the citext-unique constraint as the backstop, exactly as the CSV importer does. The
result reports honestly (*"4 created · 1 already existed"*), and an already-existing row
still joins the selection, because it was physically scanned.

### 6. Label hints — make and model from the QR

HP's QR is a comma-separated list whose first field is the serial and whose second
describes the device: `2TK94709FN, HP ProBook 650 G5, ProdID 5PF3…`. The stored row for
that serial is `make: "HP"`, `model: "HP ProBook 650 G5"` — so the hint is **make = the
field's first token, model = the whole field**, which is how that data is actually shaped.

Carried on `ScanIntent` as an optional `label?: { make: string; model: string }`, populated
only by the positional (comma-list) branch — the keyed `SN:` form carries no description.
It is a **prefill only** and never participates in lookup; every field stays editable.

### 7. The list UI

`QrScanner` gains a `children` slot rendered between the video and the Done button. It
stays ignorant of items and schema — the caller passes the rendered list, exactly as it
already does for `notice`. Done shows the count: `Done · 7 items`.

The sheet is `z-index: 50`, already above the bottom nav rail (40). The list region needs
`svh` and `env(safe-area-inset-bottom)` like the rail, and a `max-height` with its own
scroll container so a long session never grows off the top of the screen.

## Error handling

| Case | Behaviour |
| --- | --- |
| Nothing in the frame parses | Existing notice, quoting what was decoded |
| Lookup fails (`FAILED`) | Notice, entry not added, session continues |
| Session expired (`UNAUTHORIZED`) | Notice naming it; session continues so the list is not lost |
| Same code re-scanned | "Already scanned" notice, no duplicate row |
| Create partially fails | Per-row errors on the form; successful rows are created and joined |
| Serial created elsewhere meanwhile | `skipDuplicates`, reported as "already existed", still joined |

Every refusal keeps the camera open. A batch collected over several minutes must not be
discarded by one bad frame.

## Testing

**Pure — no DB, always reliable**
- `scan-code.test.ts`: label hint parsed off the comma list; absent for keyed and bare
  serials; never used for lookup.
- `items.schema.test.ts`: `scannedItemSchema` differs from `newItemSchema` in `deviceName`
  alone.

**jsdom component**
- `ItemsScanButton.test.tsx`: accumulates across scans; a repeat does not double-add; a
  retired entry is listed but excluded from what Done commits; an unknown is flagged and
  reaches the create form; `canCreate={false}` shows the flag but no create button.
- `ItemSelectTable.test.tsx`: wrapped in the provider; existing invariants (the `<dialog>`
  and popover no-layout-class pins) unchanged.

**DB**
- `createScannedItems`: two queries for N rows; `skipDuplicates` covers a serial that
  appeared meanwhile; a caller without `MANAGE_ITEMS` is refused.

**Not testable here** — the sheet's layout at 390px, the scroll container, and safe-area
behaviour. Neither jsdom nor `next build` has a layout engine; verify in a real browser at
390px, per `.claude/rules/ui-styling.md`.

## Documentation, in the same commit

- `CHANGELOG.md` under 2026-08-10.
- `scannedItemSchema` and its derive-never-restate rule in
  `.claude/rules/backend-constraints.md`, with the one-line summary in `CLAUDE.md`.
- No `docs/SECURITY.md` change: no new public surface, no new capability, and the new
  action gates on an existing one.

## Risks

- **Selection counts cover rows you cannot see.** Scanned items are usually not on the
  current page. This already happens when selecting across pages; scanning makes it the
  common case rather than the rare one. The bar shows a count and actions, not rows.
- **`ItemSelectTable` state ownership moves.** Contained, but it is the most-tested
  component here; its existing tests must keep passing unchanged apart from the wrapper.
- **DB-backed tests need a quiet database.** A concurrent session's pending migration is
  applied to the shared test DB by `migrateTestDb()`, which made full-suite results
  unreliable on 2026-08-10. The pure and jsdom layers are unaffected.
