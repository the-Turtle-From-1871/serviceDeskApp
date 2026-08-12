# PDF preview back-navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a way back from an inline PDF when the app runs as an installed home-screen app, across the receipt preview and both QR surfaces.

**Architecture:** A full-screen `[popover]` overlay holding an `<iframe>` of the existing PDF URL, opened only when the click happens in a standalone install. No new route, so `src/proxy.ts`, the PIN gate and the receipt-link token grant are all untouched. The overlay's action bar differs per surface: the receipt gets Back + Download, the QR surfaces additionally get "Open in viewer" because their entire purpose is the native viewer's Share → Print.

**Tech Stack:** Next.js 16 App Router, React 19 client components, the native Popover API, Vitest + jsdom (`*.test.tsx`, opted in per file), plain `globals.css` (the legacy design system — **not** Tailwind).

**Spec:** `docs/superpowers/specs/2026-08-12-pdf-preview-back-design.md`

## Global Constraints

- **The element carrying `popover` must have NO `class` and no author `display`.** The UA hides a closed popover with `[popover]:not(:popover-open) { display: none }`, and any author `display` beats it — the overlay would then render permanently over the page. All layout goes on an inner wrapper. Pinned by a test in every popover component in this repo.
- **Popovers are styled BY ID in `globals.css`**, never by a shared class, so no class can later grow a `display`.
- **`#pdf-preview` must NOT be added to the `#items-sortfilter, #queue-sortfilter, #items-bulkactions` rule groups.** Those are bottom sheets (`inset: auto 0 0 0`); this is a full-viewport surface (`inset: 0`). It is not anchored to a trigger, so it adds nothing to the anchored `@supports` block either.
- **This is the `globals.css` world, not Tailwind.** Use `.btn`, `.btn-secondary`, `var(--surface)`, `var(--border-strong)`, `var(--tap)`. Do not add Tailwind classes.
- **`--muted` is a surface tint, never a text colour.** Muted text is `var(--text-muted)`.
- **A single-side border needs the other three zeroed** — write `border: none; border-bottom: 1px solid var(--border-strong);` (preflight is absent, so an unset side keeps the CSS initial width `medium` = 3px).
- **44px minimum tap target** — `var(--tap, 44px)`.
- **jsdom implements no Popover API.** `showPopover`/`hidePopover` are undefined and `:popover-open` never matches, while the UA `display: none` IS applied. So every code path calling `showPopover` must guard on its existence, and role queries into the panel need `{ hidden: true }`.
- **jsdom has no `window.matchMedia`.** Call it optionally (`window.matchMedia?.(…)`) and stub it in tests.
- **Docs ship in the same commit as the behaviour they describe** — never as a trailing task. `CHANGELOG.md` entries go under `## 2026-08-12`, newest section at the top, grouped Added / Changed / Fixed / Removed / Security.
- **No `docs/SECURITY.md` change is needed or wanted.** No authz check, route, token, cookie or public surface moves.
- **Commit style:** conventional commits, and every commit message ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Branch:** `feat/pdf-preview-back`, already cut from `origin/main`.

## File Structure

**Create:**
- `src/lib/standalone.ts` — one exported predicate, `isStandaloneDisplay()`. Client-only.
- `src/lib/standalone.test.ts`
- `src/components/pdf-preview-url.ts` — one pure function, `downloadHref()`. No DOM, so it unit-tests without jsdom (same split as `swipe-row.ts`).
- `src/components/pdf-preview-url.test.ts`
- `src/components/PdfPreviewOverlay.tsx` — the popover, its bar and the iframe.
- `src/components/PdfPreviewOverlay.test.tsx`
- `src/components/PdfPreviewButton.tsx` — anchor + overlay, for the three anchor call sites.
- `src/components/PdfPreviewButton.test.tsx`

**Modify:**
- `src/app/globals.css` — a new `#pdf-preview` rule block after the existing popover block (which ends at the `.popup-menu__footer > .btn` rule, before `@media (min-width: 721px)`).
- `.claude/rules/ui-styling.md` — record why this popover is not in the shared groups, and why the QR surfaces keep a route to the native viewer.
- `src/app/receipts/[receiptNumber]/page.tsx:105`
- `src/app/receipts/new/ReceiptBuilderForm.tsx:604`
- `src/app/i/[itemId]/page.tsx:293`
- `src/components/ItemSelectTable.tsx:518` (and its JSX, to mount the overlay)
- `CHANGELOG.md`

---

### Task 1: `isStandaloneDisplay()`

**Files:**
- Create: `src/lib/standalone.ts`
- Test: `src/lib/standalone.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isStandaloneDisplay(): boolean` — Tasks 3 and 6 import it from `@/lib/standalone`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/standalone.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { isStandaloneDisplay } from "./standalone";

/**
 * jsdom implements NO `window.matchMedia` — it is undefined unless stubbed —
 * which is exactly why the implementation calls it optionally. A test that
 * forgets to stub it is therefore testing the real "browser tab" answer.
 */
const stubMatchMedia = (matches: boolean) =>
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches })));

const stubLegacyIos = (value: boolean | undefined) =>
  Object.defineProperty(window.navigator, "standalone", { value, configurable: true });

afterEach(() => {
  vi.unstubAllGlobals();
  stubLegacyIos(undefined);
});

test("a plain browser tab is not standalone", () => {
  stubMatchMedia(false);
  expect(isStandaloneDisplay()).toBe(false);
});

test("no matchMedia at all is not standalone, rather than a throw", () => {
  // jsdom's own default. Also the shape of an ancient browser.
  expect(isStandaloneDisplay()).toBe(false);
});

test("the display-mode media query is enough", () => {
  stubMatchMedia(true);
  expect(isStandaloneDisplay()).toBe(true);
});

