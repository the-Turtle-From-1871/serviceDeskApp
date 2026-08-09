# Sort & filter popup menu on `/items`

Date: 2026-08-08
Status: approved, ready for implementation

## Problem

The `/items` toolbar renders six controls in one wrapping row: a **Sort by**
`<select>`, an **Asc/Desc** button, a **Then by** `<select>`, a **Unit (UIC)**
`<select>`, **Print QR codes** (admin only) and the **Columns** `<details>`
menu. Below 720px they pair up two-per-line, so on a phone the toolbar is three
rows of chrome above the first result.

Four of those six controls answer one question — "what order, and which unit?"
— so they collapse into one button that opens a menu.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | The whole sort cluster **plus** the Unit filter: Sort by, Direction, Then by, Unit. |
| Button name | **"Sort & filter"** — the panel holds a filter, so a button reading "Sort by" would understate it, and an active unit filter hidden behind a sort-only name is easy to forget. |
| Mechanism | Native **Popover API**, bottom sheet below 720px, anchored dropdown at 721px+ via **CSS anchor positioning**, `@supports` fallback to the sheet. |
| Apply model | **Apply on tap, panel stays open.** Same navigation behaviour the toolbar has today. |
| Roles | Native radio inputs grouped by `name`, **not** `role="menu"`/`menuitemradio`. |

Toolbar goes from six controls to three: `Sort & filter` · `Print QR codes` ·
`Columns`.

## Component boundary

New client component `src/components/SortFilterMenu.tsx`.

It is **presentational plus popover mechanics only**. It receives current state
and four callbacks:

```ts
{
  sortKeys: SortKey[];
  uic: string | null;
  uics: string[];
  onPrimary: (key: string | null) => void;
  onDir: (dir: "asc" | "desc") => void;
  onSecondary: (key: string | null) => void;
  onUic: (uic: string | null) => void;
}
```

`ItemSelectTable` keeps `hrefFor` / `navigate` / `setPrimary` / `setSecondary`
/ `flipPrimaryDir` and gains a `setUic`. **The menu never builds a URL.** That
keeps one owner for the compound-sort querystring contract, where `sort` and
`dir` travel as parallel comma lists the server pairs positionally — a second
place writing that pair is exactly how the two lists drift out of step.

Why its own file: `ItemSelectTable.tsx` is already 639 lines, and this control
has no dependency on selection, gestures, paging or the row renderer.

`SortKey` is owned by `listItems` in the `server-only`, Prisma-importing
`items.service.ts`, and `ItemSelectTable` re-exports it rather than
redeclaring it. The new component must import it **`import type`** — a
type-only import is erased at compile time, so it pulls no DB client into the
client bundle. A value import there would.

### The trigger's summary text

A pure function `sortFilterSummary(sortKeys, uic)` added to
`src/components/items-view.ts` — the existing dependency-free leaf for this
table, which already has `items-view.test.ts` beside it.

- Primary sort label plus `▲`/`▼`, or `Newest` when no sort is set.
- ` · ` then the UIC, omitted entirely when no unit filter is active.
- Examples: `Newest`, `Make ▲`, `Make ▲ · 2/6 IN`, `Newest · 2/6 IN`.

The secondary key is deliberately **not** in the summary — it would push the
button past its width on a phone for a detail that only breaks ties.

## Markup

```
<button popovertarget="items-sortfilter" id="items-sortfilter-btn"
        class="btn btn-secondary">
  Sort & filter · <summary text> ⌄
</button>

<div id="items-sortfilter" popover="auto">        ← NO layout class, ever
  <div class="popup-menu__panel">                 ← all layout lives here
    <div role="radiogroup" aria-labelledby="…">  Unit
       ○ All units   ○ <each uic>
    <div role="radiogroup" aria-labelledby="…">  Sort by
       ○ Default (newest)   ○ <each SORTABLE_COLUMNS entry>
    <div role="radiogroup" aria-labelledby="…">  Direction
       ○ Ascending   ○ Descending            (inputs disabled with no primary)
    <div role="radiogroup" aria-labelledby="…">  Then by
       ○ —   ○ <SORTABLE_COLUMNS minus the primary key>
                                              (inputs disabled with no primary)
    <div class="popup-menu__footer"> [ Done ]   ← sheet only; hidden on desktop
```

