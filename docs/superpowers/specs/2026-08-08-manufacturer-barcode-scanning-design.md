# Scanning manufacturer asset tags as an alternative to our QR stickers

**Date:** 2026-08-08
**Status:** Approved, ready for implementation planning

## Problem

Adding an item to a hand receipt requires scanning the QR sticker this app
prints. A machine whose sticker was never applied, has peeled, or has been worn
illegible can only be added by hunting for it in the items list. Meanwhile every
laptop in the fleet already carries a manufacturer barcode from the factory.

We want the camera to accept those factory labels as a second way in — starting
with Dell's service-tag label, which is what the first round of testing will use.

## Why this works: the serials already match

`Item.serialNumber` holds the manufacturer serial across the whole fleet. Checked
against production on 2026-08-08 (1,204 ACTIVE items):

| Make | Items | Serial shape |
|---|---|---|
| HP | 731 | avg length 10 — HP's S/N format |
| Dell Inc. | 413 | **all 413** are exactly 7 alphanumeric characters — the service tag |
| Microsoft Corporation | 35 | avg length 14 — Surface serials |
| Getac | 24 | avg length 10 |

Zero rows contain a non-alphanumeric character; lengths run 4 to 14. So a value
read off a factory label can be resolved directly against `serialNumber` with no
data migration, no backfill, and no new column. `serialNumber` is
`@unique @db.Citext`, so the match is case-insensitive and returns at most one row.

## Scope

Two surfaces:

1. **The hand-receipt builder** (`/receipts/new`) — the existing scan sheet, which
   is the only place `QrScanner` is used today.
2. **The items list** (`/items`) — a new scan button that resolves a label to an
   item page.

Out of scope: the public home search. It sits behind the PIN gate and its own
guard in `liveSearchAction`; adding a camera there is a separate decision with
security-review surface this change does not need.

## Architecture

Three layers, each usable and testable without the others.

### 1. Pure parse — `src/modules/items/scan-code.ts` (new)

A leaf file in the same spirit as `scan-url.ts`: no DOM, no network, no Prisma.
It turns a decoded string into a scan intent:

```ts
type ScanIntent =
  | { kind: "item"; id: string }       // our own QR sticker
  | { kind: "serial"; serial: string } // a manufacturer barcode
  | null;                              // unrecognised
```

`parseItemScan` is **wrapped, not replaced** — it keeps its current behaviour, its
comments and its tests, and remains the authority on what our own sticker looks
like. An input it claims becomes `{kind:"item"}`; everything else falls through to
the serial branch.

The serial branch applies, in order:

- **Shape filter** — a candidate must match `^[A-Za-z0-9]{4,20}$`. This is grounded
  in the fleet data above and exists to avoid pointless round trips, not as a
  security control; the database remains the authority, exactly as `scan-url.ts`
  says of its own regex. It also cleanly rejects Dell PPID strings, which carry
  dashes.
- **Express Service Code conversion** — see below.
- **No casing normalisation of the candidate itself.** The column is citext, so
  matching is already case-insensitive; folding case here would create a second
  place where casing rules live. (The Express Service Code conversion below does
  emit uppercase, but that is base-36 output, not a normalisation step.)

### 2. The scanner component — `src/components/QrScanner.tsx`

One new optional prop, `formats`, defaulting to `["qr_code"]` so existing callers
are unchanged. The component keeps knowing nothing about items, receipts or the
schema — the property its own header comment calls load-bearing.

Two other changes inside it:

- **Formats enabled by callers:** `qr_code`, `code_39`, `code_128`, `data_matrix`.
  Dell's service-tag barcode is Code 39 on older labels and Code 128 on newer ones;
  recent labels also carry a DataMatrix square. If per-frame decoding visibly slows
  on a real phone, `data_matrix` is the first to drop — each enabled format costs
  time in every `detect()` call.
- **Camera resolution hint:** `getUserMedia` currently requests only
  `facingMode: "environment"`. Linear barcodes need materially more pixels than a
  QR code to resolve, so the constraint gains `width: { ideal: 1920 }`. `ideal` is
  a request, not a requirement — a device that cannot honour it still works.

### 3. Resolution — `src/app/actions/scan.ts`

**Two** sibling actions to `lookupScannedItem`, because the two surfaces want
different things:

```ts
export async function lookupScannedSerial(serial: string, altSerial?: string): Promise<ScanLookup>
export async function resolveScannedSerial(serial: string, altSerial?: string): Promise<SerialResolution>
```

`lookupScannedSerial` is the **builder's** path: same `requireUser()` guard, same
`ScanLookup` return type, same ACTIVE-only rule (a scan must not become a backdoor
around the filter the builder applies on load), same explicit field subset rather
than the Prisma row.

`resolveScannedSerial` is the **items list's** path: it returns an item id and
nothing else, and it deliberately does **not** apply the ACTIVE filter. That rule
exists because the builder is about to put the item on a hand receipt; the items
list only opens a page, and a retired device is exactly the kind of thing someone
scans to ask "what is this and why is it on the shelf". Folding the two together
would mean a mode flag on one action.

