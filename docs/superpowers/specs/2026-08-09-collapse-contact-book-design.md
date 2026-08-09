# Collapse the contact book on /admin/users

**Date:** 2026-08-09
**Status:** approved

## Problem

`/admin/users` is two features stacked on one page. Above the fold it is about
users — an "Add a user" card and the user table. Below it, the contact book adds
a heading, an always-expanded six-field "Add a contact" form, and an unbounded
table of every saved recipient. On a book of any size the page's own subject is
a minority of its height, and the contact book is the rarely-used half: receipts
file their non-DCSIM parties into the book automatically
(`upsertContactFromParty`), so hand-adding a contact is the exception, not the
routine.

## Decision

Collapse the entire contact book — heading, add-form and table — into a single
closed disclosure at the bottom of `/admin/users`, labelled with a live count.

Rejected alternatives, and why:

- **Collapse only the add-form.** Reclaims two rows of form grid and leaves the
  table, which is the taller half. Too small a win for the churn.
- **Denser table rows.** Treats the symptom. The page would still be half
  contact book.
- **Move it to `/admin/contacts`.** The biggest reduction, but admin navigation
  is at its measured five-tab ceiling (`navItemsFor`, pinned by `nav.test.ts`),
  so a new route either forces something out of the rail or becomes a page
  reachable only by a link — a nav decision, not a density one.

## Mechanism

A native `<details>`, not a `useState` toggle:

- It opens before hydration and takes Enter/Space on the `<summary>` for free.
- The open state is the element's own, so nothing has to be tracked in React.
- It is already this app's idiom for a collapsible admin block —
  `UnitManager.tsx`'s "Devices with no home unit (N)" is
  `<details className="card stack-sm"><summary className="btn btn-secondary">`.

It needs almost no new CSS. Preflight is absent, so `<summary>` keeps the UA's
`display: list-item` and its marker triangle — but `.btn` sets
`display: inline-flex`, which overrides it. That is why `UnitManager` carries no
marker-suppression rule and neither will this.

## Shape

The change is confined to `src/app/admin/users/page.tsx`, where the bare `<h2>`
+ `<p className="subtle">` + `<ContactBookSection>` become:

```tsx
<details className="stack">
  <summary className="btn btn-secondary">
    <h2 className="disclosure-title">Contact book ({contacts.length})</h2>
  </summary>
  <p className="subtle">Saved recipients, ordered by last name.</p>
  <ContactBookSection contacts={…} />
</details>
```

`<details className="stack">`, not `card stack-sm` as `UnitManager` uses:
`ContactBookSection` already renders its own `.card` around the add-form, and an
outer card would nest one card inside another.

`ContactBookSection.tsx` is not touched.

### The heading stays

Folding the section title into the summary would leave the page with a single
heading and no outline below it. A real `<h2>` inside a `<summary>` is valid
HTML and keeps both the document outline and the disclosure semantics. It needs
one small rule in `globals.css` — a `.disclosure-title` that zeroes the margin
and inherits the button's font size and weight — because `.page-title` at 24px
inside a 40px `.btn` would inflate the control.

### And a chevron

Added after seeing it rendered: without one the summary is a button that gives
no sign it opens onto anything. `.disclosure-chevron` is a lucide `ChevronDown`
with `display: block`, rotated by `details[open] > summary`, matching
`.card-more__chevron` on the item card — including the reason it is an icon and
not a `⌄` glyph, which font metrics place off-centre once rotated.

## Verified

Driven in Chromium at 1280px and 390px against the local dev server: the summary
is 40px on desktop and 44px on a phone, the `<h2>` survives as an `H2` at the
button's own 14px/600 with zeroed margins, `summary`'s computed `display` is
`flex` (so no UA marker triangle), the table is hidden closed and visible open,
and the page went 2485px → 1274px on desktop and 7294px → 3087px on a phone.

## Consequences (accepted)

1. **Adding a contact is one click further away.** The rare path pays for the
   common one.
2. **The payload does not shrink.** A closed `<details>` still renders its
   contents into the DOM, so the whole book — names, emails, phone numbers —
   still ships to the client on every `/admin/users` load, exactly as today.
   This is a visual-density change only. Deferring the fetch until the section
   is opened is a separate and larger change; `listContacts()` is currently
   unbounded (no `take`).
3. **Open state resets on navigation.** It survives a save — `revalidatePath`
   re-renders, but React never controls the `open` attribute, so the element
   keeps it — and is closed again on a fresh visit. Persisting it would need
   localStorage plus a hydration guard, which is not worth it for this.

## Out of scope

Bounding `listContacts()`, deferring the fetch, a `/admin/contacts` route, and
any change to the contact-book write paths or their authorization.

## Documentation

`CHANGELOG.md` gets a `## 2026-08-09` → `Changed` entry. No `docs/SECURITY.md`
change: no authn/authz check, crypto, cookie, retention window, public surface
or CI posture is touched — the same admin sees the same data behind the same
`requireAdmin()`.
