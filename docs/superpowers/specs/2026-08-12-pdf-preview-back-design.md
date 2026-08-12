# A way back from an inline PDF in the installed app

**Date:** 2026-08-12
**Status:** Approved, ready for implementation planning

## The problem

Tapping **Preview PDF** on a hand receipt from the iPhone home-screen install
leaves the user stranded. There is no way back to the receipt short of killing
the app.

The mechanism, confirmed in the code rather than assumed:

* The link carries `target="_blank"` and points at a route that answers
  `Content-Disposition: inline`, so the browser navigates to a raw
  `application/pdf` response.
* iOS collapses `target="_blank"` into the same browsing context for a
  standalone (`display: standalone`) install. The app has declared itself
  standalone since `src/app/manifest.ts:27` and the `appleWebApp` block in
  `src/app/layout.tsx`.
* A standalone window has no tab strip, no address bar and no back button, and
  a PDF page carries no app chrome of our own. Nothing is left to press.

Nothing in the codebase detects `display-mode: standalone` today.

## The three affected surfaces

| Surface | Call site | URL | Goal |
| --- | --- | --- | --- |
| Receipt preview | `receipts/[receiptNumber]/page.tsx:105` | `/receipts/<n>/pdf?preview=1` | **Read it** |
| Receipt preview (builder) | `receipts/new/ReceiptBuilderForm.tsx:604` | same | **Read it** |
| Item Print QR | `i/[itemId]/page.tsx:293` | `/i/<id>/qr/pdf` | **Print it** |
| Bulk QR sheet | `ItemSelectTable.tsx:518` (`window.open`) | `/admin/items/qr-sheet/pdf?items=…&preview=1` | **Print it** |

All four dead-end the same way. **They do not want the same fix**, and that is
the central constraint of this design — see "The QR surfaces want the native
viewer" below.

## Scope

**Standalone installs only.** In an ordinary browser tab the current behaviour
is correct and stays exactly as it is: `target="_blank"` opens a real tab with
the browser's own back button and PDF viewer.

## Approach

A full-screen in-app overlay. The trigger intercepts its own click when running
standalone and opens a popover containing an `<iframe>` of the existing PDF URL,
above a bar carrying **← Back** plus per-surface actions.

### Why not a dedicated route

The obvious alternative — a real `/receipts/<n>/preview` page with `AppHeader`
and a back link — was rejected because it lands in three security-sensitive
files for what is a navigation affordance:

* `src/proxy.ts:91`'s `RECEIPT_PATH` is `/^\/receipts\/(?!new(?:\/|$))([^/]+)(?:\/pdf)?$/`.
  A `/preview` suffix matches neither the PIN gate's membership test nor the
  receipt number extraction.
* The receipt-link token admits its holder to exactly the receipt page and its
  PDF. Extending that grant is called out in `CLAUDE.md` as requiring an
  explicit decision plus a `docs/SECURITY.md` update.
* A logged-out recipient arriving from an emailed link would otherwise be
  bounced to the PIN prompt the moment they tapped Preview.

The overlay introduces no new URL, so all three stay untouched.

### Why the iframe reaches the PDF for every population

The iframe issues its own same-origin request, so it must satisfy the proxy on
its own. It does, for all three ways a person reaches a receipt:

* **Logged in** — session cookie.
* **PIN unlocked** — the 12-hour unlock cookie.
* **Emailed receipt link** — `src/proxy.ts:263-275` verifies the `?k=` token
  once and redirects to the clean URL having set a **grant cookie**
  (`receiptGrantCookieName`). The token is gone from the address bar by the time
  the page renders; the cookie is what authorises subsequent requests, including
  the existing Download PDF link and now the iframe.

The two QR routes are behind `requireUser()` / `requireCapability("MANAGE_ITEMS")`
and are only reachable from signed-in pages, so the session cookie covers them.
Both answer an `AuthError` with a plain-text 401/403 body, which inside the
overlay renders as that text rather than a PDF — honest, and not a new
behaviour.