Both share a private `findBySerial` helper and resolve through a new
`getItemBySerialForScan` in `items.service.ts` — the existing `getItemBySerial`
selects `id` alone and is left untouched for `createItemAction`'s P2002 branch.

No schema change. No new index — `serialNumber` is already unique, so this is a
primary-key-grade lookup, not the trigram search path used for type-ahead.

## The Express Service Code

Dell's Express Service Code is not a second identifier. A service tag is 7
characters drawn from `0-9A-Z` — base 36 — and the Express Service Code is that
same value printed in base 10. The two barcodes sit roughly a centimetre apart on
the same sticker, so a camera will regularly lock onto the wrong one.

The conversion is exact in both directions:

| Service Tag | Express Service Code | Digits |
|---|---|---|
| `7X2K9L3` | `17237164935` | 11 |
| `JQ4M8N2` | `42938741054` | 11 |
| `HTX5T13` | `38814517047` | 11 |
| `0ABC123` | `623698779` | 9 |

Rule: an all-digit candidate of **8–11 characters** is converted with
`BigInt(value).toString(36).toUpperCase()` and **left-padded to 7 characters with
`0`**. The padding is not cosmetic — a tag beginning with `0` loses that character
in the numeric form, and padding is what restores it (the `0ABC123` row above).

**The conversion is a fallback, never a substitution.** The parse returns the raw
value as `serial` and the converted tag as `altSerial`, and the action tries the
raw value first — the alternate is only queried if it misses. Converting outright
would rewrite a genuinely numeric 10-digit serial into a 7-character tag naming a
*different* machine, and silently adding the wrong laptop to a hand receipt is far
worse than the failure this feature exists to fix. Trying raw first makes that
unrepresentable, at the cost of one extra query only on a miss.

Without this, scanning the wrong barcode on the label reports "no item in the
book" while the operator is holding a machine that is plainly in the book, with
nothing on screen explaining why.

## Behaviour

### Receipt builder

Unchanged in shape. `onDecode` parses to an intent, calls whichever lookup action
the intent names, and the rest of the existing flow — duplicate check, row/line
caps, the eager `itemsRef` update — is untouched.

Every refusal keeps the camera open, as today. A serial that resolves to nothing
reports **"No item in the book with serial `<value>`"**.

**The builder deliberately does not offer to create the item.** Doing so means
navigating away, which destroys the half-built receipt and any drawn signature.
That asymmetry with the items list is intentional and should not be "fixed".

The 1.5-second dedupe window currently keys on item id. It becomes keyed on the
intent (`id:…` / `sn:…`), because a linear barcode re-decodes every frame exactly
as a QR code does.

### Items list

A scan button beside the search input opens the same overlay.

- **Match** → navigate to `/i/<id>`, retired items included.
- **No match** → navigate to `/items?q=<serial>`.

The second case deliberately adds no new UI. The create-from-search flow already
exists: the empty state offers to create the item,
`/admin/items/new?serialNumber=<serial>` prefills the serial, and
`createItemAction`'s `fromSearch` handling returns the admin to the right filtered
list afterwards. Reusing it means the "add this device" path inherits the existing
admin gate rather than growing a second one.

## Error handling

No new error vocabulary. `ScanLookup`'s existing codes (`NOT_FOUND`, `RETIRED`,
`UNAUTHORIZED`, `FAILED`) cover the serial path; only the `NOT_FOUND` wording
differs between the two paths, because "that item no longer exists" is wrong for a
serial that was never in the book.

## Testing

- **Unit — `scan-code.test.ts`:** our QR URL (absolute and bare-path), a Dell
  service tag, an Express Service Code in both digit lengths, the leading-zero
  round trip, a Dell PPID string, lowercase input, empty and junk input.
- **Action — alongside `scan.test.ts`:** unauthenticated, not found, retired, found.
- **Component — `ReceiptBuilderForm.test.tsx`:** already mocks the scan action;
  gains cases for a serial decode, a no-match refusal, and the intent-keyed dedupe.

**None of this is evidence the camera works.** jsdom has no camera and `next build`
has no layout engine. The acceptance test is a physical Dell service-tag label read
by a real phone against the dev server over the cloudflared tunnel — the camera
needs a secure context.

## Documentation

- `CHANGELOG.md` — user-facing feature, entry under today's date.
- `docs/SECURITY.md` — **not required.** This change adds no authn/authz, crypto,
  token or public-surface behaviour: both new actions are `requireUser()`-gated
  exactly like `lookupScannedItem` beside them, and the item-create path is reused
  unchanged (its own admin gate still applies). Note the `Security docs current` CI
  gate that would previously have had an opinion here **was removed on 2026-08-08**,
  so this is a judgement call rather than a check — see that day's CHANGELOG entry.
- `.claude/rules/ui-styling.md` — review while implementing; the scan sheet is UI
  covered by that rule's path globs.

## Explicitly not doing

- Fuzzy or near-miss serial matching. A confident wrong answer about the property
  book is worse than a clean "not found".
- Any change to the public search or its PIN gate.
- Uppercasing or otherwise rewriting serials on the way into the database.
