# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## 2026-07-29

### Fixed
- **A failed search no longer reports "No matches."** If the public search is temporarily throttled or unreachable it now says so, instead of telling you your serial number does not exist.
- **Resetting a password is now counted per link rather than per network.** Five people clicking yesterday's expired reset links used to lock out the sixth, who was holding a perfectly good one. The reset form also now carries the same browser check as sign-in — it is the one place where a correct guess would hand over an account outright.

### Security
- **Signing out can no longer lock the office out of signing in.** An unauthenticated request to the sign-out endpoint shared a budget with sign-in, so 60 of them from anywhere would have refused every technician behind the same internet connection for fifteen minutes.
- **Entering the correct public PIN no longer resets the guess counter for everyone on that network**, which had let someone sharing the connection get a fresh five guesses every time a colleague unlocked legitimately.
- **A distributed attack on the public PIN can no longer tighten sign-in for everybody.** Wrong PINs and bad reset links still raise an alert; only failed sign-ins now trigger the stricter browser check, so the alarm cannot be used as a lever against the app.
- **Signing in now lasts one 10-hour workday, and 4 hours of inactivity ends it.** A session used to survive for up to 30 days, so a browser left open on a shared workstation stayed signed in for weeks. It now expires 10 hours after sign-in no matter how busy the day was, and sooner if nobody has touched it for 4 hours; either way the next request goes to the sign-in page. Everyone already signed in when this ships keeps their session — the clock starts from when they last used it, not from a clean slate, so a browser profile that has been sitting untouched for days is asked to sign in again rather than being handed a fresh workday.
- **Sign-in and password reset are now counted per account AND per network.** Five failed attempts on one account from one connection, under a ceiling of sixty attempts per connection overall. The pairing is the point: counting only per connection would mean one person mistyping their password five times locks out everyone else at the desk, while counting only per account would let someone work through a list of addresses unchecked. The email is stored only as a one-way hash, never in readable form.
- **A distributed attack across many addresses is now detected and raises an alert.** Per-connection limits are blind to ten thousand machines making four attempts each; the app now also watches the total rate of failed sign-ins and logs an alert when it becomes abnormal. It deliberately does not shut anything down — a global block is an outage anyone could trigger on purpose — but while the alert is live, a sign-in that cannot be verified as coming from a browser is refused rather than given the benefit of the doubt.
- **Logged-out requests that do not look like they came from a browser are refused** on the public pages (item pages, hand receipts, the search). Sending no browser identification at all, or the default identification of common scraping tools, gets a short refusal instead of the page. Signed-in staff are never subject to this.
- **The Sign in button now waits for the browser check to finish**, showing "Checking your browser…" until it does. Without this, typing quickly and submitting sent the form before Cloudflare had answered, and a perfectly good password came back as "could not verify that request came from a browser". If the check cannot run at all, the button is released rather than leaving you stuck.
- **Sign-in and "forgot password" can now sit behind a Cloudflare Turnstile challenge.** It is invisible unless Cloudflare decides a visitor needs to prove they are a person, and it is verified on the server, so a script that skips the widget gains nothing. Off until keys are configured — see the note below.