## The QR surfaces want the native viewer

This is the finding that shapes the design, and it argues against applying the
receipt's treatment uniformly.

`src/app/i/[itemId]/qr/pdf/route.ts:6-9` and the comment at
`src/app/i/[itemId]/page.tsx:289-292` both say the same thing: these routes
serve a **PDF** precisely because iOS/WKWebView silently ignores
`window.print()`, so the native full-screen viewer is how a phone reaches
**Share → Print / Save to Files**. Printing a label is the entire purpose of
both QR surfaces.

An `<iframe>` does not carry the native viewer's share and print affordances.
Confining the QR PDFs to the overlay would therefore buy a back button by taking
away the feature — a bad trade, and the opposite of what was asked for.

So the overlay's action bar is **configurable per surface**:

* **Receipt preview → Back, Download.** The goal is reading it. An "open the
  real PDF" action here would navigate the standalone window and re-create
  exactly the dead end this change exists to fix, and the receipt page already
  offers Download separately.
* **QR surfaces → Back, Download, Open in viewer.** "Open in viewer" navigates
  to the inline PDF, which is today's behaviour and the path to Share → Print.
  It is labelled to say it leaves the app.

That last action is a deliberate, narrow reversal of the receipt-side reasoning,
and the difference is the user's goal: someone reading a receipt wants to come
back, someone printing a label wants the printer. The net is still strictly
better than today, because the choice now exists at all — today the QR PDF
takes the window with no way back and no alternative.

## Components

### 1. `src/lib/standalone.ts` (new)

```
export function isStandaloneDisplay(): boolean
```

```
window.matchMedia("(display-mode: standalone)").matches
  || (navigator as { standalone?: boolean }).standalone === true
```

Both halves are needed: the media query is the standard and covers Android and
desktop installs; `navigator.standalone` is the legacy iOS-only property.

Client-only — it reads `window`, so it is called from event handlers, never at
render or on the server. It is **not** one of the three proxy-safe files in
`src/lib` and has no bearing on them.

### 2. `src/components/PdfPreviewOverlay.tsx` (new, client)

The popover, the bar and the iframe. Props: the overlay `id`, a `title`, the
`src` (or `null` when closed), an `onClose`, and the optional extra actions
described above.

Follows the trap documented in `.claude/rules/ui-styling.md`: the element
carrying `popover` gets **no class and no `display`**; all layout lives on an
inner `.pdf-preview__panel`.

`popover="auto"`, for Escape and focus return to the invoker.

`useDismissSwallowsTap` is deliberately **not** used. It exists to swallow the
click a light dismiss delivers to whatever sits underneath, and a
viewport-filling popover has no reachable outside for a dismissing tap to land
on.

The `src` is set **when the overlay opens**, never at render. Rendering it
eagerly would make every receipt page load trigger a server-side `pdf-lib`
render of the whole DA 2062, and every `/items` load render a QR sheet.

### 3. `src/components/PdfPreviewButton.tsx` (new, client)

For the three call sites that are anchors. Props: `href`, `title`, and the
action set.

Renders the same anchor as today — same classes, same `target="_blank"`, same
`rel` — so server output and non-standalone behaviour are byte-identical.
`onClick` calls `isStandaloneDisplay()` **at click time**, and only then
`preventDefault()`s and opens the overlay.

Evaluating at click time rather than in `useState` + `useEffect` means no
hydration flash and no re-render — the same reason `AppHeader` renders both navs
and lets CSS choose rather than checking the viewport in JS. A tap landing
before hydration falls through to today's behaviour, which is no worse than the
current state.

### 4. `ItemSelectTable.tsx` — the one non-anchor call site

`printQr` (line 518) is a handler on a plain selection-bar button (line 649),
**not** inside the `BulkActionsMenu` popover, so no nested-popover question
arises. It gains the same branch: standalone opens the overlay, everything else
keeps today's `window.open`.