`Done` is a `<button popovertarget="items-sortfilter" popovertargetaction="hide">`
— no JS. It exists because a bottom sheet needs an obvious close affordance
that a thumb can reach; the desktop dropdown has Escape and click-outside in
plain sight, so the footer is hidden there.

### Why not `role="menu"` / `menuitemradio`

APG's menu-button pattern is the textbook answer for a sort picker, and taking
it literally means hand-building roving `tabindex`, arrow-key navigation and
typeahead — and a half-implemented `role="menu"` is worse than none, because
the role promises AT users keyboard behaviour that then is not there.

Native radios grouped by `name` give arrow-key navigation within a group,
checked state and group semantics for free. It also mirrors what is already on
this toolbar: **Columns is native checkboxes in a panel (choose many); this is
native radios in a panel (choose one).**

`role="radiogroup"` sits on a plain `<div>` rather than a `<fieldset>`/
`<legend>`: preflight is absent in this app, so fieldset/legend arrive with UA
border, padding and the legend's notorious box behaviour, and grouping for
keyboard and selection comes from the shared `name` attribute, not from the
fieldset. Disabled state therefore goes on each `<input>`, not on a
`<fieldset disabled>`.

### What the Popover API provides

Confirmed against MDN, not assumed:

- Implicit **`aria-expanded` and `aria-details`** between invoker and popover,
  established by `popovertarget`.
- Focus-order insertion — the panel's controls come next in the tab sequence.
- **Escape** closes and returns focus to the invoker.
- **Light dismiss** — clicking outside closes it.
- Top layer, so no ancestor's `overflow` or `position` can clip the panel.

The current `<details>`-based Columns menu has none of these.

## The trap this design is built around

The UA hides a closed popover with `[popover]:not(:popover-open) { display: none }`,
and **any author `display` rule beats it.**

That is bit-for-bit the `<dialog>` bug that already shipped on this exact page:
`.card` sets `display: block` and `.stack` sets `display: flex`, so
`<dialog className="card stack">` made every closed dialog render — `/items`
carried 50 of them, one per row, each an absolutely-positioned box whose own
content intercepted the taps meant for the Delete buttons.

So: **the `[popover]` element carries no layout class.** All layout lives on
`.popup-menu__panel`, an inner wrapper — the same split
`src/components/DeleteItemButton.tsx` uses for its dialog.

The UA also gives `[popover]` `border: solid`, `padding: 0.25em`, `inset: 0`
and `margin: auto` (which centres it). All four are reset explicitly on the
popover element.

## CSS

Added to `src/app/globals.css` — this is legacy-design-system UI on an existing
page, not a new shadcn surface, so it does not go in `src/components/ui/*`.

**Base (mobile-first) — a bottom sheet.** No anchoring involved:

- `position: fixed; inset: auto 0 0 0; margin: 0; width: 100%`
- `max-height: 80svh` — `svh`, not `vh`, because of the iOS URL bar
- the panel scrolls (`overflow-y: auto`), the popover element does not
- `padding-bottom: max(12px, env(safe-area-inset-bottom))` — the app installs
  to the iOS home screen and has no browser chrome beneath it
- dimmed `::backdrop`
- rounded top corners only; the sheet is flush to the bottom edge

**Desktop — anchored dropdown, behind two gates:**

```css
@media (min-width: 721px) {
  @supports (anchor-name: --a) {
    /* anchor-name on the trigger, position-anchor + position-area on the
       popover, position-try-fallbacks: flip-block, transparent ::backdrop,
       footer hidden */
  }
}
```