### Notes
- **Turnstile is off until it is given keys.** Add `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (both, or it stays off) from the Cloudflare dashboard. Until then no challenge is shown and none is required — and note that the distributed-attack detector escalates *to* Turnstile, so without keys it can alert but cannot act.
- **The browser check is a coarse filter, not a wall.** Anyone determined can send whatever identification they like; it turns away the lazy majority and nothing more.
- **Rate limiting works with no setup, but is only fleet-wide once a Redis store is attached.** Until then each server instance counts on its own, so a determined attacker spread across instances gets more attempts than the numbers above suggest. To fix: add a Redis integration from the Vercel Marketplace to the project — it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically and nothing else needs to change. (Vercel's own KV product is retired; the Marketplace integration is its replacement.) If Redis is attached and later goes down, requests are allowed through rather than everyone being locked out.

## 2026-07-28

### Added
- **Set readiness and change category for a whole selection**, next to **Mark as on hand** on `/items` and on an item's own page (admin only). Readiness offers **Ready to deploy**, **Untriaged**, **Retired** and **Active** — the four states a person is actually in a position to assert. **Deployed** and **In repair** are shown but greyed out, with the reason: the first comes from an open unreturned hand receipt or an MDM logon, the second from the service queue, and neither is something to claim by hand. Nothing new is stored — picking **Ready to deploy** records the same "it's back on my shelf" marking the existing button does, so the two can never disagree.
- **UIC, Notes and Category are now editable straight from an item's page**, not only from `/admin/items/<id>/edit`. Both edit forms now offer the same seven fields: Name, Home unit, UIC, Current user email, Current position, Notes and Category.
- **Current user email and Current position are now editable from the admin edit page**, which previously only had them on the item page.
- **Correcting a wrongly-entered make, model or serial number** now has its own **Item identity** panel at the bottom of `/admin/items/<id>/edit`, with its own Save button, separate from the seven everyday fields above it. It is admin-only and does not appear on the item page. Correcting a serial is a deliberate act rather than something you tab through, because a serial number is the identity existing signed hand receipts refer to — the panel says so. Entering a serial another item already has (in any capitalisation) is refused with a message naming it, rather than a generic failure.
- **Sort the `/items` table by Readiness.** It was the one column you could see but not order by. Picking it groups the catalogue into **Deployed → Ready to deploy → In repair → Retired → Untriaged** (the same sequence the analytics chart uses, so the two read alike), with the arrow reversing it. It works as a secondary key too — "sort by Unit, then by Readiness" — and the ordering acts over the whole catalogue, not just the page you are looking at.

### Changed
- **Leaving a service deadline blank now means the item has no deadline**, instead of quietly getting one. Flagging something for service without filling in the days used to start a hidden clock — 3 days for a reimage, 7 for a repair, 5 for anything else — which then produced an "Overdue" badge and an overdue email for work nobody had put a date on. Blank now means blank: the item shows **—** in the Due column, never goes overdue, and never triggers an alert. Fill the days field in and it behaves exactly as before.
- **A service item's deadline now has its own control** on the item page, showing the current deadline in full ("Deadline — currently Aug 04, 2026, 12:01 PM HST"). Changing an item's service type or note no longer touches its deadline at all, and the days field only appears on the flag form while you are creating a flag. Clearing a deadline is done deliberately, by emptying that one field and saving. Unlike the other service inputs, it rejects an out-of-range number instead of treating it as blank — it is the one control that can wipe a date, so a typo must not read as "delete it".
- **An overdue service alert is re-armed only when the deadline actually changes.** Editing a note no longer re-sends the overdue email for a deadline that already alerted.
- **Clearing the Category box on an edit form now clears the category.** It previously looked like it saved and changed nothing. A category longer than 60 characters is now rejected with a message rather than silently dropped. CSV imports are unaffected — a blank cell there still means "leave it alone", which is what you want from a partial spreadsheet.
- **A category typed on the item page now joins the managed list** at `/admin/categories`, the same way the admin edit form and CSV import already worked. Otherwise it was possible to put a device into a category that appeared in no picker.
- The **Sort by** control on `/items` now offers every column the table displays. Readiness was previously the only exception.
- The **DA Form 2062 velocity** chart on `/admin/analytics` is now called **DA Form 2062 volume**. Its CSV and PNG exports are named `transfer-volume-…` accordingly; what the chart counts is unchanged.
- The colour key under the **Audit readiness** donut is centred, matching the count row directly above it. Both rows now sit under the middle of the donut instead of the key hanging off to the left.

### Removed
- **The per-service-type default deadlines** (Reimage 3 days / Repair 7 / Other 5). See the blank-means-no-deadline note above.

### Fixed
- **Blanks on `/items` now follow the sort direction instead of being pinned to the bottom.** Sorting by **Device Name** descending used to open on a screen of dashes, and reversing a sort left part of the list sitting still — which reads as the sort being broken. Empty values now sort as a value: they gather at one end and swap ends when you reverse, so reversing a sort reverses the whole list. This applies to every sortable column, including **Unit (UIC)**, **Category** and **Audit**, and behaves the same whether or not Readiness is one of your sort keys.
- **The tables on `/admin/analytics` are ruled consistently.** The **Fleet status** and **Unit allocation** tables drew a heavy 3px frame down their sides and between rows, while the final row was left with no closing line at all — so the bottom of each table trailed off and did not match the rows above it. Every divider, including the one under the last row, is now the same 1px ledger hairline. The **View as table** mode on each chart is ruled the same way.
- **Chart PNG exports now include the colour key.** Exporting a chart to PNG left the legend out of the image, so the **DA Form 2062 volume** export was a stack of bars with nothing naming the series. The exported image still excludes the card's menu button.
- **The recipient type-ahead on the hand-receipt builder no longer offers a contact that does not match what you typed.** Clearing the name box and typing something new could briefly list the previous search's contact against the new text, and a slow reply for a name you had already deleted could surface after the fact. Suggestions are now tied to the exact text that fetched them.

### Security
- **A public-access PIN unlock now lasts 12 hours instead of 7 days.** A logged-out recipient who enters the PIN can browse item pages and hand receipts for the rest of the working day and is asked for it again after that. Logged-in staff are unaffected. This also tightens PIN rotation: a rotated PIN now locks everyone out within 12 hours rather than up to a week.
- **A deploy with no signing key now shows an error instead of breaking the public pages.** If `AUTH_SECRET` were missing, the public item and receipt pages returned a server error on every request and the PIN form failed with a crash rather than a message. Nobody could get past the gate either way — this is not a bypass being closed — but the failure is now legible instead of an outage.
- **Deactivating an account now signs it out everywhere immediately.** Deactivation already blocked the account from reading or changing anything on its very next request, but the sign-in it already had was left alive until it expired on its own — up to 30 days. In practice that meant a deactivated account still counted as "signed in" for the shared public-access PIN, so someone who had just been offboarded could keep browsing the public item and receipt pages without being asked for it. Deactivating now revokes the existing sign-in outright, the same way a password change does. Reactivating an account requires the person to sign in again.
- **Sign-in, password reset and the public PIN are now rate-limited per network.** Five *failed* attempts in fifteen minutes from the same IP and the form says to try again later, naming roughly how long. Getting it right gives the per-account attempt back, because the desk shares one internet connection and counting successful sign-ins against your own account would have taken everyone offline after five people logged in. The wider per-connection ceiling does still count successes — it is sixty, so a normal shift change is nowhere near it. Requesting a reset email is the one exception and counts every request, because mass-requesting is the abuse there. Item pages, hand receipts and the public search are separately capped at 100 requests a minute per network for **logged-out visitors** — no person browsing will reach it, a scraper will, and signed-in staff are not counted at all.

### Notes
- No migration and no new configuration for any of the item-editing, readiness or deadline changes. The service deadline column was already optional in the database, and readiness is still worked out from live signals rather than stored.
- **Existing service items keep the deadline they already have** — the change affects what happens from now on, not what is already in the queue. Editing an item's service type or note leaves its deadline exactly as it was, down to the minute.
- **Putting a device back into the queue always starts a clean round.** Whether you reopen a completed item or flag it again because it broke a second time, it does not inherit the finished job's deadline — set a new one on the way in, or leave the days box blank for none. Without this a repeat repair opened already reading "Overdue 17d" against the *previous* job's date, and, worse, could never send an overdue email of its own because the old job's alert had already been sent.
- Bulk category changes are written to each item's edit history in the same form as a single edit, one entry per item that actually changed.

- The shorter window applies to unlock cookies already in the wild, not just new ones: an outstanding cookie is refused on its next request once it claims more than 12 hours of remaining life, so nearly everyone unlocked before this deploy is asked for the PIN again. The exception is a visitor already within 12 hours of their old 7-day expiry — their cookie has no more life than the new window allows, so it simply runs out. Refused cookies are also expired in the browser rather than left to be resent. No env var or migration is involved.
- No schema change and no new column: readiness is still worked out from live signals at query time. Sorting by it runs a different query behind the scenes; searching and the Unit (UIC) filter behave identically either way, and a test asserts that by comparing both paths row for row.
- The deactivation fix reuses the existing `User.passwordChangedAt` revocation stamp — no migration and nothing to apply to the database. Anyone deactivated *before* this ships keeps their old session until it expires; deactivate and reactivate them once to cut it off now.

## 2026-07-27

### Added
- **Operational readiness on inventory items**, shown on `/items` and each item page as **Deployed**, **Ready to deploy**, **In repair**, **Retired**, or **Untriaged**. It is worked out from what the app already knows — whether the item is flagged for service, whether it is out on an unreturned hand receipt, when it was last logged into per the MDM export, and when someone last marked it back on the shelf — so it reflects reality without anyone maintaining a status field.
- **"Mark as on hand"** (admin only) on `/items` (for the current selection) and on an item's page: records that the device is physically back in our possession. That reads as *Ready to deploy* until something contradicts it — the device gets issued out, gets flagged for service, or shows an MDM logon dated after the marking. Completing a service-queue item marks it on hand automatically, since the device is on the bench at that moment.
- **Readiness analytics dashboard** at `/admin/analytics` (admin-only, linked from the admin hub). A global **Unit (UIC)** filter at the top re-scopes every widget on the page: audit readiness (audited / overdue / never audited), fleet KPIs (in-service vs ready, broken down by category), DA Form 2062 velocity, and a unit-allocation leaderboard whose rows set the global filter. The velocity chart offers 30d / 90d / 6m / 1y ranges, and every chart can be exported to PNG or CSV or switched to a **table view** from its actions menu.
- **Group the unit-allocation table by unit name or UIC.** A **Group by** dropdown on that card counts the fleet under either **Unit name** (the default) or **UIC**, and the column header follows. These are genuinely different pictures of the same fleet — a single UIC covers as many as 46 different unit names in the catalogue, and plenty of items carry one without the other — so the dropdown re-runs the query rather than relabelling the same rows. Clicking a row scopes the whole dashboard by whichever dimension is on screen (`?unit=` or `?uic=`); if both filters end up set they narrow the page together, and the header line says so. Items with no value in the chosen dimension are now shown as an **Unassigned** row instead of being left out, so Total adds up to the item count in the page header.
- **Device category** on items (`Laptop`, `Switch`, …). Importable via CSV — the importer fills it from a **`deviceType`** column (also accepts `deviceCategory` or `category`; spacing and casing are ignored, so `Device Type` works) — and a change is logged to item history like `deviceUIC`. A category the import introduces is registered in the managed list automatically. Backfill the existing catalogue by re-importing with a `deviceType` column.
- **Admin management of device categories** at `/admin/categories` (linked from the admin hub). Admins can add a category and remove one, with a live count of how many items use each. Removing a category that is still assigned to items is **refused** (in the UI and on the server) with the count, so a device can never be left holding a category that no longer appears in any picker. Category names are case-insensitively unique, so "Laptops" and "laptops" cannot both exist, and surrounding/repeated whitespace is normalised on save. A CSV import carrying an unrecognised category **registers it automatically** rather than failing — the same "learn as you go" behaviour the unit list already has. The item edit form now offers the managed list (and also accepts a new name typed directly).
- **Inventory table upgrades** on `/items`: new **UIC**, **Category**, and **Readiness** columns, a **Unit (UIC)** filter, and **compound sorting** ("sort by Make, then by Serial").

### Changed
- The **Readiness** column on `/items` can be shown or hidden like any other column, but is no longer offered in the **Sort by** control. Readiness is worked out from several sources at once rather than being a field on the item, so there is nothing to sort the whole catalogue by; the analytics dashboard is where fleet-wide readiness composition lives.

### Removed
- The **"Fleet status over time"** chart. It plotted a recorded history of a status field that no longer exists — readiness is now worked out live, so there is no past to chart, and drawing one would have meant inventing it. The other four dashboard widgets are unchanged.
- The bulk **"Set readiness"** dropdown on `/items`, replaced by **"Mark as on hand"**. Picking a state by hand was the whole problem: in practice nobody ever did, so every device read *Untriaged* while the app already had the evidence to answer.

### Fixed
- The admin item edit form now actually saves **Category** and **Unit (UIC)**. They were being validated away by a schema that didn't declare them, so the form reported "Saved" while discarding both.
- Searching on `/items` no longer clears the **Unit (UIC)** filter or the second key of a compound sort. The search box rebuilds the URL, and was not carrying the new state.
- The `/items` filter controls stay on screen when a filter returns no rows — previously the whole toolbar was replaced by an empty-state card, leaving no way to undo the filter except editing the URL.
- Chart date labels and CSV exports are pinned to **HST** like the rest of the app. Without it, month buckets rendered a month early for viewers west of UTC.
- The unit-allocation leaderboard no longer counts retired equipment in its Deployed/Ready columns while excluding it from Total (which could make Deployed + Ready exceed Total). All analytics widgets now consistently exclude lifecycle-retired items.
- A repeated query parameter (`?uic=A&uic=B`) no longer 500s `/admin/analytics` or `/items`.
- Velocity chart colours no longer shift when the unit filter changes, and the "Other" bucket now folds the *smallest* categories rather than the alphabetically-last ones.
- Category names are normalised identically on every write path, so an item's stored category can't drift from its vocabulary entry and make the in-use count under-report.

### Security
- The category in-use check no longer uses a `LIKE`-based comparison, where `%` or `_` in a category name acted as a wildcard and could refuse (or allow) deletion based on the wrong rows.
- CSV exports neutralise spreadsheet formula injection: an imported category like `=HYPERLINK(...)` is written as text rather than becoming a live formula in an admin's export.
- The dev-only analytics seed now refuses to run against a non-local `DATABASE_URL`. Its previous `NODE_ENV` check passed straight through under `tsx` (where `NODE_ENV` is unset), so a prod-pointing `.env` would have let it overwrite readiness fields fleet-wide.

### Removed
- **The stored "accounted for" flag is gone — accountability is now derived from audit recency.** An item counts as accounted for when an audit says so, and the **Audit readiness** donut now shows all three audit states (**audited within the last year** / **audit overdue** / **never audited**) instead of a two-slice accounted-vs-not split. Why: the flag defaulted to "accounted for" and was only ever settable from the readiness bulk bar, so the dashboard reported a 100%-accounted-for fleet of 1,139 items — of which only 4 had ever actually been audited. It was measuring a column default, not the equipment. The **Set accountability** control is removed from the bulk bar (record an audit instead), and the "Not accounted for" badge is gone from the items table, where the Audit column already carries that signal.
- The **Group by readiness** toggle on `/items`, along with the readiness group headers and the `?group=none` URL parameter. The list is a flat table again, ordered purely by the sort you choose — readiness is still a hideable **column**, and fleet readiness composition is what the analytics dashboard is for. Grouping also silently outranked the chosen sort (it demoted "sort by Serial" to "sort by serial *within each readiness group*"), which the sort controls no longer have to explain.

### Changed
- Tailwind CSS v4 and `shadcn/ui` were introduced **for new UI only**. Existing pages are untouched: the original stylesheet is loaded into a `legacy` CSS cascade layer and Tailwind's `preflight` reset is deliberately not loaded, so no pre-existing page is restyled.

### Security
- Baseline security review before the feature sprint: a full source-level scan (Server Actions, route handlers, auth, crypto, injection sinks) found no code-level vulnerabilities. Dependency audit remediated the non-breaking advisories via `npm audit fix` (lockfile only, no direct-dep version changes) — clearing a **critical** `@auth/core` chain (malformed-Bearer crash, email homoglyph `@` bypass, unbound OAuth state/nonce/PKCE cookies) plus moderate `@hono/node-server`, `valibot`, and `fast-uri` advisories. Breaking upgrades (`next@16.2.12`, `nodemailer@9`, `eslint@10`) are deferred to a tracked follow-up so they can be tested deliberately rather than force-applied mid-sprint.

### Notes
- Migration `20260728000000_derive_readiness` **drops** `Item.deployableStatus`, the `ItemStatusHistory` table, and the `DeployableStatus` enum, and adds `Item.markedReadyAt` and `Item.lastLogonAt`. **Destructive and one-way.** It loses no observation about readiness — production held **zero** items with `deployableStatus` ever set, so the column and every history row derived from it recorded only the default. `lastLogonAt` is backfilled by parsing the existing verbatim `lastLogonDate` text; an unparseable value degrades to null (the raw text is always kept). Apply with `npx prisma migrate deploy`; prod is hand-applied via the standard manual process **before** the deploy that ships this code, since the old code still selects the dropped column.
- Readiness derivation is written twice on purpose — `src/modules/items/readiness.ts` (one row, TypeScript) and `src/modules/items/readiness.sql.ts` (whole fleet, SQL) — and `readiness.parity.test.ts` runs one fixture table through both and asserts they agree. Change the precedence in one and that test fails until the other follows.
- Migration `20260727234500_drop_is_accounted_for` **drops** `Item.isAccountedFor` and `ItemStatusHistory.isAccountedFor`. **Destructive and one-way** — but it loses no observation: the column was `BOOLEAN NOT NULL DEFAULT true` and production held **zero** rows set to `false`, so every value in it was the default. The status-over-time chart reads only `deployableStatus`, so no chart loses a series. Apply with `npx prisma migrate deploy`; prod is hand-applied via the standard manual process, **before** the deploy that ships this code (a `next build` never runs migrations, and the new dashboard query does not reference the dropped column — but the old code does, so ordering still matters for a rollback).
- The audit-readiness donut's colours were re-validated as a three-slice set: blue `#2a78d6` → yellow `#eda100` → red `#d03b3b` (worst adjacent CVD ΔE 19.8, normal-vision 24.1). The `/items` audit-dot colours were tried first so the two surfaces would match, and **failed** — slate is under the chroma floor and slate-vs-amber measures ΔE 11.8, below the 15 floor. Small dots beside a text label survive that; three adjacent wedges do not.
- Migration `20260727210000_device_category_table` adds the `DeviceCategory` table (`name` is `CITEXT UNIQUE`) and **seeds it from the categories already present on items**, so the managed list starts out matching reality rather than empty. Note it is deliberately **not** a foreign key on `Item.deviceCategory` — that column stays a plain indexed string so a CSV import can carry a category the property book has not registered yet. Keeping the two coherent is the service layer's job (deletion is refused while in use; imports register new names).
- Migration `20260727230000_transfer_closed_at_index` adds `@@index([status, closedAt])` on `Transfer` — the velocity chart range-scans `closedAt` on every dashboard load and no existing index served it.
- The CSV importer maps `deviceType` (and `deviceCategory` / `category`) to the device category, but deliberately **not** a bare `type` column. MDM exports commonly carry a generic `Type` column holding OS strings ("Windows 11 Pro 23H2"); mapping that would overwrite every matched item's category on import and pollute the managed vocabulary, so it stays unrecognised.
- Touch targets in the new Tailwind UI meet the app's documented 44px floor (`--tap`) on touch devices and narrow viewports; shadcn's stock 32/36px heights apply on desktop only.
- Migration `20260727180000_device_category_and_status_history` adds the nullable `Item.deviceCategory` text column, B-tree indexes on `Item.deviceCategory` and `Item.deviceUIC` (both are equality filters feeding `groupBy`), and the new `ItemStatusHistory` table. **It also seeds one baseline history row per existing item** so the status-over-time chart has an anchor to step from — without it, items are invisible to the chart until someone edits them. The insert uses `gen_random_uuid()` for the id (`cuid()` is client-side only). Apply with `npx prisma migrate deploy`; prod is hand-applied via the standard manual process.
- New dependencies: `tailwindcss@4` + `@tailwindcss/postcss` (with a new root `postcss.config.mjs`), `recharts`, `lucide-react`, `html-to-image`, `class-variance-authority`, `tailwind-merge`, `clsx`, and four `@radix-ui` primitives. `npm audit` is unchanged by this install — same 13 pre-existing high-severity advisories before and after.
- New dev script `npm run db:seed:analytics` populates categories, UICs, readiness states, back-dated history, and closed demo receipts so the dashboard has something to render locally. It refuses to run when `NODE_ENV=production` and must never be pointed at prod — it overwrites readiness fields and fabricates history.
- Chart colours are validated, not chosen by eye. The categorical palette clears the colourblind-separation and contrast gates against this app's ledger surface; the accountability donut deliberately uses **blue vs red, not green vs red**, because the green/red pair measures ΔE 4.1 under deuteranopia (indistinguishable). Three palette slots sit under 3:1 contrast, which is why every chart ships a legend and a table view — that pairing is the accessibility mitigation, not decoration. Re-run the validator before changing any hex (see `src/app/admin/analytics/palette.ts`).
- Migration `20260727120000_item_operational_readiness` adds two columns to `Item`: `isAccountedFor` (`BOOLEAN NOT NULL DEFAULT true` — a metadata-only change on Postgres 11+, so safe on the large table) and `deployableStatus` (nullable `DeployableStatus` enum, no default). Existing rows are left with `deployableStatus = NULL` ("unknown") on purpose — there is deliberately no backfill from hand-receipt state, since an open receipt can mean a device was turned in for service rather than deployed. Apply with `npx prisma migrate deploy`; prod is hand-applied via the standard manual process.