### 5. `globals.css` — a new id, deliberately not in the shared group

Styled by id (`#pdf-preview`) like the existing three, so no shared class can
later grow a `display`.

It must **not** join the `#items-sortfilter, #queue-sortfilter,
#items-bulkactions` rule groups. Those are bottom sheets (`inset: auto 0 0 0`,
`width: 100%`); this is a full-viewport surface (`inset: 0`). It gets its own
base rule and its own `::backdrop`, and nothing inside the anchored `@supports`
block — it is not anchored to a trigger.

**One overlay per page**, which is what lets a single fixed id serve all four
call sites: `/receipts/<n>`, the builder, `/i/<id>` and `/items` each mount
exactly one. A second on one page would need its own id and its own rules — the
same lesson the two anchor names on `/items` already record.

### 6. Overlay contents

A bar across the top holding **← Back**, the title, and the surface's actions;
an `<iframe>` filling the remainder.

* Back is `popovertarget` + `popovertargetaction="hide"` — no handler, no state.
* The bar needs `env(safe-area-inset-top)` padding. A standalone window has no
  browser chrome, so without it the bar sits under the status bar and notch.
* Controls honour the documented 44px `--tap` floor.
* No z-index work is needed against the bottom nav rail (z-index 40) — a popover
  renders in the top layer.

## Testing

**What jsdom can pin** (`*.test.tsx`, `npm run test:ui`, jsdom opted in per file
via the line-1 docblock):

* the popover element carries no `class` — the same invariant
  `ItemSelectTable.test.tsx`, `ServiceQueueTable.test.tsx` and
  `BulkActionsMenu.test.tsx` each pin;
* each anchor still renders its `href` and `target="_blank"`;
* the click is left alone when the standalone check fails, and intercepted when
  it passes (`matchMedia` stubbed);
* the receipt overlay offers no "Open in viewer" action and the QR overlays do.

`isStandaloneDisplay` is a pure function of `window` and unit-tests directly
against a stubbed `matchMedia`/`navigator`.

**What jsdom cannot see.** It implements no Popover API — `showPopover` is
undefined and `:popover-open` never matches — so opening, dismissal and focus
behaviour are not testable there. Neither `npm run build` nor jsdom has a layout
engine or a PDF viewer.

**Device verification is required, not optional.** WKWebView has a long history
of rendering only the first page of an iframed PDF, without scrolling. The
receipt is two pages (the DA 2062 form plus the custody record page added at
`hand-receipt.ts:241`) and a bulk QR sheet can be many. Verify on a real iPhone
home-screen install over the cloudflared tunnel, on a multi-page receipt **and**
a multi-page QR sheet.

**If the iframe proves inadequate on iOS**, the surrounding design holds and only
the iframe body changes — rendering pages to canvas with `pdfjs-dist`. That adds
a dependency, a worker asset and real bundle weight, so it is a decision to
confirm before taking, not a fallback to apply silently. Note the QR surfaces
have a cheaper out if it comes to that: "Open in viewer" already reaches the
native renderer, so their fallback could be to lead with that action rather than
to render pages ourselves.

## Documentation, in the same commit

* `CHANGELOG.md` — a user-facing `Fixed` entry under `## 2026-08-12`.
* `.claude/rules/ui-styling.md` — the popover section states that a new caller
  must add its id to all four rule groups. This one deliberately does not.
  Unwritten, that reads as exactly the mistake the rule exists to prevent. The
  same note should record that the QR surfaces keep a route to the native
  viewer, so a later tidy-up does not "simplify" the action sets into one.

No `docs/SECURITY.md` change: no authz check, route, token, cookie or public
surface moves. The overlay renders PDFs the same viewer could already reach at
the same URLs under the same gates.

## Out of scope

* Any change to browser-tab behaviour.
* Any change to how the PDFs themselves are generated.
* Converting `window.print()` paths to PDFs anywhere new.