`721px` because this app's breakpoint is `max-width: 720px` everywhere else.

**The fallback is the point of that nesting.** CSS anchor positioning is
Chrome/Edge 125, Firefox 147 and **Safari 26** (~84% global) — much newer than
the Popover API's Safari 17 (~96%). If `anchor-name` is unsupported the
`@supports` block simply never applies and the sheet rules stand, so **Safari
below 26 on desktop gets the bottom sheet** — usable, and no second code path
to maintain. Below 720px the sheet is unconditional, so **iOS never depends on
anchor positioning at all**, which is where support is thinnest and where this
app is most used.

Touch targets: every radio row gets the documented 44px floor (`--tap`), the
same way `.col-menu-panel label` already does.

## Behaviour

Tapping a sort field, a direction or a unit calls back immediately, which
`router.push`es and re-queries the server — unchanged from today's toolbar. The
panel **stays open**: `/items` navigations are within the same route, so
`ItemSelectTable` stays mounted, the popover element is never unmounted, and it
stays in the top layer across the re-render. It closes on Escape, on
click-outside, or on `Done`.

Existing rules that stay exactly as they are:

- **"Then by" is offered only once a primary key is chosen** — a tie-breaker
  with nothing to break is meaningless. Enforced by disabling those inputs.
- The primary key is excluded from the "Then by" options.
- Changing sort or unit resets to page 1; paging preserves both.
- The `<th>` `▲`/`▼` indicator on the sorted column is untouched.
- No `nulls: last` pinning is introduced anywhere.

## Verification

`items-view.test.ts` — `sortFilterSummary` across: no sort, sort with each
direction, unit only, sort plus unit.

`ItemSelectTable.test.tsx` (jsdom) — the invariants:

- the `[popover]` element has **no `class`**, and the panel is a child
  (the same assertion shape the existing `<dialog>` invariant test uses)
- the trigger carries `popovertarget` pointing at the panel's `id`
- the radio matching the current sort key is checked; `Default (newest)` is
  checked when no sort is set
- Direction and Then by inputs are disabled with no primary key
- the primary key does not appear among the Then by options
- choosing a field pushes the expected `/items?sort=…&dir=…` URL, and choosing
  a unit pushes `?uic=…` and drops back to page 1

jsdom's popover support is partial, so these assert **attributes and handlers**
— never `:popover-open` or anything positional.

**Neither `npm run build` nor jsdom is evidence for this change.** Neither has
a layout engine. Verification is a real browser at 390×844 with touch, and at
desktop width, checking: the sheet clears the safe-area inset, the panel
scrolls rather than the page, the dropdown anchors under the button and flips
above it near the viewport bottom, click-outside and Escape both close, focus
returns to the trigger, and every radio row clears 44px.

## Documentation, in the same commit

- **`CHANGELOG.md`** — a `## 2026-08-08` section, under `Changed`.
- **`.claude/rules/ui-styling.md`** — the popover UA-`display` trap (as a
  sibling of the existing `<dialog>` entry, since it is the same failure), and
  the sheet-below-720px / anchored-above / `@supports`-fallback structure.
- **`CLAUDE.md`** — the one-line `<dialog>` trap summary in the Styling section
  extended to name `[popover]` too, so a reader who has not opened the rule
  file still sees it.

No authn/authz check, crypto, token, cookie, public-surface or CI change is
involved, so **`docs/SECURITY.md` is unchanged.**

## Out of scope

- The **Columns** menu is not converted. It works, and rebuilding it is a
  separate decision; if the popup proves out, `.popup-menu` is written so
  Columns could adopt it later.
- The service queue's toolbar (`ServiceQueueTable`) keeps its own controls.
- No change to `listItems`, `parseSortKeys`, `sort-keys.ts`, the raw-SQL
  derived-sort path, or the URL shape. This is presentation only.
