# Scan to build a hand receipt — design

**Date:** 2026-07-15
**Status:** approved, not yet planned

## Problem

Scanning an item's QR code opens its item page. From there, building a hand receipt for
that item means navigating away, finding it again in the items list, selecting it, and
clicking through to the builder. And once the builder is open, the item list is fixed:
adding a second laptop means starting over.

The operator is standing at a cart with the hardware in front of them and a phone in
their hand. The stickers are already on the equipment. They should be able to scan the
first item into a fresh receipt, then keep scanning to fill it.

## Goals

- A button on the item page that opens a new hand receipt containing that item.
- In the builder, scan additional QR codes with the phone camera to add items, without
  losing typed work — with **one deliberate exception**: a signature is cleared when the
  item list changes, because it attests to a specific list (see *Defects*, #3).
- Works with the QR codes already printed and stuck to hardware. No reprint.

## Non-goals

- Restoring typed party fields after a reload. The **item list is** restored — see
  *Refresh and tab eviction*.
- Restoring a drawn signature after a reload. Deliberate, not a gap — see the same
  section.
- Moving a partially-built receipt between devices.
- Using the phone as a scanning peripheral for a form open on a desktop.
- Any change to QR generation, label layout, or the printed sheet.

## Context and constraints

Established by inspection, not assumption:

- The builder already takes its items from a URL param: `/receipts/new?items=id1,id2`
  (`receipts/new/page.tsx:11-20`). The entry-point button needs no new plumbing.
- `groupItemsIntoLines` (`modules/transfers/receipt-lines.ts:19`) is pure with no
  `server-only` import, so a client component can call it.
- `createReceiptAction` already treats the posted item list as untrusted: `createTransfer`
  re-validates and throws `ITEM_NOT_FOUND`, `ITEM_RETIRED`, `TOO_MANY_LINES`,
  `TOO_MANY_PER_ROW` (`app/actions/receipts.ts:101-109`). The builder already posts its
  items from client-controlled hidden inputs (`ReceiptBuilderForm.tsx:251`), so moving the
  item list into client state does not widen the trust boundary.
- `Item.id` is a `cuid` (`schema.prisma:68`) — assigned once, never reissued.
- Target hardware is iPhones. Safari has never shipped `BarcodeDetector`, so a bundled
  decode library is required, not optional.
- `globals.css:920-993` restacks any `.table` into labeled mobile cards under 720px,
  driven by `data-label`. The builder already holds up that contract as of `a08d9e5`.

## Decisions

**The item list becomes client state; scans resolve through a server action.**

Considered and rejected:

- *Navigate to a new `?items=` URL on each scan.* Server stays the single source of truth
  and sender prefill recomputes for free — but it remounts the form on every scan,
  discarding the drawn signature and every typed field. The comments at
  `ReceiptBuilderForm.tsx:66-79` and `:131-135` exist because failed submits were already
  silently resetting values. This would reintroduce that class of bug deliberately.
- *A persisted draft record.* Most robust; survives refresh and would enable a
  phone-as-peripheral setup later. Costs a schema migration, a draft lifecycle, and
  cleanup of abandoned drafts. Deferred, not dismissed.

Cost: once scanning starts, client state — not the URL — is the source of truth. Handled
in *Refresh and tab eviction* rather than accepted.

## Architecture

### Entry point

The item page gets a **Create hand receipt** button linking to
`/receipts/new?items={item.id}`. Rendered only when logged in (`i/[itemId]/page.tsx:36`'s
`loggedIn`), since the builder calls `requireUser()`. Not rendered for `RETIRED` items —
the builder rejects them anyway (`receipts/new/page.tsx:17`).

### Item list ownership

`/receipts/new/page.tsx` keeps its current job: read `?items=`, load items, compute
`senderPrefill`, pass to the form. The change is that `ReceiptBuilderForm` treats those
items as **initial** state, holding `useState<LineItem[]>` and deriving display rows via
`groupItemsIntoLines(items)` each render. The derived rows feed the same hidden inputs
`createReceiptAction` reads today.

`senderPrefill` is computed once on load (`page.tsx:37-41`) and **never recomputed**. A
scan must not rewrite fields the operator has typed — that is the entire reason this
approach was chosen over navigation.

### Scan path

1. The scanner decodes a string.
2. The string is parsed **client-side** against the path `/i/{id}` (below). A stray
   barcode is rejected without a round trip.
3. A valid id calls `lookupScannedItem(itemId)`.
4. On success the item appends to state; the row appears. Nothing navigates.

### Parsing: match the path, not the origin

The QR encodes exactly `` `${baseUrl.replace(/\/$/, "")}/i/${itemId}` `` (`modules/items/qr.ts:8-14`) —
the URL and nothing else. The serial printed on a label is drawn as separate text
(`qr-sheet.ts:39-45`), not encoded.

The origin baked into a sticker is whatever `defaultBaseUrl()` resolved to at print time
(`lib/base-url.ts:5-9`): `APP_URL`, else Vercel's injected domain, else `""` — which
yields a bare `/i/{cuid}` with no origin at all. Batch labels come from
`/admin/items/qr-sheet/pdf`, which calls `buildItemsQrSheetPdf(items)` with no `baseUrl`
(`admin/items/qr-sheet/pdf/route.ts:22`), so sheets carry the origin of the deploy that
served the request — production, in practice.

**Therefore: accept any decoded string whose path is `/i/{id}`, ignoring the host.** Try
`new URL(text)`; if that throws, treat the text as a bare path. Then match
`^/i/([A-Za-z0-9]+)$`.

This is not a security relaxation. The origin was never the check that mattered:
`lookupScannedItem` calls `requireUser()` and resolves the cuid against the database. An
id from a wrong-origin sticker either names a real item or does not exist. Matching on
the path also means stickers survive a future domain change.

### `lookupScannedItem(itemId)` — server action

Per the access-control guardrail, `requireUser()` **first**. Returns either the item's
`make`, `model`, `serialNumber` and current holder, or a typed refusal code. Every
human-facing detail comes from this lookup, never from the sticker — so a sticker on an
item whose details were later corrected still resolves to current data.

### Limits

`MAX_RECEIPT_ROWS` (18) and `MAX_ITEMS_PER_ROW` (10) are currently a server-side gate that
swaps the whole form for a card (`receipts/new/page.tsx:52-55`). That stays correct for
the initial load. But scanning can cross a limit mid-session, and replacing a half-filled
form with a card at that point would destroy the operator's work. So the limits get a
second, client-side check that refuses **the scan** and leaves the form untouched. The
`createTransfer` checks remain authoritative.

## Refresh and tab eviction

**Framing.** Refreshing the builder already loses everything today — every party field,
the signature, the quantities. The items survive only because they come from the URL. So
client-owned state does not *create* a refresh problem; it adds the item list to a loss
that already happens. Keeping the URL in sync restores **parity with today**, which is why
it is v1 work and not a stretch goal.

**Why this matters more here than anywhere else in the app.** iOS Safari aggressively
evicts background tabs and silently reloads them on return. A page holding a live camera
stream plus a WASM decoder is among the most memory-hungry things it can be asked to keep
— a prime eviction candidate. On the exact device this feature targets, a reload is not
the operator fat-fingering refresh; it is them switching apps for ten seconds.

**Layer 1 — `replaceState` keeps `?items=` in sync. (v1)**

Every add or remove rewrites the URL without navigating or remounting. A reload then
re-renders the server page with the full list, and lines and sender prefill rebuild
through the path they already take.

Verified against the vendored docs rather than recall, per AGENTS.md: Next 16 supports
`window.history.replaceState` to "update the browser's history stack without reloading the
page", integrated with the router
(`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md:343-345`).
Use `replaceState`, not `pushState` — each scan is not a history entry, and Back should
leave the builder rather than un-scan one laptop at a time.

**Layer 2 — a `sessionStorage` snapshot of typed state. (follow-on)**

Party fields, service flags, quantities; restored on mount, cleared on submit. Per-tab, so
it survives eviction. Genuinely optional and can ship separately.

**Layer 3 — the signature is never restored. (deliberate)**

A signature is a person's mark on a custody document. Reattaching ink from storage would
let a receipt carry a signature the signer never re-affirmed against the list actually
filed. Re-drawing costs three seconds. It also carries a privacy cost — a signature image
sitting in storage on a shared phone.

## Components

### `QrScanner`

A client component that opens the camera and emits decoded strings. Props: `onDecode(text)`,
`onClose()`. It owns the media stream and the decode loop and nothing else — no knowledge
of items, receipts, or the schema, so it is independently testable and reusable (e.g. the
returns flow).

Requirements:

- The `<video>` needs `playsInline` (plus `muted`, `autoplay`). Without it iOS Safari
  hijacks playback into its fullscreen native player and the overlay breaks. This is the
  most common way in-page scanners fail on iPhone.
- Request `facingMode: "environment"`.
- **Stop every media track on close and unmount.** Otherwise the camera indicator stays
  lit after the sheet closes.
- Camera access requires a secure context. Vercel is HTTPS; `localhost` counts, so local
  dev works without a tunnel.
- Suppress repeat decodes of the same id for ~1.5s — a QR sitting in frame decodes many
  times per second.
- Renders as a **sheet overlaying the builder**, never a route. Routing away is the
  state-loss trap.

**Decode library: `barcode-detector`** (MIT, Sec-ant), a ponyfill of the standard
`BarcodeDetector` API backed by zxing-wasm.

Chosen so we write against the **web standard**, not a vendor API: the browser's native
implementation is used where it exists, the ponyfill fills in on iOS Safari. If Safari
ever ships the real thing, we delete a dependency instead of rewriting the scanner.

Candidates validated with `npm view` per the supply-chain guardrail (2026-07-15):

| Package | Version | Last published | Verdict |
|---|---|---|---|
| `barcode-detector` | 3.2.1 | 2026-07-12 | **Chosen** — actively maintained |
| `@zxing/browser` | 0.2.1 | 2026-07-06 | Viable fallback; still 0.x |
| `@zxing/library` | 0.23.0 | 2026-04-29 | Viable fallback; still 0.x |
| `jsqr` | 1.4.0 | 2025-11-13 | Alive; pure JS, vendor API |
| `html5-qrcode` | 2.3.8 | 2023-04-15 | Rejected — 3 years stale |
| `qr-scanner` | 1.4.2 | 2022-11-23 | Rejected — 3.5 years stale |

`html5-qrcode` is the name recall suggests first and has not shipped since 2023. Recording
that here so it is not re-proposed.

**Cost:** a WASM payload. It must be **lazy-loaded only when the scanner sheet opens**,
never in the builder's initial bundle, and its transfer size measured on a real connection
during implementation rather than assumed acceptable. If it proves too heavy for field
use, `@zxing/browser` is the fallback.

### Feedback

- Audio beep via `AudioContext` (the "Scan" tap unlocks audio). Distinct, lower tone for
  a refusal — the operator's eyes are on the hardware, so accept and reject must be
  distinguishable by ear alone.
- **No haptics.** `navigator.vibrate` has never been supported in Safari on iOS.
- A toast naming what landed: `Added: Dell Latitude · SN 7X4K2`. It is the primary
  confirmation, so it names the item rather than saying "Added".

### `ReceiptBuilderForm` changes

- Owns the item list; derives lines each render.
- A **remove control** per item row. Scanning makes mis-adds easy in a way hand-picking
  never did, so the undo path is not optional.
- Two lifted state fixes — see below.

### Item page button

A link. No new component.

## Scan outcomes

Every refusal **keeps the camera open**. Rapid-fire only works if a bad scan is a blip,
not a dead end.

| Scan | Result |
|---|---|
| Path is not `/i/{id}` | "Not an item code" — rejected client-side, no round trip |
| Item not found | "That item no longer exists" |
| Item retired | "That item is retired and can't be transferred" |
| Already on this receipt | "Already added — Dell Latitude · SN 7X4K2" |
| Receipt full | "This receipt is full — 18 item types max" (or 10 per row) |
| Held by someone else | **Adds**, with a warning — below |
| Lookup failed | "Couldn't look up that item — try again" |

### Mixed holders

A receipt has one sender. An item held by someone else is **added with a warning**, not
blocked: legitimate cases exist (an item never transferred, out-of-date paperwork), and
blocking would create a dead end at the cart. Today this case is silent — mixed holders
merely mean no sender prefill.

The warning does double duty, because a toast that vanishes while the operator is looking
at a laptop is a warning nobody reads:

1. A toast at scan time.
2. A **persistent marker on the row** — "Held by CPL Jones, not SGT Smith" — still on
   screen at signature time, when it can change what someone does.

It fires only when a sender name is present and differs. An item never transferred has no
holder to disagree with; a blank sender field cannot conflict.

### Camera denial is a one-way door on iOS

If someone taps "Don't Allow", Safari remembers per-site and JavaScript **cannot
re-prompt** — `getUserMedia` fails silently forever. So that message names the actual way
out (Settings → Safari → Camera, or the `aA` menu → Website Settings) and points at the
working alternative: select items on `/items` and use the existing selection flow, which
already supports multi-select with retired rows unselectable (`components/items-view.ts:38-53`).

On a device with no camera the scan button does not render at all.

## Three defects to design out

None exist today. All three are latent consequences of one assumption this feature breaks:
**the item list is currently frozen at mount.** They are the species this file already has
scar tissue for, so they get designed out rather than discovered.

**1. Stale quantities.** `QtyInput` seeds its state once via `useState(String(defaultQty))`
(`ReceiptBuilderForm.tsx:140`). Once a scan can grow a line, scanning a second identical
Latitude leaves the line holding two serials while the Issued box still reads `1` — and
the receipt is filed claiming one while listing two. That is a data-integrity defect on a
custody document.

*Fix:* lift qty into the form keyed by line (make+model), tracking the item count until
the operator edits it, then leaving it alone.

`rowSpan` stays. Quantities are per-line; splitting them per serial would emit duplicate
`line[i][qtyAuth]` fields and change what the form submits (`a08d9e5`).

**2. Service flags resetting on removal.** Line rows are keyed
`<Fragment key={ln.items[0].itemId}>` (`:259`). Removing the first item of a two-item line
changes that key, so React remounts the line and the **surviving** item's "Needs service?"
selection silently clears.

*Fix:* lift the service selections into the form keyed by `itemId` — the pattern this file
already applies to `note`, `rank`, `unit`, and the party fields.

**3. A signature covering a list the signer never saw.** The most serious of the three.

Today the item list is frozen at page load, so signing last is *inherently* safe — the ink
always covers the final list. Once a scan can grow the list at any moment, an operator can
have the recipient sign and then scan two more laptops, and the receipt files with a
signature over a list the signer never saw. Rapid-fire scanning makes that sequence easy
rather than exotic, and nothing in the form's order prevents it.

*Fix:* treat a signature as covering a **specific item list**. If the list changes while a
signature exists, clear it and say why — "Items changed — please sign again." Annoying by
design, and correct: the alternative is a custody document attesting to something that
never happened.

Applies to a drawn `SignaturePad` signature and to a picked saved technician signature
(`TechnicianSignatureField`) alike — a DCSIM recipient's saved ink is still their
attestation to a list.

## Mobile

The card layout already exists and is generic: `globals.css:920-993` restacks any `.table`
into labeled cards under 720px via `data-label` and `td::before`. The mobile card already
promotes the serial to a tinted band at the top (`.table td.mono[data-label]`,
`order: -1`, `:980-988`) because it is the string an operator matches against a sticker —
which is precisely this workflow.

The qty `data-label` is already dynamic — `Qty authorized (all ${ln.items.length} serials)`
— so a scan appending a serial updates it to "all 2 serials". That makes the stale-quantity
bug louder rather than hidden.

So the work is **not breaking the contract**:

- The remove control uses `.actions` (and `.actions--end` for desktop right-alignment),
  **never** an inline `justifyContent`. `a08d9e5` found three inline
  `justifyContent: "flex-end"` that outranked the mobile re-alignment rule and stranded
  buttons pinned right inside stacked cards.
- Any cell with more than one child gets `.is-stacked`, or its children lay out side by
  side and collide. The holder-warning marker needs this.
- Touch targets come free — `.btn`/`.btn-sm` are already raised to the 44px floor under
  720px — provided the scanner sheet uses `.btn` rather than bespoke controls.
- The scanner sheet is new surface outside any table and inherits nothing. It must use
  `--tap`/`--tap-lg` and the current palette explicitly: ledger-stock surfaces, ink text,
  the single stamp-pad accent. Not a second accent.
- The scan button is fixed to the bottom of the viewport on mobile (reachable
  one-handed with a laptop in the other), and a normal button in the items fieldset on
  desktop.

## Testing and verification

- **Node test:** the URL parser. `/i/{id}` in, cuid or reject out. Covers the bare-path,
  wrong-origin, and foreign-QR cases.
- **`test:ui` (jsdom, opt-in per file):** the state logic — scan appends a row, duplicate
  refuses, qty tracks the count until edited, removing an item does not reset a sibling's
  service flag, **and a signature clears when the item list changes** (both a drawn one
  and a picked saved one). These are the regressions worth pinning; the signature one
  guards a custody-document integrity rule, so it is not optional.
- **`replaceState` sync:** assert the URL tracks adds and removes, and that a reload at
  that URL rebuilds the same lines. Cheap to pin and easy to regress silently.
- **Real browser at 390×844 and 1280, with DOM measurement** for overflow and tap-target
  size. jsdom has no layout engine, and neither it nor `next build` can see any of the
  defects `a08d9e5` fixed — that commit says so explicitly. A green suite is not evidence
  for a layout claim.
- **Chromium with a fake video stream** feeding a known QR covers the decode loop and
  dedupe.
- **A real iPhone** before trusting this in the field. `playsInline` behaviour and
  permission-denial being a one-way door cannot be faked.

## Deferred

- **`sessionStorage` snapshot** of typed party fields, service flags, and quantities
  (Layer 2 above). Ships separately; the signature is excluded permanently, not pending.
- **Persisted drafts** (the rejected Approach C). Revisit if a receipt needs to move
  between devices — `replaceState` already covers surviving a reload.
- **Phone as a scanning peripheral** for a desktop form. Needs a live channel and pairing.
