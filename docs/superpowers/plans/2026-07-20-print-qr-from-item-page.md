# Print QR from the Item View Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a logged-in-only **Print QR** button to the item view page (`/i/[itemId]`) that opens the browser print dialog showing only a self-identifying QR label (QR image + make/model + serial + URL).

**Architecture:** A tiny `"use client"` button component calls `window.print()`. The existing (server-rendered) QR card on the item page gains marker classes, a print-only identifier line, and the gated button. Page-scoped `@media print` CSS hides every direct child of the item page's `<main>` except the QR card, so only the label prints. No new route, no server/authz change.

**Tech Stack:** Next.js 16 (App Router, React 19 Server + Client Components), TypeScript, Vitest + Testing Library (jsdom) for the client-component test, plain CSS (`globals.css`).

## Global Constraints

- **Next.js 16** — the QR card is inside a Server Component page; only the button is a Client Component (`"use client"`). Do not convert the page to a client component.
- **No authz/data change** — the button is pure client-side `window.print()`. Do not add any endpoint, query, or `requireUser`/`requireAdmin` call. The QR image stays publicly visible; only the print *button* is gated on `loggedIn` (already computed at `src/app/i/[itemId]/page.tsx:43`).
- **Print CSS must be page-scoped** via `.qr-print-host` — do NOT use a global `body *` rule, which would blank the existing admin QR print page (`src/app/admin/items/[itemId]/qr/page.tsx`).
- **Docs ship in the same commit as the user-facing code** (CLAUDE.md, non-negotiable): the `CHANGELOG.md` entry lands in Task 2's commit (the commit that makes the feature user-facing).
- **jsdom / `npm run build` are NOT evidence for the print CSS** (no layout engine, no print media). The authoritative check for the print output is a browser print-preview.
- Component tests run via `npm run test:ui` (matches `*.test.tsx`); annotate the test file with `// @vitest-environment jsdom`.

---

### Task 1: `PrintQrButton` client component

**Files:**
- Create: `src/app/i/[itemId]/PrintQrButton.tsx`
- Test: `src/app/i/[itemId]/PrintQrButton.test.tsx`

**Interfaces:**
- Consumes: nothing (no props).
- Produces: `export function PrintQrButton(): JSX.Element` — a `<button type="button" class="btn btn-secondary no-print">Print QR</button>` whose `onClick` calls `window.print()`. Consumed by Task 2 in `page.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/app/i/[itemId]/PrintQrButton.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrintQrButton } from "./PrintQrButton";

afterEach(cleanup);

it("invokes window.print when clicked", async () => {
  // jsdom does not implement window.print; install a spy so the click is observable.
  const printSpy = vi.fn();
  vi.stubGlobal("print", printSpy);

  render(<PrintQrButton />);
  const button = screen.getByRole("button", { name: "Print QR" });
  await userEvent.click(button);

  expect(printSpy).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it("is marked no-print so it does not appear on the printout", () => {
  render(<PrintQrButton />);
  expect(screen.getByRole("button", { name: "Print QR" })).toHaveClass("no-print");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:ui -- src/app/i/[itemId]/PrintQrButton.test.tsx`
Expected: FAIL — cannot resolve `./PrintQrButton` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/app/i/[itemId]/PrintQrButton.tsx`:

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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:ui -- src/app/i/[itemId]/PrintQrButton.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/i/[itemId]/PrintQrButton.tsx" "src/app/i/[itemId]/PrintQrButton.test.tsx"
git commit -m "feat: add PrintQrButton client component for item QR printing"
```

(Not yet rendered anywhere — internal scaffolding, so no CHANGELOG entry on this commit. The feature becomes user-facing in Task 2.)

---

### Task 2: Wire the button + print label into the item page, add print CSS, update CHANGELOG

**Files:**
- Modify: `src/app/i/[itemId]/page.tsx` (import + `<main>` class at line 51; QR card block at lines 173–180)
- Modify: `src/app/globals.css` (the `@media print` block near line 983, plus a screen-default rule)
- Modify: `CHANGELOG.md` (append a bullet under the existing `## 2026-07-20` → `### Added`)

**Interfaces:**
- Consumes: `PrintQrButton` from Task 1 (`./PrintQrButton`); `loggedIn` boolean already in scope at `page.tsx:43`; `item.make`, `item.model`, `item.serialNumber` (already loaded); `itemUrl(item.id)` (already imported at `page.tsx:6`).
- Produces: the finished user-facing feature. No new exported symbols.

- [ ] **Step 1: Import the button in `page.tsx`**

At the top of `src/app/i/[itemId]/page.tsx`, add the import next to the other local imports (e.g. after the `ItemDetailsCard` import at line 16):

```tsx
import { PrintQrButton } from "./PrintQrButton";
```

- [ ] **Step 2: Add the `qr-print-host` marker class to `<main>`**

In `src/app/i/[itemId]/page.tsx`, change the `<main>` opening tag (line 51):

```tsx
      <main className="container container-mid stack">
```

to:

```tsx
      <main className="container container-mid stack qr-print-host">
```

