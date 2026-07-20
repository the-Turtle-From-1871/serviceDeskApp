# Print QR from the item view page

**Date:** 2026-07-20
**Status:** Approved (pending spec review)

## Goal

Add a **Print QR** button to the QR card on the individual item view page
(`/i/[itemId]`) so a logged-in technician can print a clean, self-identifying
QR label for an asset directly from the page they're already looking at.

The browser print dialog must show **only** the QR label — QR image, make/model,
serial number, and item URL — with the site header and every other page section
(details, service, audit, hand-receipt history) dropped out of the printout.

## Context (what already exists)

- **`/i/[itemId]`** (`src/app/i/[itemId]/page.tsx`) is a **public** item detail
  page. It already **renders** the QR image inside a `.card` (page.tsx:173–180):
  QR `<img>` + caption "Scan to view this item" + the item URL. There is no
  print affordance today.
- The QR card sits **outside** the `loggedIn` gate, so the QR itself is already
  public by design (an accepted requirement — see CLAUDE.md's public-endpoints
  note). This spec does **not** change that.
- A separate **admin-only** print page exists at
  `src/app/admin/items/[itemId]/qr/page.tsx` (uses `.qr-card`, offers a
  "Download label (PDF)" button), plus an admin-gated PDF-label route at
  `src/app/admin/items/[itemId]/qr/pdf/route.ts`. Those are unchanged by this
  work and are **not** reused here — they're admin-gated, whereas this button
  lives on the public item page for any logged-in user.
- The site header renders `<header className="app-header">`
  (`src/components/AppHeader.tsx:34`), already hidden by the existing
  `@media print` block.
- `src/app/globals.css` already has an `@media print` block (~line 983) that
  hides `.app-header` and `.no-print`, and strips card shadows.

## Decisions (from brainstorming)

1. **Mechanism:** in-page **Print button** calling `window.print()`, with print
   CSS isolating the QR card. No new route; no PDF download; no server/auth
   change.
2. **Visibility:** the button is shown **only when logged in** (`loggedIn`
   gate). The QR image itself stays publicly visible as today — only the print
   *affordance* is gated.
3. **Printed content:** QR image + `Make Model — Serial <SN>` + item URL.
4. **On-screen identifier:** **print-only** (Option A). The make/model + serial
   line is hidden on screen (the page `<h1>` already shows it just above the
   card) and appears **only** in the printout, so the printed label is
   self-identifying without duplicating the h1 on screen.

## Changes

### 1. New client component — `src/app/i/[itemId]/PrintQrButton.tsx`

A minimal `"use client"` button. It must be a client component because
`window.print()` runs in the browser; the rest of the page stays a Server
Component.

```tsx
"use client";

export function PrintQrButton() {
  return (
    <button
      type="button"
      className="btn btn-secondary no-print"
      onClick={() => window.print()}
    >
      Print QR
    </button>
  );
}
```

The `no-print` class ensures the button itself does not appear in the printout
(existing `@media print { .no-print { display: none } }`).

### 2. `src/app/i/[itemId]/page.tsx`

- Import `PrintQrButton`.
- Add marker class **`qr-print-host`** to the page `<main>` (currently
  `className="container container-mid stack"`).
- In the existing QR card block (page.tsx:173–180):
  - Add marker class **`qr-print-area`** to the card `div`.
  - Add a **print-only** identifier line above (or below) the image:
    `<p className="qr-print-label"><strong>{item.make} {item.model}</strong> — Serial {item.serialNumber}</p>`
  - Render the button, logged-in only: `{loggedIn && <PrintQrButton />}`.
    (`loggedIn` is already computed at page.tsx:43.)

The `qr` truthiness gate around the card is unchanged; if QR generation failed
(empty string) the whole card — button included — is absent, which is correct.

### 3. `src/app/globals.css`

Extend the existing `@media print` block and add the screen-default for the
print-only label. Scope the isolation to the item page via `.qr-print-host` so
the **admin** QR print page is untouched (no global `body *` rule):

```css
/* screen default — hidden; shown only in print (see @media print) */
.qr-print-label { display: none; }

@media print {
  /* … existing rules (.app-header, .no-print hidden; shadows stripped) … */
  .qr-print-host > *:not(.qr-print-area) { display: none !important; }
  .qr-print-area { border: none; box-shadow: none; }
  .qr-print-label { display: block; }
}
```

Because only the direct children of the item page's `<main>` are hidden, and the
QR card is a direct child, exactly the QR card prints. The admin QR page
(`.qr-card`, no `.qr-print-host`) is unaffected.

## Authorization / data flow

No change. The button is pure client-side `window.print()`. No new endpoint, no
new query, no new data exposed — the printout contains only what the public item
page already renders. No `requireUser`/`requireAdmin` surface is touched.

## Testing / verification

- **Print output is visual**, so the authoritative check is a **browser
  print-preview** (via the `verify`/`run` skill): confirm that from `/i/<id>`
  the Print QR button (visible only when logged in) opens the print dialog
  showing **only** the QR image + `Make Model — Serial <SN>` + URL, with the
  header and all other cards absent.
- `npm run lint` and `npm run build` confirm the code compiles and the client
  component is wired correctly.
- **Per project convention, jsdom and `npm run build` are NOT evidence for the
  print CSS** (no layout engine / print media in either) — the print-preview in
  a real browser is the proof.

## Docs (ship in the same commit)

- **`CHANGELOG.md`** — add an entry under `## 2026-07-20` → **Added**:
  a Print QR button on the item detail page for logged-in users that prints a
  QR label (QR + make/model + serial + URL). User-facing `feat:`.
- No new env var, table, cron, or migration → no **Notes** subsection needed.
- No CLAUDE.md/AGENTS.md/README rule is contradicted or extended by this change.

## Out of scope / YAGNI

- No changes to the admin QR page or PDF-label route.
- No PDF generation for this button (browser print only).
- No public (logged-out) print button — the QR stays publicly *viewable*, but
  printing is a logged-in affordance per the decision above.
- No physical-label sizing / `@page` margins beyond what the browser print
  dialog offers (the existing PDF-label route already serves precise label
  sheets for that need).