## 2026-07-23

### Added
- CSV item import now updates an existing item instead of skipping it: when a row's `serialNumber` matches, changed `deviceName` / assigned user / MDM telemetry are written, and the item is no longer marked a duplicate.
- New importable fields: `assignedUser` (→ the item's current-user email), `deviceUIC` (the Unit Identification Code of the unit a device is issued to), and MDM telemetry `lastLogonUserPrincipalName`, `lastLogonDate`, `enrollmentDate`, `compliance` — all shown read-only on the item detail page for logged-in users. `deviceUIC` updates on a serial match and its change is logged to item history (like device name / assigned user); telemetry updates silently.

### Changed
- Import required-field rules: only `serialNumber` is a required column. New items still require `make`, `model`, `serialNumber`; existing (matched) items require only `serialNumber`. Blank cells leave stored values untouched on an update. `make`/`model` are never overwritten on a match — a difference is reported as a warning. `deviceName` / assigned-user changes are logged to item history; telemetry updates silently.

### Notes
- Migration `20260723000000_add_mdm_telemetry_fields` adds four nullable text columns to `Item` (`lastLogonUserPrincipalName`, `lastLogonDate`, `enrollmentDate`, `compliance`) and `updatedCount` (default 0) to `ImportBatch`. Migration `20260727000000_add_device_uic` adds the nullable `Item.deviceUIC` text column. Apply with `npx prisma migrate deploy`; prod is hand-applied via the standard manual process.
- The import route (`/admin/items/import`) sets `export const maxDuration = 60` because a full-fleet all-update refresh runs a bounded sequential write loop; the `commitImport` DB transaction timeout is kept just under it (55s). Very large imports (thousands of rows at high DB latency) still need the deferred chunking follow-up. The `/admin/audit` "CSV imports" table now shows an **Updated** column.

## 2026-07-22

### Added
- Public-access PIN gate: logged-out visitors must enter a shared 8-digit PIN to search inventory or view item / hand-receipt pages. Admins set and rotate the PIN from the admin dashboard; a successful unlock is remembered for 7 days. Logged-in staff are unaffected.

### Security
- The previously open public surface (`/`, `/i/*`, `/receipts/*`, receipt PDFs, and the home search) is now behind the PIN when enabled, reducing casual PII enumeration. Enforcement is merged into the existing `src/proxy.ts` (Node runtime); it is a non-authz gate and does not alter existing role-based authorization or the proxy's pre-existing login gate for `/items`/`/admin/*`.
- **Hardened the `?next=` redirect target on `/unlock` against open redirect.** `sanitizeNext` now also rejects raw control characters (tab, newline, CR, etc.) and embedded backslashes, closing a case where `?next=/%09/evil.com` could be browser-normalized into a protocol-relative `//evil.com` redirect after unlocking. Percent-encoded text (e.g. a literal `%09`) is unaffected — only raw control bytes are rejected.

### Fixed
- **PIN-unlock no longer crashes on a database error.** If the PIN check (`verifyPin`) throws (e.g. a transient DB error), `unlockAction` now returns a generic `"Something went wrong. Please try again."` message instead of an uncaught Server Action exception; the error is logged server-side for diagnosis.

### Changed
- **Proxy skips the unlock-cookie HMAC check when it can't affect the outcome.** On the public PII routes, the PIN-gate proxy now only verifies the signed unlock cookie when the gate is enabled *and* the visitor isn't already logged in — the same cases where `shouldAllowPublic` already allows access unconditionally. No behavior change, fewer crypto calls per request.

### Notes
- **New table:** `PublicAccessSetting` (single row, bcrypt-hashed PIN). Migration `20260721170000_public_access_setting`. Apply with `prisma migrate deploy` locally; apply to prod via the Supabase MCP.
- **New env var:** `PUBLIC_ACCESS_PIN_ENABLED` — `"true"` turns the gate on. Default/absent = off (open access, as before). Also the emergency kill-switch.
- **Rollout:** apply the migration → set the PIN in `/admin` → set `PUBLIC_ACCESS_PIN_ENABLED=true` (Vercel + local) and redeploy.
- Rotating the PIN is not retroactive: existing unlock cookies remain valid until they expire (≤7 days). For immediate global revocation, rotate `AUTH_SECRET` (also logs everyone out).

## 2026-07-21

### Fixed
- **Revealed signatures no longer break their row layout.** A shown signature now
  stacks *below* its Show/Hide toggle button (a column) instead of rendering
  inline, so it can't widen the row into the Remove button, overflow the account
  card, or push the audit button down beside the image. The toggle button keeps
  the exact spot the Show button had.

### Changed
- **Account-page saved signatures are hidden by default.** On the account page,
  each saved signature now shows its name with a **Show signature** / **Hide
  signature** toggle instead of the inline image. The image blobs are no longer
  shipped to the page; clicking Show fetches just that one image via an
  owner-scoped action (an admin can only reveal their own). The signature
  *pickers* (item audit, return, receipt builder) are unchanged. The reveal logic
  is now a shared `SignatureReveal` component used here and by the item-page audit
  history, and the toggle button stays put where the Show button was.
- **Item-page audit signatures can be hidden again after revealing.** A revealed
  auditor signature now shows a **Hide signature** button next to it; hiding then
  re-showing is instant (the fetched image is cached, no second request).
- **Item-page audit history: the "Show signature" control moved to the right.** On
  an item's audit history rows, the reveal button (and, once revealed, the
  signature) now sits to the right of the auditor's name and date, right-justified
  in the column, instead of on the left.