/**
 * The case this whole feature exists for. Older iPhones answer ONLY the legacy
 * property, so dropping this half would leave the home-screen install — the
 * one place with no back button — taking the browser path.
 */
test("legacy navigator.standalone alone is enough", () => {
  stubMatchMedia(false);
  stubLegacyIos(true);
  expect(isStandaloneDisplay()).toBe(true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/standalone.test.ts`
Expected: FAIL — cannot resolve `./standalone`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/standalone.ts`:

```ts
/**
 * Is this page running as an INSTALLED app rather than in a browser tab?
 *
 * CLIENT-ONLY. It reads `window`, so call it from an event handler — never at
 * render and never on the server. It returns false rather than throwing when
 * there is no `window`, so an accidental server call fails safe (to the
 * browser behaviour) instead of crashing a page.
 *
 * BOTH halves are required, and neither is redundant:
 *   • `display-mode: standalone` is the standard, and is what Android and
 *     desktop installs answer to.
 *   • `navigator.standalone` is a legacy, iOS-only property. Older iPhones
 *     answer ONLY that one — and the iPhone home-screen install is the case
 *     this function exists for, so it is not an optional extra.
 *
 * `matchMedia` is called optionally because jsdom does not implement it, so an
 * unstubbed component test would otherwise throw here rather than exercising
 * the browser path it means to.
 *
 * This is NOT one of the three proxy-safe files in this directory
 * (`rate-limit.ts`, `public-access-cookie.ts`, `session-freshness.ts`) and has
 * nothing to do with that rule — `src/proxy.ts` does not import it.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/standalone.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/standalone.ts src/lib/standalone.test.ts
git commit -F - <<'EOF'
feat(lib): detect an installed standalone display

Both halves are needed: the display-mode media query covers Android and
desktop installs, navigator.standalone is legacy iOS-only and is the only
signal older iPhones give.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `downloadHref()` — the pure URL rule

**Files:**
- Create: `src/components/pdf-preview-url.ts`
- Test: `src/components/pdf-preview-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function downloadHref(src: string): string` — Task 3 imports it from `./pdf-preview-url`.

Context the implementer needs: two of the three PDF routes switch on a `preview` query param (`receipts/[receiptNumber]/pdf/route.ts:11` and `admin/items/qr-sheet/pdf/route.ts:23` both do `searchParams.has("preview")` → `inline`, else `attachment`). The third, `i/[itemId]/qr/pdf/route.ts:26`, is `inline` unconditionally and has no such param — that one is covered by the `download` attribute on the anchor in Task 3, not by this function.

- [ ] **Step 1: Write the failing test**

Create `src/components/pdf-preview-url.test.ts`:

```ts
import { expect, test } from "vitest";
import { downloadHref } from "./pdf-preview-url";

test("drops the preview flag, which is what flips the route to attachment", () => {
  expect(downloadHref("/receipts/HR-000001/pdf?preview=1")).toBe("/receipts/HR-000001/pdf");
});

test("keeps every other parameter, and their order", () => {
  expect(downloadHref("/admin/items/qr-sheet/pdf?items=a,b,c&preview=1"))
    .toBe("/admin/items/qr-sheet/pdf?items=a%2Cb%2Cc");
});

test("a URL with no preview flag is unchanged", () => {
  expect(downloadHref("/i/abc123/qr/pdf")).toBe("/i/abc123/qr/pdf");
});

// Only the exact `preview` key goes. A prefix match would be a silent bug: the
// route reads `searchParams.has("preview")`, so dropping a merely similar param
// would change a request nobody asked to change.
test("removes only the exact preview key", () => {
  expect(downloadHref("/receipts/HR-000001/pdf?previewMode=wide&preview=1"))
    .toBe("/receipts/HR-000001/pdf?previewMode=wide");
});
```

Note the expected `items=a%2Cb%2Cc`: `URLSearchParams` re-encodes commas on serialisation. That is harmless — `route.ts:16` reads the param with `url.searchParams.get("items")`, which decodes it back — but the test states it so nobody "fixes" the encoding later thinking it is a bug.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/components/pdf-preview-url.test.ts`
Expected: FAIL — cannot resolve `./pdf-preview-url`.

- [ ] **Step 3: Write the implementation**

Create `src/components/pdf-preview-url.ts`:

```ts
/**
 * The same PDF URL, asking for a DOWNLOAD rather than an inline render.
 *
 * Two of the three PDF routes switch on a `preview` query param — the receipt
 * PDF and the bulk QR sheet both answer `Content-Disposition: inline` when it
 * is present and `attachment` when it is not — so dropping it is the whole
 * rule. The item QR route (`/i/<id>/qr/pdf`) is inline unconditionally and has
 * no such param; the `download` attribute on the anchor covers that one, which
 * is why this function does not need a special case for it.
 *
 * PURE — parsed against a throwaway base rather than `window.location`, so it
 * never touches the DOM, is safe during a server render, and unit-tests without
 * jsdom. Only the path and query are returned; the base never escapes.
 */
export function downloadHref(src: string): string {
  const url = new URL(src, "http://pdf.invalid");
  url.searchParams.delete("preview");
  return `${url.pathname}${url.search}`;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/pdf-preview-url.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/pdf-preview-url.ts src/components/pdf-preview-url.test.ts
git commit -F - <<'EOF'
feat(components): the download form of a PDF preview URL

Dropping the `preview` param is what flips the receipt and QR-sheet routes
from inline to attachment. Kept pure and parsed against a throwaway base, so
it needs no DOM and tests without jsdom.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: The overlay component and its CSS

**Files:**
- Create: `src/components/PdfPreviewOverlay.tsx`
- Create: `src/components/PdfPreviewOverlay.test.tsx`
- Modify: `src/app/globals.css` (insert after the `.popup-menu__footer > .btn` rule, immediately before `@media (min-width: 721px)`)
- Modify: `.claude/rules/ui-styling.md`

**Interfaces:**
- Consumes: `downloadHref` from `./pdf-preview-url` (Task 2).
- Produces:
  - `export const PDF_PREVIEW_ID = "pdf-preview"`
  - `export function PdfPreviewOverlay(props: { src: string | null; title: string; offerNativeViewer?: boolean; onClose: () => void })`

  Tasks 4 and 6 render `<PdfPreviewOverlay>` directly; Task 3's own `PdfPreviewButton` (Task 4) wraps it.

- [ ] **Step 1: Write the failing test**

Create `src/components/PdfPreviewOverlay.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PdfPreviewOverlay } from "./PdfPreviewOverlay";

/**
 * READ THIS BEFORE ADDING A TEST HERE. jsdom implements no Popover API —
 * `showPopover` is undefined and `:popover-open` never matches — while it DOES
 * apply the UA's `[popover]:not(:popover-open) { display: none }`. So the panel
 * is permanently hidden here: role queries into it need `hidden: true`, and
 * nothing below is evidence that the overlay opens, that Escape closes it, that
 * the bar clears the safe-area inset, or that WKWebView renders the PDF. All of
 * that is browser-only — and the iframe's PDF fidelity is iPhone-only.
 */

// This suite runs without vitest `globals: true`, so @testing-library/react's
// auto-cleanup never registers. Mirrors ItemSelectTable.test.tsx.
afterEach(cleanup);

const hidden = { hidden: true } as const;

test("the popover element carries NO class — a layout class would render it while closed", () => {
  const { container } = render(
    <PdfPreviewOverlay src={null} title="HR-000001" onClose={vi.fn()} />,
  );
  const popover = container.querySelector("[popover]");
  expect(popover).not.toBeNull();
  expect(popover!.getAttribute("popover")).toBe("auto");
  expect(popover!.getAttribute("class")).toBeNull();
  // The layout lives on an inner wrapper instead.
  expect(popover!.querySelector(":scope > .pdf-preview__panel")).not.toBeNull();
});

/**
 * The iframe must not exist until the overlay opens. Rendering it eagerly would
 * make every receipt page load run a server-side pdf-lib render of the whole DA
 * 2062, and every /items load build a QR sheet.
 */
test("renders no iframe while closed", () => {
  const { container } = render(
    <PdfPreviewOverlay src={null} title="HR-000001" onClose={vi.fn()} />,
  );
  expect(container.querySelector("iframe")).toBeNull();
});

test("renders the iframe once a src is supplied", () => {
  const { container } = render(
    <PdfPreviewOverlay src="/receipts/HR-000001/pdf?preview=1" title="HR-000001" onClose={vi.fn()} />,
  );
  const frame = container.querySelector("iframe");
  expect(frame).not.toBeNull();
  expect(frame!.getAttribute("src")).toBe("/receipts/HR-000001/pdf?preview=1");
});

test("Back hides the popover by id, with no handler of its own", () => {
  render(<PdfPreviewOverlay src={null} title="HR-000001" onClose={vi.fn()} />);
  const back = screen.getByRole("button", { name: /Back/, ...hidden });
  expect(back.getAttribute("popovertarget")).toBe("pdf-preview");
  expect(back.getAttribute("popovertargetaction")).toBe("hide");
  // A bare <button> defaults to type="submit"; this one must never submit.
  expect(back.getAttribute("type")).toBe("button");
});

test("Download points at the attachment form of the same URL", () => {
  render(
    <PdfPreviewOverlay src="/receipts/HR-000001/pdf?preview=1" title="HR-000001" onClose={vi.fn()} />,
  );
  const link = screen.getByRole("link", { name: /Download/, ...hidden });
  expect(link.getAttribute("href")).toBe("/receipts/HR-000001/pdf");
  // Belt and braces for /i/<id>/qr/pdf, which is inline unconditionally and has
  // no preview param to drop.
  expect(link.hasAttribute("download")).toBe(true);
});

/**
 * THE PER-SURFACE SPLIT. Both QR routes serve a PDF *because* iOS ignores
 * window.print() — the native viewer's Share -> Print is their whole purpose —
 * so they keep a route to it. The receipt preview deliberately does NOT: there,
 * navigating the standalone window to the PDF re-creates the exact dead end
 * this component exists to fix, and the receipt page already offers Download.
 */
test("the receipt preview offers no route to the native viewer", () => {
  render(
    <PdfPreviewOverlay src="/receipts/HR-000001/pdf?preview=1" title="HR-000001" onClose={vi.fn()} />,
  );
  expect(screen.queryByRole("link", { name: /Open in viewer/, ...hidden })).toBeNull();
});

test("a QR surface does, pointing at the inline URL", () => {
  render(
    <PdfPreviewOverlay
      src="/i/abc123/qr/pdf"
      title="QR label"
      offerNativeViewer
      onClose={vi.fn()}
    />,
  );
  const link = screen.getByRole("link", { name: /Open in viewer/, ...hidden });
  expect(link.getAttribute("href")).toBe("/i/abc123/qr/pdf");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/components/PdfPreviewOverlay.test.tsx`
Expected: FAIL — cannot resolve `./PdfPreviewOverlay`.

- [ ] **Step 3: Write the component**

Create `src/components/PdfPreviewOverlay.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { downloadHref } from "./pdf-preview-url";

/**
 * A full-screen in-app PDF viewer, for the INSTALLED app only.
 *
 * ── The problem it solves ──────────────────────────────────────────────────
 * Every PDF this app previews is served `Content-Disposition: inline`, so the
 * browser navigates to a raw application/pdf response. iOS collapses
 * `target="_blank"` into the same browsing context for a standalone install,
 * and a standalone window has no tab strip, no address bar and no back button —
 * so the user was stranded on the PDF with nothing to press.
 *
 * Deliberately NOT a route. A `/receipts/<n>/preview` page would fall outside
 * `RECEIPT_PATH` in `src/proxy.ts`, outside the PIN gate's membership test and
 * outside the receipt-link token's grant — three security-sensitive files for a
 * navigation affordance. An overlay introduces no URL, so the iframe reuses the
 * gate the PDF already passes (session cookie, PIN unlock cookie, or the
 * receipt grant cookie the proxy sets when it verifies an emailed link).
 *
 * ── The trap this is built around ──────────────────────────────────────────
 * The UA hides a closed popover with `[popover]:not(:popover-open) { display:
 * none }`, and ANY author `display` rule beats it. So the element carrying
 * `popover` carries NO class — everything lives on `.pdf-preview__panel`, one
 * level in. Same split as SortFilterMenu, BulkActionsMenu and DeleteItemButton.
 *
 * ── Why "Open in viewer" is conditional ────────────────────────────────────
 * Both QR routes serve a PDF *because* iOS/WKWebView ignores `window.print()`;
 * the native full-screen viewer's Share -> Print is the only way to print a
 * label from a phone, and an <iframe> has no such affordance. So the QR
 * surfaces keep a route to it. The receipt preview does not: there, navigating
 * the standalone window to the PDF re-creates precisely the dead end above, and
 * that page already offers Download separately.
 */

/** One overlay per page, so a fixed id rather than `useId` — it has to be an
 *  exact `popovertarget` reference AND an exact CSS selector, and useId's
 *  generated ids carry delimiters that are awkward in a selector. A page
 *  needing a SECOND PDF overlay would need its own id and its own rules; there
 *  is deliberately no class to inherit them from. */
export const PDF_PREVIEW_ID = "pdf-preview";

export function PdfPreviewOverlay({
  src,
  title,
  offerNativeViewer = false,
  onClose,
}: {
  /** The PDF to show, or null while closed. Set when the overlay OPENS, never
   *  at render — an eagerly rendered iframe would make every page load run a
   *  server-side pdf-lib render. */
  src: string | null;
  title: string;
  /** Offer "Open in viewer", which NAVIGATES to the PDF. True for the QR
   *  surfaces only — see the note above. */
  offerNativeViewer?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Drive the popover from `src`, so the caller owns ONE piece of state rather
  // than two that can disagree about whether the overlay is open.
  useEffect(() => {
    const el = ref.current;
    // jsdom implements no Popover API at all, so this guard is what keeps every
    // component test that renders this from throwing.
    if (!el || typeof el.showPopover !== "function") return;
    const open = el.matches(":popover-open");
    if (src && !open) el.showPopover();
    else if (!src && open) el.hidePopover();
  }, [src]);

  // The platform can close an `auto` popover without us — Escape, or the Back
  // button's own popovertargetaction — so the caller's state has to FOLLOW the
  // element rather than lead it. Without this, closing with Back would leave
  // `src` set, and re-opening the same PDF would set an unchanged value and do
  // nothing at all.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onToggle = (e: Event) => {
      if ((e as Event & { newState?: string }).newState === "closed") onClose();
    };
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, [onClose]);

  return (
    // NO className on this element. See the trap note above.
    <div id={PDF_PREVIEW_ID} popover="auto" ref={ref}>
      <div className="pdf-preview__panel">
        <div className="pdf-preview__bar">
          {/* popovertargetaction means this costs no handler and no state; the
              `toggle` listener above is what feeds the close back to the caller. */}
          <button
            type="button"
            className="btn btn-secondary"
            popoverTarget={PDF_PREVIEW_ID}
            popoverTargetAction="hide"
          >
            ← Back
          </button>
          <span className="pdf-preview__title truncate-inline">{title}</span>
          {src && (
            <>
              {offerNativeViewer && (
                <a className="btn btn-secondary" href={src} target="_blank" rel="noopener">
                  Open in viewer
                </a>
              )}
              {/* `download` as well as the stripped param: /i/<id>/qr/pdf is
                  inline unconditionally and has no param to strip. */}
              <a className="btn btn-secondary" href={downloadHref(src)} download>
                Download
              </a>
            </>
          )}
        </div>
        {src && <iframe className="pdf-preview__frame" src={src} title={title} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/PdfPreviewOverlay.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the CSS**

In `src/app/globals.css`, insert this **after** the `.popup-menu__footer > .btn { … }` rule and **before** `@media (min-width: 721px) {`:

```css
/* The PDF preview overlay's [popover] element. NO class, no `display` — the
   same UA trap as the menus above.
   Styled by its own id, and DELIBERATELY NOT added to the three groups above:
   those are bottom sheets (`inset: auto 0 0 0`), and this is a full-viewport
   surface. It is not anchored to a trigger either, so it contributes nothing to
   the anchored @supports block — there is no fourth group to add it to. */
#pdf-preview {
  /* Undo the UA popover box, as above. */
  margin: 0;
  border: none;
  padding: 0;
  background: transparent;
  overflow: visible;
  /* Full viewport, unlike the sheets. `max-*: none` because the UA caps a
     popover at 100%/100% minus its own margin box. */
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
}
#pdf-preview::backdrop {
  /* Darker than the menus' 0.4: this one is modal and covers the viewport, so
     nothing behind it is meant to read as reachable. */
  background: rgb(25 28 24 / 0.6);
}
.pdf-preview__panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
  /* The install has no browser chrome beneath it, same as .nav-rail. */
  padding-bottom: env(safe-area-inset-bottom);
}
/* Sits above the iframe, and must clear the status bar and notch — a standalone
   window has no browser chrome, so without the top inset this bar renders
   underneath them. */
.pdf-preview__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px;
  padding-top: max(8px, env(safe-area-inset-top));
  /* A single-side border needs the other three zeroed: preflight is absent, so
     an unset side keeps the CSS initial width `medium` (3px) and paints. */
  border: none;
  border-bottom: 1px solid var(--border-strong);
  background: var(--surface);
}
.pdf-preview__bar > .btn {
  /* The documented touch floor. */
  min-height: var(--tap, 44px);
  flex: none;
}
.pdf-preview__title {
  /* Takes the slack so the buttons keep their intrinsic width; min-width: 0 is
     what actually lets a flex item shrink enough for truncate-inline to bite. */
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 700;
}
.pdf-preview__frame {
  /* Fills whatever the bar leaves. `min-height: 0` again: without it the
     iframe's default height wins and pushes the bar off the top of the screen. */
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  border: none;
  background: var(--surface);
}
```

- [ ] **Step 6: Document the two deviations**

In `.claude/rules/ui-styling.md`, in the `[popover]` bullet — right after the sentence ending "*there is no class for it to inherit them from*" — add:

```markdown
  - **`#pdf-preview` is the ONE popover deliberately outside those groups, and that is not an oversight.** `PdfPreviewOverlay` is a full-viewport surface (`inset: 0`), not a bottom sheet (`inset: auto 0 0 0`), and it is not anchored to a trigger — so it has nothing to add to the anchored `@supports` block and would be actively wrong in the base group. It carries its own `#pdf-preview` + `::backdrop` rules and follows every other rule here: no class on the `[popover]` element, layout on `.pdf-preview__panel`, and `PdfPreviewOverlay.test.tsx` pins the no-class invariant like the other three. Its bar needs `env(safe-area-inset-top)` — the install has no browser chrome, so without it the Back button renders under the status bar and notch.
  - **The overlay's action bar differs per surface ON PURPOSE — do not "simplify" the two into one.** The receipt preview offers Back + Download. Both QR surfaces additionally offer **Open in viewer**, which navigates to the PDF, because `/i/<id>/qr/pdf` and `/admin/items/qr-sheet/pdf` serve a PDF *precisely* because iOS ignores `window.print()`: the native viewer's Share → Print is the only way to print a label from a phone, and an `<iframe>` has no such affordance. Removing that action to make the surfaces uniform would buy consistency by deleting the feature. Conversely, adding it to the receipt would re-create the dead end the overlay exists to fix.
```

- [ ] **Step 7: Verify nothing else broke**

Run: `npm run lint` — expected: clean.
Run: `npm run build` — expected: success.

Note what these do **not** prove: neither has a layout engine, so neither is evidence for any of the CSS above. That is Task 7.

- [ ] **Step 8: Commit**

```bash
git add src/components/PdfPreviewOverlay.tsx src/components/PdfPreviewOverlay.test.tsx \
        src/app/globals.css .claude/rules/ui-styling.md
git commit -F - <<'EOF'
feat(components): a full-screen in-app PDF overlay

A [popover] holding an iframe of the PDF the page would otherwise navigate
to, with a Back button of its own. No new route, so proxy.ts RECEIPT_PATH,
the PIN gate and the receipt-link token grant are untouched and the iframe
reuses the gate the PDF already passes.

Styled by its own id and deliberately NOT added to the three bottom-sheet
popover groups: this is a full-viewport surface and is not anchored to a
trigger. ui-styling.md records that, and records why the QR surfaces keep an
"Open in viewer" action the receipt preview does not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: `PdfPreviewButton`, and the receipt preview call sites

**Files:**
- Create: `src/components/PdfPreviewButton.tsx`
- Create: `src/components/PdfPreviewButton.test.tsx`
- Modify: `src/app/receipts/[receiptNumber]/page.tsx:105`
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx:604`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `isStandaloneDisplay` (Task 1), `PdfPreviewOverlay` (Task 3).
- Produces: `export function PdfPreviewButton(props: { href: string; title: string; label: string; className?: string; rel?: string; offerNativeViewer?: boolean })` — Task 5 uses it for the item Print QR link.

- [ ] **Step 1: Write the failing test**

Create `src/components/PdfPreviewButton.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PdfPreviewButton } from "./PdfPreviewButton";

/**
 * jsdom implements no Popover API, so the overlay never actually opens here —
 * `showPopover` is undefined and the component guards on it. What IS testable
 * is the branch: whether the click is left alone or intercepted, and whether
 * the iframe gets mounted. Opening, focus and dismissal are browser-only.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const hidden = { hidden: true } as const;
const asInstalledApp = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
const asBrowserTab = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));

/**
 * The server-rendered output must be byte-identical to the plain anchor this
 * replaces, so a browser tab keeps today's behaviour exactly and a tap landing
 * before hydration is no worse than it is now.
 */
test("renders the same anchor a browser tab has always had", () => {
  asBrowserTab();
  render(
    <PdfPreviewButton
      href="/receipts/HR-000001/pdf?preview=1"
      title="HR-000001"
      label="Preview PDF"
    />,
  );
  const link = screen.getByRole("link", { name: "Preview PDF" });
  expect(link.getAttribute("href")).toBe("/receipts/HR-000001/pdf?preview=1");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("class")).toBe("btn btn-secondary");
});

test("a browser tab's click is left entirely alone", () => {
  asBrowserTab();
  const { container } = render(
    <PdfPreviewButton href="/receipts/HR-000001/pdf?preview=1" title="HR-000001" label="Preview PDF" />,
  );
  const clicked = fireEvent.click(screen.getByRole("link", { name: "Preview PDF" }));
  // fireEvent returns false when a handler called preventDefault.
  expect(clicked).toBe(true);
  expect(container.querySelector("iframe")).toBeNull();
});

test("the installed app's click is intercepted and shows the PDF in the overlay", () => {
  asInstalledApp();
  const { container } = render(
    <PdfPreviewButton href="/receipts/HR-000001/pdf?preview=1" title="HR-000001" label="Preview PDF" />,
  );
  const clicked = fireEvent.click(screen.getByRole("link", { name: "Preview PDF" }));
  expect(clicked).toBe(false);
  expect(container.querySelector("iframe")!.getAttribute("src"))
    .toBe("/receipts/HR-000001/pdf?preview=1");
});

test("passes the class and rel through unchanged, for the item QR link", () => {
  asBrowserTab();
  render(
    <PdfPreviewButton
      href="/i/abc123/qr/pdf"
      title="QR label"
      label="Print QR"
      className="btn btn-primary no-print"
      rel="noopener"
      offerNativeViewer
    />,
  );
  const link = screen.getByRole("link", { name: "Print QR" });
  expect(link.getAttribute("class")).toBe("btn btn-primary no-print");
  expect(link.getAttribute("rel")).toBe("noopener");
});

test("only a QR surface offers the native viewer once open", () => {
  asInstalledApp();
  render(
    <PdfPreviewButton
      href="/i/abc123/qr/pdf" title="QR label" label="Print QR" offerNativeViewer
    />,
  );
  fireEvent.click(screen.getByRole("link", { name: "Print QR" }));
  expect(screen.getByRole("link", { name: /Open in viewer/, ...hidden })).toBeTruthy();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/components/PdfPreviewButton.test.tsx`
Expected: FAIL — cannot resolve `./PdfPreviewButton`.

- [ ] **Step 3: Write the component**

Create `src/components/PdfPreviewButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { isStandaloneDisplay } from "@/lib/standalone";
import { PdfPreviewOverlay } from "./PdfPreviewOverlay";

/**
 * A link to an inline PDF that stays inside the app when the app is INSTALLED.
 *
 * Renders exactly the anchor it replaces — same class, same target, same rel —
 * so a browser tab's behaviour is unchanged and the server output is identical.
 * Only in a standalone install does it swallow its own click and open
 * `PdfPreviewOverlay` instead, because that is the only context with no back
 * button to return with.
 *
 * The standalone check runs at CLICK time rather than in a `useState` +
 * `useEffect` pair. That means no hydration flash and no re-render — the same
 * reasoning as `AppHeader`, which renders both navs and lets CSS choose rather
 * than checking the viewport in JS. The cost is that a tap landing before
 * hydration falls through to the browser path, which is exactly today's
 * behaviour and so cannot be a regression.
 */
export function PdfPreviewButton({
  href,
  title,
  label,
  className = "btn btn-secondary",
  rel = "noopener noreferrer",
  offerNativeViewer = false,
}: {
  href: string;
  /** Shown in the overlay's bar, and used as the iframe's accessible name. */
  title: string;
  label: string;
  className?: string;
  rel?: string;
  /** See PdfPreviewOverlay — true for the QR surfaces only. */
  offerNativeViewer?: boolean;
}) {
  // Null until opened: the overlay renders no iframe without it, so no page
  // load pays for a server-side PDF render it may never show.
  const [src, setSrc] = useState<string | null>(null);

  return (
    <>
      <a
        className={className}
        href={href}
        target="_blank"
        rel={rel}
        onClick={(e) => {
          if (!isStandaloneDisplay()) return;
          e.preventDefault();
          setSrc(href);
        }}
      >
        {label}
      </a>
      <PdfPreviewOverlay
        src={src}
        title={title}
        offerNativeViewer={offerNativeViewer}
        onClose={() => setSrc(null)}
      />
    </>
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/components/PdfPreviewButton.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the receipt page**

In `src/app/receipts/[receiptNumber]/page.tsx`, add the import alongside the other component imports:

```tsx
import { PdfPreviewButton } from "@/components/PdfPreviewButton";
```

Replace line 105:

```tsx
          <a className="btn btn-secondary" href={`/receipts/${t.receiptNumber}/pdf?preview=1`} target="_blank" rel="noopener noreferrer">Preview PDF</a>
```

with:

```tsx
          <PdfPreviewButton
            href={`/receipts/${t.receiptNumber}/pdf?preview=1`}
            title={t.receiptNumber}
            label="Preview PDF"
          />
```

Leave line 106's "Download PDF" anchor exactly as it is — it is already an attachment and never navigates.

- [ ] **Step 6: Wire the receipt builder**

In `src/app/receipts/new/ReceiptBuilderForm.tsx`, add the import:

```tsx
import { PdfPreviewButton } from "@/components/PdfPreviewButton";
```

Replace line 604:

```tsx
          <a className="btn btn-secondary" href={`/receipts/${receipt}/pdf?preview=1`} target="_blank" rel="noopener noreferrer">Preview PDF</a>
```

with:

```tsx
          <PdfPreviewButton
            href={`/receipts/${receipt}/pdf?preview=1`}
            title={receipt}
            label="Preview PDF"
          />
```

- [ ] **Step 7: Add the changelog entry**

At the very top of `CHANGELOG.md`, above the existing newest section, add:

```markdown
## 2026-08-12

### Fixed

- **Previewing a hand receipt's PDF no longer strands you in the installed app.** On an iPhone home-screen install there is no tab strip and no back button, so opening the PDF left no way back to the receipt short of closing the app. The preview now opens inside the app, over the receipt, with its own Back button and a Download link. In an ordinary browser tab nothing changes — the PDF still opens in a new tab with the browser's own controls.
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. Two files exercise the receipt pages (`src/app/receipts/new/page.test.tsx` among them) — if either asserts on the old anchor's markup, update the assertion to the new component rather than reverting the change.

Run: `npm run lint` and `npm run build` — expected: clean, success.

- [ ] **Step 9: Commit**

```bash
git add src/components/PdfPreviewButton.tsx src/components/PdfPreviewButton.test.tsx \
        src/app/receipts/[receiptNumber]/page.tsx \
        src/app/receipts/new/ReceiptBuilderForm.tsx CHANGELOG.md
git commit -F - <<'EOF'
fix(receipts): give the PDF preview a way back in the installed app

An iPhone home-screen install has no tab strip and no back button, and iOS
collapses target="_blank" into the standalone window - so previewing a
receipt's PDF stranded the user until they killed the app.

The preview now opens in an in-app overlay with its own Back button. A
browser tab is untouched: the anchor, its target and its rel are identical,
and the standalone check runs at click time so there is no hydration flash.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: The two QR surfaces

**Files:**
- Modify: `src/app/i/[itemId]/page.tsx:293`
- Modify: `src/components/ItemSelectTable.tsx:518` and its JSX
- Modify: `src/components/ItemSelectTable.test.tsx` (add one test)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `PdfPreviewButton` (Task 4), `PdfPreviewOverlay` + `isStandaloneDisplay` (Tasks 3 and 1).
- Produces: nothing new.

- [ ] **Step 1: Wire the item page's Print QR link**

In `src/app/i/[itemId]/page.tsx`, add the import:

```tsx
import { PdfPreviewButton } from "@/components/PdfPreviewButton";
```

Replace lines 293-295:

```tsx
            <a className="btn btn-primary no-print" href={`/i/${item.id}/qr/pdf`} target="_blank" rel="noopener">
              Print QR
            </a>
```

with:

```tsx
            {/* offerNativeViewer, unlike the receipt preview: this PDF exists
                *because* iOS ignores window.print(), so the native viewer's
                Share -> Print is the whole point and the overlay has to keep a
                route to it. */}
            <PdfPreviewButton
              href={`/i/${item.id}/qr/pdf`}
              title={`QR label · ${item.serialNumber}`}
              label="Print QR"
              className="btn btn-primary no-print"
              rel="noopener"
              offerNativeViewer
            />
```

Leave the comment above it (lines 289-292) in place — it still explains why this is a PDF at all.

- [ ] **Step 2: Write the failing test for the bulk QR sheet**

`printQr` is the one non-anchor call site — a handler on a plain selection-bar button (`ItemSelectTable.tsx:649`), **not** inside the `BulkActionsMenu` popover, so there is no nested-popover question.

Append this `describe` block to `src/components/ItemSelectTable.test.tsx`. Note the conventions already in that file: it uses `it` rather than `test`, every render goes through the module-level `renderTable` helper (which wraps the table in `ItemSelectionProvider`, because selection lives there and not in the table's own state), `ROW`/`RETIRED` are module-level fixtures, and each `describe` defines its own local `renderRows`.

```tsx
/**
 * The bulk QR sheet is the one PDF surface reached by a HANDLER rather than an
 * anchor, so it cannot use PdfPreviewButton and carries the standalone branch
 * itself. jsdom implements no Popover API, so the overlay never visibly opens
 * here — what is pinned is the branch and the mounted iframe.
 */
describe("ItemSelectTable — the bulk QR sheet in an installed app", () => {
  afterEach(() => vi.unstubAllGlobals());

  function renderRows() {
    return renderTable(
      <ItemSelectTable
        items={[ROW, RETIRED]}
        isAdmin
        q=""
        sort={null}
        dir="asc"
        page={1}
        totalPages={1}
        sortKeys={[]}
        uic="" needsRename={false}
        loaner={false}
        showUnnamed={false}
        unnamedHidden={true}
        uics={[]}
        categories={[]}
      />,
    );
  }

  // Select one row and press the toolbar's Print QR button, the way the
  // existing card-structure suite does it.
  const selectAndPrint = (container: HTMLElement) => {
    const box = container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
    act(() => { fireEvent.click(box); });
    const btn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent!.trim().startsWith("Print QR"),
    )!;
    act(() => { fireEvent.click(btn); });
  };

  it("still opens a new window in an ordinary browser tab", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const open = vi.fn();
    vi.stubGlobal("open", open);

    const { container } = renderRows();
    selectAndPrint(container);

    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toContain("/admin/items/qr-sheet/pdf?items=");
    expect(container.querySelector("iframe")).toBeNull();
  });

  /**
   * In an INSTALLED app `window.open` collapses into the standalone window,
   * which has no tab strip and no back button — so the sheet would take the app
   * over with no way out. It has to render in the overlay instead.
   */
  it("shows the sheet in the in-app overlay instead", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const open = vi.fn();
    vi.stubGlobal("open", open);

    const { container } = renderRows();
    selectAndPrint(container);

    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")!.getAttribute("src"))
      .toContain("/admin/items/qr-sheet/pdf?items=");
  });
});
```

`window.open` is replaced with `vi.stubGlobal` rather than `vi.spyOn`, so the file-level `afterEach(() => vi.unstubAllGlobals())` above restores both it and `matchMedia` together — jsdom's `window.open` is a real function, and a `spyOn` left unrestored would leak into the suites that follow.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run src/components/ItemSelectTable.test.tsx`
Expected: FAIL — the standalone test finds no iframe (`window.open` is still called unconditionally).

- [ ] **Step 4: Wire `ItemSelectTable`**

Add the imports:

```tsx
import { isStandaloneDisplay } from "@/lib/standalone";
import { PdfPreviewOverlay } from "@/components/PdfPreviewOverlay";
```

Add the state beside the component's other `useState` calls:

```tsx
  // The bulk QR sheet, while the in-app overlay is showing it. Null otherwise.
  const [qrSheetSrc, setQrSheetSrc] = useState<string | null>(null);
```

Replace line 518:

```tsx
  const printQr = () => { if (selected.size) window.open(`/admin/items/qr-sheet/pdf?items=${selectedKeys()}&preview=1`, "_blank", "noopener"); };
```

with:

```tsx
  // In an INSTALLED app a new window collapses into the standalone one, which
  // has no tab strip and no back button — so the sheet would take the app over
  // with no way back. Show it in the overlay there, and leave a browser tab
  // exactly as it was.
  const printQr = () => {
    if (!selected.size) return;
    const url = `/admin/items/qr-sheet/pdf?items=${selectedKeys()}&preview=1`;
    if (isStandaloneDisplay()) { setQrSheetSrc(url); return; }
    window.open(url, "_blank", "noopener");
  };
```

Mount the overlay as a sibling of the selection bar — immediately after the bar's closing tag, inside the same parent:

```tsx
      {/* offerNativeViewer: a QR sheet exists to be PRINTED, and Share -> Print
          lives in the native viewer, which an iframe has no route to. */}
      <PdfPreviewOverlay
        src={qrSheetSrc}
        title="QR labels"
        offerNativeViewer
        onClose={() => setQrSheetSrc(null)}
      />
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/components/ItemSelectTable.test.tsx`
Expected: PASS, including the two new tests.

- [ ] **Step 6: Extend the changelog entry**

In `CHANGELOG.md`, under the `## 2026-08-12` → `### Fixed` section added in Task 4, add a second bullet:

```markdown
- **Printing QR labels no longer strands you either.** Print QR on an item, and Print QR codes for a selection, both open the label sheet inside the app with a Back button. Both keep an **Open in viewer** link, because the phone's own PDF viewer is where Share → Print lives — that is why these are PDFs rather than a print button in the first place.
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (166+ files). If a test asserts on the old Print QR anchor markup, update it to the new component rather than reverting.

Run: `npm run lint` and `npm run build` — expected: clean, success.

- [ ] **Step 8: Commit**

```bash
git add src/app/i/\[itemId\]/page.tsx src/components/ItemSelectTable.tsx \
        src/components/ItemSelectTable.test.tsx CHANGELOG.md
git commit -F - <<'EOF'
fix(items): give the QR label PDFs a way back in the installed app

Print QR and the bulk QR sheet dead-ended in the standalone install exactly
as the receipt preview did. Both now open in the in-app overlay.

Both keep an "Open in viewer" action the receipt preview deliberately lacks:
these routes serve a PDF precisely because iOS ignores window.print(), so the
native viewer's Share -> Print is their purpose and an iframe has no route to
it. Removing it would buy a back button by deleting the feature.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Device verification

**Files:** none — this task produces evidence, and possibly a follow-up decision.

This is the only step that can tell us whether the feature works. `npm run build` and jsdom have no layout engine, no Popover API and no PDF viewer, so **nothing committed so far is evidence that any of this renders**.

- [ ] **Step 1: Serve the dev server over a tunnel**

Run `npm run dev`, then expose it with `cloudflared` (a secure context is required — see the project's iPhone tunnel notes). Set `AUTH_TRUST_HOST=true` and add the tunnel hostname to `allowedDevOrigins` in the Next config, or sign-in and hydration will fail.

- [ ] **Step 2: Install to the home screen**

Open the tunnel URL in iOS Safari → Share → Add to Home Screen. Launch from the home-screen icon, **not** from Safari — a home-screen app has its own cookie jar and will ask you to sign in again. Confirm there is no address bar; that is what makes this the standalone case.

- [ ] **Step 3: Check the receipt preview**

Open a receipt with **at least two items** (so the DA 2062 form page and the custody record page are both populated). Tap **Preview PDF**.

Confirm, and write down what you see:
- the overlay covers the screen and the bar is fully below the status bar and notch;
- **Back returns to the receipt**, and the receipt is still scrolled where you left it;
- the PDF shows **both pages** and scrolls between them ← *the assumption most likely to fail*;
- Download saves the file;
- there is no "Open in viewer" action here.

- [ ] **Step 4: Check both QR surfaces**

On an item page tap **Print QR**; on `/items` select **enough devices to span more than one sheet page** and tap **Print QR codes**. For each: Back returns, the sheet scrolls through all pages, and **Open in viewer** reaches the native viewer where **Share → Print** works.

- [ ] **Step 5: Check a browser tab is unchanged**

In ordinary iOS Safari (not the installed app), and on a desktop browser, confirm all three still open a new tab with the browser's own back button — i.e. that the standalone branch is not firing.

- [ ] **Step 6: Record the outcome**

**If the iframe renders every page:** the feature is done. Push the branch and open a PR; remember `Tests (vitest)` is **not** a required check, so read that job's status directly rather than trusting the merge button.

**If the iframe renders only the first page** (the documented WKWebView failure): stop and report it rather than improvising. The design holds and only the iframe body changes, but the two fixes differ in cost and the choice is the user's:
- the **QR surfaces** have a cheap out — lead with "Open in viewer" and treat the overlay as a preview-plus-handoff;
- the **receipt preview** would need `pdfjs-dist` canvas rendering, which is a new dependency, a worker asset and real bundle weight. Run `npm view pdfjs-dist` before proposing it (the supply-chain rule), and get explicit agreement before installing.

---

## Notes for whoever executes this

- **Task order matters.** Tasks 1-3 build the pieces, 4-5 wire them, 6 is the only real proof. Do not reorder 6 earlier — there is nothing to look at until Task 4 lands.
- **Do not add `#pdf-preview` to the existing popover rule groups**, however much it looks like it belongs there. The Global Constraints say why.
- **Do not remove "Open in viewer" from the QR surfaces to make them match the receipt.** That reads as a tidy-up and is a feature deletion; `ui-styling.md` now says so.
- **`npm test` runs the whole suite (~64s CI / ~78s locally).** `npx vitest run <pattern>` filters by **filename**, so `npx vitest run integration` matches exactly one file and proves almost nothing.
- If a fresh worktree is used, copy `.env.test` into it or the whole suite aborts before running.
