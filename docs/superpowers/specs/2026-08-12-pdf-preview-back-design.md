# PDF preview needs a way back in the installed app

**Date:** 2026-08-12
**Status:** Approved, ready for implementation planning

## The problem

Tapping **Preview PDF** on a hand receipt from the iPhone home-screen install
leaves the user stranded. There is no way back to the receipt short of killing
the app.

The mechanism, confirmed in the code rather than assumed:

* `src/app/receipts/[receiptNumber]/page.tsx:105` and
  `src/app/receipts/new/ReceiptBuilderForm.tsx:604` both link to
  `/receipts/<n>/pdf?preview=1` with `target="_blank"`.
* That route (`src/app/receipts/[receiptNumber]/pdf/route.ts:11`) answers
  `Content-Disposition: inline` when `?preview` is present, so the browser
  navigates to a raw `application/pdf` response.
* iOS collapses `target="_blank"` into the same browsing context for a
  standalone (`display: standalone`) install. The app has declared itself
  standalone since `src/app/manifest.ts:27` and the `appleWebApp` block in
  `src/app/layout.tsx`.
* A standalone window has no tab strip, no address bar and no back button, and
  a PDF page carries no app chrome of our own. Nothing is left to press.

Nothing in the codebase detects `display-mode: standalone` today.

## Scope

**Standalone installs only.** In an ordinary browser tab the current behaviour
is correct and stays exactly as it is — `target="_blank"` opens a real tab with
the browser's own back button and PDF viewer.

**The receipt preview only.** Two other surfaces navigate to an inline PDF the
same way and have the same dead end:

* `src/app/i/[itemId]/page.tsx:293` — Print QR (`inline` unconditionally)
* `src/components/ItemSelectTable.tsx:518` — bulk QR sheet (`window.open`)

They are deliberately **out of scope** here. The new component takes a URL, so
wiring them later is small, but widening the change now is not what was asked
for and each has its own print-flow considerations.

## Approach

A full-screen in-app overlay on the receipt page. The button intercepts its own
click when running standalone and opens a popover containing an `<iframe>` of
the existing PDF URL, above a bar carrying **← Back**.

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

## Components

### 1. `src/components/PdfPreviewButton.tsx` (new, client)

Props: the PDF `href` and a `title` for the overlay bar.

Renders the same anchor as today — same classes, same `target="_blank"`,
same `rel` — so server output and non-standalone behaviour are byte-identical.

`onClick` evaluates standalone **at click time**:

```
window.matchMedia("(display-mode: standalone)").matches
  || (navigator as { standalone?: boolean }).standalone === true
```

Both halves are needed: the media query is the standard and covers Android and
desktop installs, `navigator.standalone` is the legacy iOS-only property.

Only when that is true does it `preventDefault()` and open the overlay.
Evaluating at click time rather than in `useState` + `useEffect` means no
hydration flash and no re-render — the same reason `AppHeader` renders both navs
and lets CSS choose, rather than checking the viewport in JS. A tap that lands
before hydration falls through to today's behaviour, which is no worse than the
current state.

The iframe `src` is set **when the overlay opens**, not at render. Rendering it
eagerly would make every receipt page load trigger a server-side `pdf-lib`
render of the whole DA 2062.

### 2. The overlay

A `[popover]` following the trap documented in `.claude/rules/ui-styling.md`:
the element carrying `popover` gets **no class and no `display`**, all layout
lives on an inner `.pdf-preview__panel`.

`popover="auto"`, for Escape and focus return to the invoker.

`useDismissSwallowsTap` is deliberately **not** used. It exists to swallow the
click a light dismiss delivers to whatever sits underneath, and a
viewport-filling popover has no reachable outside for a dismissing tap to land
on.

### 3. `globals.css` — a new id, deliberately not in the shared group

Styled by id (`#pdf-preview`) like the existing three, so no shared class can
later grow a `display`.

It must **not** join the `#items-sortfilter, #queue-sortfilter,
#items-bulkactions` rule groups. Those are bottom sheets (`inset: auto 0 0 0`,
`width: 100%`); this is a full-viewport surface (`inset: 0`). It gets its own
base rule and its own `::backdrop`, and nothing inside the anchored `@supports`
block — it is not anchored to a trigger.

### 4. Overlay contents

A bar across the top holding **← Back**, the receipt number, and **Download
PDF**; an `<iframe>` filling the remainder.

* Back is `popovertarget` + `popovertargetaction="hide"` — no handler, no state.
* The bar needs `env(safe-area-inset-top)` padding. A standalone window has no
  browser chrome, so without it the bar sits under the status bar and notch.
* Controls honour the documented 44px `--tap` floor.
* No z-index work is needed against the bottom nav rail (z-index 40) — a popover
  renders in the top layer.

**No "Open full PDF" link.** In standalone that navigates the window to the PDF
and re-creates precisely the dead end this change exists to fix. Download is the
escape hatch, and on iOS it raises the system download UI without navigating.

## Testing

**What jsdom can pin** (`*.test.tsx`, `npm run test:ui`, jsdom opted in per file
via the line-1 docblock):

* the popover element carries no `class` — the same invariant
  `ItemSelectTable.test.tsx`, `ServiceQueueTable.test.tsx` and
  `BulkActionsMenu.test.tsx` each pin;
* the anchor still renders its `href` and `target="_blank"`;
* the click is left alone when the standalone check fails.

**What jsdom cannot see.** It implements no Popover API — `showPopover` is
undefined and `:popover-open` never matches — so opening, dismissal and focus
behaviour are not testable there. Neither `npm run build` nor jsdom has a layout
engine or a PDF viewer.

**Device verification is required, not optional.** WKWebView has a long history
of rendering only the first page of an iframed PDF, without scrolling, and this
receipt is two pages (the DA 2062 form plus the custody record page added at
`hand-receipt.ts:241`). Verify on a real iPhone home-screen install over the
cloudflared tunnel.

**If the iframe proves inadequate on iOS**, the surrounding design holds and only
the iframe body changes — rendering pages to canvas with `pdfjs-dist`. That adds
a dependency, a worker asset and real bundle weight, so it is a decision to
confirm before taking, not a fallback to apply silently.

## Documentation, in the same commit

* `CHANGELOG.md` — a user-facing `Fixed` entry under `## 2026-08-12`.
* `.claude/rules/ui-styling.md` — the popover section states that a new caller
  must add its id to all four rule groups. This one deliberately does not.
  Unwritten, that reads as exactly the mistake the rule exists to prevent.

No `docs/SECURITY.md` change: no authz check, route, token, cookie or public
surface moves. The overlay renders a PDF the same viewer could already reach at
the same URL under the same gate.

## Out of scope

* The item QR and bulk QR-sheet PDFs (listed under Scope above).
* Any change to browser-tab behaviour.
* Any change to how the PDF itself is generated.