- **The `/items` list can now sort by audit status.** "Audit" is a new option in
  the Sort control. Most-urgent-first orders **Overdue → Due soon → OK → Never
  audited** (never-audited rows always trail the dated ones); click again to
  reverse. The sort is server-side over the whole inventory, riding a new
  denormalized `Item.lastAuditedAt` column (the derived audit *state* isn't
  stored, so it can't be an `ORDER BY` directly); the audit badge reads the same
  column, so sort and display always agree.
- **Audit signatures on the item page are hidden by default.** In the Audit
  history on an item's page (`/i/<id>`, already staff-only), each auditor's
  signature is now behind a **Show signature** button instead of shown inline —
  the auditor's name and date stay visible. The signature image is no longer
  shipped in the page payload at all; clicking Show fetches just that one image
  via a staff-gated action (`requireUser`). Any signed-in staff member can
  reveal it. The admin audit page and receipt signatures are unchanged.
- **Admin navigation consolidated into the Dashboard.** The admin header dropped
  from eight items to four (`Search · Items · Dashboard · Account`): the
  **Queue**, **Users**, and **Audit** sections and the **New item** action moved
  off the top nav into a **Manage** section on the Admin dashboard, which now
  serves as the admin hub. Those routes are unchanged and still directly
  reachable; the "Dashboard" link now stays highlighted across the whole admin
  area. USER and logged-out navigation are unchanged.
- **"Needs service?" is now DCSIM-recipient only.** On the hand-receipt builder,
  the per-item "Needs service?" control (the whole Service column) appears only
  when the recipient's "This side is DCSIM" box is checked — the service queue is
  for equipment coming in to the desk, not kit issued to an outside customer.
  Uncheck it and the column disappears (any in-progress selections are dropped).
  Enforced server-side too: `createReceiptAction` ignores any `service[...]`
  selections for a non-DCSIM recipient, so they can't be submitted out of band.
  Flagging service from the item detail page is unchanged.

## 2026-07-20

### Security
- **Supabase RLS / anon-key hardening.** Reinforced the deny-all posture for the
  `anon`/`authenticated` PostgREST roles (every table `RLS enabled, no policy`,
  new tables auto-enabled via the `rls_auto_enable` event trigger). The Data API
  and anon key stay unused — all authorization remains in the app layer over
  Prisma's privileged role.
- **Hardened auth surface.** Tightened the authenticated/authorized boundary on
  the auth flow; public-by-design endpoints (login, home search, receipt + item
  lookup) stay read-only and PII-minimal.
- **Item integrity.** Stronger server-side validation and integrity checks on
  item writes.

### Added
- **Cryptographically sealed asset handoff.** Every hand receipt is now sealed at
  creation with an Ed25519 signature over a canonical manifest of the handoff
  (receipt number, items, **both parties** — sender and recipient details +
  recipient signature — the acting technician (bound via an immutable
  `sealedByUserId` snapshot, not the nullable `createdByUserId` FK, so deleting
  the technician's account can't break the seal), and a server timestamp),
  stored on the receipt. Admins get a **Verify seal** button on
  the receipt page that re-derives the manifest and reports **Valid / Tampered /
  Unsealed / Can't-verify / Not-found** — making after-the-fact edits to a receipt
  detectable (non-repudiation). Sealing is best-effort: if the signing key isn't
  configured, receipts are still created, just unsealed.
- **App Router error boundaries.** `error.tsx` / not-found handling so runtime
  failures render a graceful boundary instead of a broken page.
- **CSV import size guard.** The item-import form now rejects files over 5 MB up
  front, before upload (the analyze→confirm flow uploads the file twice).
- **Print QR from the item page.** The individual item view page (`/i/<id>`)
  shows a **Print QR** button (logged-in users) that opens a printable QR-label
  **PDF** in the **same format as the items-list multi-select QR sheet** (QR code
  with the serial beneath), served from `/i/<id>/qr/pdf`. It uses a PDF rather
  than `window.print()` so it works on mobile too — iOS/WKWebView ignores
  `window.print()`, whereas a PDF opens in the native viewer (Share → Print /
  Save to Files) and prints on desktop. The QR itself stays publicly viewable;
  only the button (and the PDF route) are gated to signed-in users.

### Changed
- **Live search on `/items`.** The items search box now filters as you type —
  no more "Search" button/Enter-to-submit. Input is debounced ~300ms and
  navigates the existing server-paginated URL (`?q/sort/dir`), resetting to
  page 1 on every new query; `sort`/`dir` are preserved. The list itself is
  still fetched server-side per page (unchanged) — only the trigger for a
  search changed, mirroring the live search bar already used on the home page.
- **`/items` at scale.** The items list is server-side **paginated + sorted**
  (URL-driven `?page/sort/dir`); only the current page reaches the client. Hot
  `where`/`orderBy` columns are indexed.
- **Server-side contact type-ahead in the receipt builder.** The builder no
  longer ships the whole contact book to the browser; it now type-aheads against
  the server (`searchContactsAction`, token-AND over name/email/unit, debounced +
  race-guarded), so only the handful of rendered matches reach the client.
- **Faster public search.** The public serial-number and receipt-number searches
  are backed by **pg_trgm GIN indexes**, turning the per-keystroke `ILIKE '%…%'`
  full-table scans into index scans — same (case-insensitive) results, just
  faster.
- **Leaner item page.** Non-admin and anonymous item-page viewers no longer
  receive the ~96-row unit list; only admins, who alone can edit the home unit,
  need it.

### Removed
- **Per-row "QR" link on the items list.** Removed the admin per-row **QR**
  shortcut (to `/admin/items/<id>/qr`) from each row's actions on `/items`; the
  QR is still available from the item page (`/i/<id>`) and the multi-select
  **Print QR codes** sheet.
- **Admin single-item QR page.** Removed the now-orphaned `/admin/items/<id>/qr`
  page and its `/admin/items/<id>/qr/pdf` label route (nothing linked to them
  after the per-row shortcut was dropped). The item-page **Print QR** button
  (`/i/<id>/qr/pdf`, sheet-format label) supersedes them.

### Notes
- Database: adds the pg_trgm trigram **GIN indexes** on `Transfer.receiptNumber`
  and `Item.serialNumber` (applied to dev/test/prod). The citext `serialNumber`
  search casts `"serialNumber"::text ILIKE …` in a parameterized `$queryRaw` so
  it actually uses the trigram index.
- New env var **`SIGNING_PRIVATE_KEY`** (Ed25519 PKCS#8 PEM) signs receipt seals.
  Generate a keypair:
  `node -e "const {generateKeyPairSync}=require('crypto');const {privateKey,publicKey}=generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"`
  Set the private key in `.env.local` (one line, `\n`-escaped) for dev and in Vercel
  (multi-line, as-is) for prod — use separate keys. The public key for verification
  is derived from the private key at runtime, so there is no `SIGNING_PUBLIC_KEY`
  var; keep the public key only if you later want offline/external verification.
  Migration `20260720210000_transfer_crypto_seal` adds the `cryptoSignature` and
  `sealedAt` columns (nullable, additive — no backfill). Migration
  `20260721120000_transfer_sealed_by_user_id` adds `sealedByUserId` (nullable,
  additive — no backfill), an immutable snapshot of the acting technician's user
  id at seal time; the seal signs over this column instead of the SET-NULL
  `createdByUserId` FK.

## 2026-07-17

### Added
- **Hand-receipt return timers.** An admin can set (or clear) a return deadline
  on a hand receipt via a return-by days input; the deadline is editable after
  the fact from the receipt timer UI.
- **Service-desk SLA timers.** Per-service-type SLA defaults compute a service
  item's due date, with a per-item override on the builder (bounded 1..3650
  days). Reopening a service item restarts the SLA clock.
- **Admin dashboard.** New dashboard surfacing overdue and due-soon hand
  receipts and service items, reachable from a **Dashboard** link in the nav.
- **Overdue-alert sweeps.** Daily cron route runs overdue-alert sweeps for both
  hand receipts and service items (`dueAt` / `overdueAlertedAt` columns on
  `Transfer` and `ServiceQueueItem`).
- **Due column** on the service queue, with a sortable `DueBadge`.

### Fixed
- Audit light: lightened the green state so it's distinct from the grey dot.

## 2026-07-16

### Added
- **Annual audit feature.** Per-item audit status with an audit light on the
  items list and item page, an admin **Mark audited** control, and an audit
  history (`ItemAudit` table). Audit state is derived (display-only), never a
  server `ORDER BY`.
- **Scan-to-build.** A camera sheet decodes a QR code (self-hosted wasm) and
  adds the scanned item to an open hand receipt; the item id is parsed by path
  and resolved server-side. Changing the item list invalidates any signature.
- **Start a hand receipt from the item page.**

### Changed
- Relabeled the item **Current user** field to **Current user email** and
  renamed the underlying `currentUser` field to `currentUserEmail` for clarity.

### Fixed
- Excluded `/wasm/` from the auth proxy so the decode binary is publicly
  fetchable.
- Mobile: docked "Scan to add" at the bottom of the items section instead of
  floating; stopped iOS zooming when a text field is focused; custom dropdown
  chevron so the arrow isn't stranded.

### Removed
- Dead Vercel cron config (the 90-day purge runs from GitHub Actions).

## 2026-07-15

### Added
- **Shared contact book.** Admin-managed contact book (on the Users page) with a
  `ContactCombobox` type-ahead over name, email, and unit. The receipt builder
  autofills both the **recipient** and the **sender** from the book.
- **DCSIM recipient signature picker.** When the recipient is DCSIM, a saved
  named signature can be picked; the pick is resolved server-side.
- **Component tests** (`test:ui`, opt-in jsdom), which surfaced and fixed two
  production bugs.

### Changed
- **Reworked the mobile layer** and retired the starter palette.
- `PhoneInput` gained an optional controlled mode.

### Fixed
- Signatures: cleared stale ink, stopped losing names, and closed a privilege
  gap; a signature no longer names a holder for an already-returned item.
- Contacts: `Escape` drops the highlight (not just the list); the combobox no
  longer eats a deliberate Enter submit; the phone field clears between
  contacts; `deleteContactAction` no longer leaks raw errors in dev.
- Corrected the DCSIM-toggle change reporting and gated it on role.

## 2026-07-14

### Added
- **Home-unit auto-detection on item import.** When mass-importing items, each
  item's home unit is now derived from its device name — the device name is
  split on `-`/`_` and matched (case-insensitively, in any position) against a
  reference list of unit abbreviations. Example: `HI-DCSIM-LT-001` → `DCSIM`.
  Detection only fills the home unit when the CSV leaves it blank; an explicit
  value is always preserved.
- **Interactive, learn-as-you-go resolution.** Device names whose unit code
  isn't recognized appear in a resolve step during import: pick which segment is
  the unit code and give it a name once. The mapping is saved and then applied
  automatically to every other item sharing that code — in the same import and
  in all future imports.
- **`Unit` reference table**, seeded with the 71 HIARNG unit abbreviations.
- **Select-all on the items table.** A tri-state header checkbox (none / some /
  all) that operates only on selectable (active) rows; retired items have no
  checkbox and never count toward a selection.
- **Device-name search.** The items list search now matches device name in
  addition to make, model, and serial number.
- **Item-level service queue.** Items are flagged "Needs service?" per serial on
  the receipt builder or from the item detail page, each carrying a service type
  (Reimage / Repair / Other + `serviceNote`). The `/admin/queue` view lists one
  entry per item with search, service-type filter, sort, and toggleable columns.
  "Mark Completed" is reversible (`COMPLETED` is retained, reopenable to
  `PENDING`).
- **Editable item details + edit history.** Inline edit on the item details card
  with a unit picker; a `USER` may edit only current-holder email + position,
  admins edit the full set. Every change writes an `ItemEdit` diff atomically,
  shown as an edit-history section.
- **Named signatures.** Admin-only create/delete of owner-scoped named
  signatures, and a picker to choose the signing technician on a return.

### Changed
- **Item import is now a two-phase flow:** upload → *analyze* (reports what will
  import, what's auto-detected, and what needs a unit — writes nothing) →
  resolve unknowns → *confirm* (writes items in a single transaction). Nothing
  is saved until you confirm; unresolved device names still import, just with a
  blank home unit.
- **`User.email` is now case-insensitive** (`citext`).

### Fixed
- QR code page: a long item URL now wraps onto its own line on narrow screens
  instead of overflowing.
- Stopped admin-only item notes leaking to non-admins via RSC props.
- Gave the service-note input an accessible name.

### Notes
- Database: adds migration `20260714184046_add_unit_table`. In production the
  `Unit` table was created and seeded via `prisma/manual/2026-07-14_add_unit_table_prod.sql`
  (idempotent) rather than `db:seed`, to avoid touching the admin account.
- Additional migrations in this window add the `ServiceQueueItem`, `ItemEdit`,
  `Signature`, and `ItemAudit` tables and the `dueAt`/`overdueAlertedAt` timer
  columns on `Transfer` and `ServiceQueueItem`.