- [ ] **Step 3: Update the QR card block (marker class, print-only label, gated button)**

In `src/app/i/[itemId]/page.tsx`, replace the existing QR card block (lines 173–180):

```tsx
        {qr && (
          <div className="card stack-sm" style={{ textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${item.make} ${item.model}`} width={220} height={220} style={{ margin: "0 auto" }} />
            <p className="subtle">Scan to view this item</p>
            <p className="qr-url">{itemUrl(item.id)}</p>
          </div>
        )}
```

with:

```tsx
        {qr && (
          <div className="card stack-sm qr-print-area" style={{ textAlign: "center" }}>
            {/* Print-only identifier: on screen the page <h1> already names the
                item, so this is hidden (.qr-print-label) and shown only in the
                printout, making the printed label self-identifying. */}
            <p className="qr-print-label">
              <strong>{item.make} {item.model}</strong> — Serial {item.serialNumber}
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${item.make} ${item.model}`} width={220} height={220} style={{ margin: "0 auto" }} />
            <p className="subtle">Scan to view this item</p>
            <p className="qr-url">{itemUrl(item.id)}</p>
            {loggedIn && <PrintQrButton />}
          </div>
        )}
```

- [ ] **Step 4: Add the print CSS in `globals.css`**

In `src/app/globals.css`, add the screen-default rule immediately after the `.qr-url { … }` block (ends at line 981, just before the existing `@media print {`):

```css
/* Print-only identifier line on the item QR card (see @media print below). */
.qr-print-label { display: none; }
```

Then extend the existing `@media print { … }` block (starts line 983) by adding these rules inside it, after the existing `.card, .qr-card img { box-shadow: none; }` rule:

```css
  /* Item view page: print ONLY the QR card. Scoped to .qr-print-host so the
     admin QR print page (which has no .qr-print-host) is unaffected. */
  .qr-print-host > *:not(.qr-print-area) { display: none !important; }
  .qr-print-area { border: none; box-shadow: none; }
  .qr-print-label { display: block; }
```

The Print button prints nothing because it carries `.no-print`, and the existing `@media print { .no-print { display: none !important; } }` rule already hides it.

- [ ] **Step 5: Add the CHANGELOG entry**

In `CHANGELOG.md`, under the existing `## 2026-07-20` → `### Added` subsection (the `### Added` heading is at line 20), append this bullet after the last existing Added bullet (the "CSV import size guard" bullet ending at line 24):

```markdown
- **Print QR from the item page.** The individual item view page (`/i/<id>`) now
  shows a **Print QR** button (logged-in users) that opens the browser print
  dialog with a clean, self-identifying QR label — QR image, make/model, serial,
  and item URL — while the header and all other page sections drop out of the
  printout. The QR itself remains publicly viewable as before; only the print
  button is gated to signed-in users.
```

- [ ] **Step 6: Verify lint and build pass**

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds (compiles the new client component and page).

- [ ] **Step 7: Verify the print output in a real browser**

Use the `verify`/`run` skill to launch the app and, signed in, open `/i/<some-item-id>`. Confirm:
1. A **Print QR** button appears on the QR card (and is absent when logged out).
2. Triggering print (the button, or Ctrl/Cmd-P) shows a print preview containing **only** the QR card: the `Make Model — Serial <SN>` line, the QR image, and the URL — with the site header, the "Create hand receipt" button, and the Details / Service / Audit / Hand-receipts cards all absent.

(Per project convention, this browser print-preview — not jsdom or `npm run build` — is the evidence that the print CSS works.)

- [ ] **Step 8: Commit (code + docs together)**

```bash
git add "src/app/i/[itemId]/page.tsx" src/app/globals.css CHANGELOG.md
git commit -m "feat: print QR label from the item view page"
```

---

## Self-Review

**1. Spec coverage:**
- Mechanism (in-page `window.print()` button) → Task 1 (button) + Task 2 Step 3.
- Visibility (logged-in only; QR stays public) → Task 2 Step 3 (`{loggedIn && <PrintQrButton />}`); Global Constraints.
- Printed content (QR + make/model + serial + URL) → Task 2 Step 3 (print-only label + existing image/URL).
- On-screen identifier print-only (Option A) → Task 2 Steps 3–4 (`.qr-print-label` hidden on screen, shown in print).
- Print isolation scoped, admin page untouched → Task 2 Step 4 (`.qr-print-host > *:not(.qr-print-area)`).
- Authz/data unchanged → Global Constraints; no task touches server code.
- Testing (component test + browser print-preview) → Task 1 test; Task 2 Steps 6–7.
- Docs / CHANGELOG in same commit → Task 2 Steps 5, 8.
- Out of scope (no admin-page/PDF/route changes, no logged-out button) → honored; no task adds them.
No gaps.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All code and commands are literal.

**3. Type consistency:** `PrintQrButton` (no props) is defined in Task 1 and consumed identically in Task 2. Class names are consistent across page and CSS: `qr-print-host`, `qr-print-area`, `qr-print-label`, `no-print`. `loggedIn`, `item.make/model/serialNumber`, and `itemUrl` are all pre-existing in `page.tsx`.
