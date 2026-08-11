# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## 2026-08-11

### Added
- **The fleet export can now import itself.** Dropping the MDM export in the Downloads folder is all that is needed — a scheduled job picks up the newest `items*.csv`, imports it, and deletes it. The browser's `items (1).csv`, `items (2).csv` naming is handled: the newest one wins. Nothing changes about what an import does, only about who has to click through it; the interactive *Import items* page is untouched and still there.

  It refuses to send a file that is still downloading, and it **only deletes an export the server confirmed it imported** — a rejected or failed import leaves the file where it is and tries again a few minutes later. Everything it does is written to a log, since the CSV itself is gone afterwards.

  **This is the direct push (`POST /api/items/import`), not the Google Drive relay.** The relay exists only for the workstation whose web filter blocks the app; where the app is reachable, this is the shorter path and puts nothing on a public link.

  #### Notes
  - New scripts in **`scripts/items-import/`** (worker, one-time setup, and a shim that keeps the recurring task from flashing a console window). `scripts/items-import/README.md` covers setup and troubleshooting.
  - Requires **`MDM_IMPORT_SECRET`** to already be set in Vercel and the app redeployed since; unset, every import returns `401`. Setup stores that value **DPAPI-encrypted in `C:\ops\items-import\`** — never in the repository, because it authenticates a write endpoint into the production property book. The run log lives beside it.
  - **`DEPLOY.md` §7 corrected:** its `Invoke-RestMethod -Form` example is **PowerShell 7 only** (`-Form` arrived in 6.1 and does not exist in Windows PowerShell 5.1, still the default shell on Windows 11). Also documented there: never let the client follow redirects, and never treat a bare `200` as proof of an import.
  - **Worth knowing before enabling it:** the import treats the CSV as the source of truth for a known device's name, home unit, category and assigned user, so an automatic import silently reverts hand edits made in the app since the previous one.
- Bulk actions for a selected or scanned batch: record an audit for every item under one signature, flag them all for service, or complete service on them all at once. Retired devices are passed over and reported rather than failing the batch.

  They live behind a **More actions** button on the selection bar at the bottom of the items list, and each one says what it did — *"Audited 47 items. Skipped 2 (retired or not applicable)."* The selection is deliberately kept afterwards, so the result stays on screen and a second action can be applied to the same batch. Recording an audit needs Administrator; the two service actions need the service-queue permission, and you only see what you can use.
- Rename a whole scanned or selected batch at once, from **More actions → Rename**: give a prefix and a starting number and the devices are named `PREFIX-001`, `PREFIX-002`, … in the order you scanned them. It shows the range before applying and refuses if any of those names already belongs to another device. Retired devices are passed over and reported rather than failing the batch, and the numbering runs consecutively over the ones that are renamed — so eight survivors of ten selected get `001`–`008`, with no gaps where the skipped devices sat. **Note:** device names come from MDM, so the nightly import will restore the MDM name — rename in Intune for a change that sticks. The item page's *Previous names* section will show the name you set.
- The `/items` selection now survives a reload, a screen lock and a re-login. A batch scanned over several minutes is no longer lost, and the selection bar shows when it was started. Selections are capped at 500 items, matching the limit bulk actions already enforced.

  **The 500 limit is a hard stop while you scan, not a surprise at the end.** Once there is no room left the scanner refuses the next code with an error beep and says *"Selection is full (500) — not added"*, so nothing you hear "Added" for can go missing when you tap Done. Remove a row from the list, or apply an action and clear the batch, and scanning carries on.

- **Two confirmations before something irreversible.** *Record audit* now asks first, naming how many devices and which signature it will sign as — it writes an accountability record for every device and cannot be undone. *Clear selection* asks before discarding a batch of more than 20, which now takes a re-scan to rebuild rather than a moment.

### Changed
- **The dormant-device export is now a colour-coded Excel file instead of a CSV.** Every row is shaded so the sheet can be worked down without reading a single date: **red** if the device is not compliant, otherwise **orange** at 60–90 days since its last MDM check-in and **yellow** at 30–59. Non-compliance wins, so a device out of policy is red however recently it synced — on the current fleet that is 82 of the 86 devices listed, which is rather the point: those are the ones to pick up first.

  The sheet gains a **Compliance** column showing the value exactly as MDM reports it (`compliant`, `noncompliant`, `inGracePeriod`), so a red row says why it is red. A legend under the data names each colour, and the header row stays frozen while you scroll. A device **in a grace period is not red** — Intune means "out of policy but not yet enforced" by that, so it keeps its age colour; likewise a device the export says nothing about.

  Everything else is unchanged: the same devices, the same 30–90 day window, the same exclusions, the same cap and the same warning when it binds — except that a capped sheet now says so **inside the file** as well as on screen, since the file is what gets mailed on. The button reads **Export Excel**; every other chart on the dashboard still exports CSV.

  #### Notes
  - Adds `write-excel-file` (MIT). The workbook is built on the server, so nothing new reaches the browser bundle.

- **Marking devices on hand no longer clears the selection.** It used to empty the batch on success, which was harmless when the selection vanished on reload and is not now — a scanned sweep is worth keeping, and clearing it also took away the *"Marked 47 items on hand."* message before it could be read. Every control in the selection bar now keeps the batch; *Clear selection* is the one way out.

- **The Import items page now documents the lastSync column, and says what happens without it.** The downloadable template has carried `lastSync` since the column shipped, but the on-page column list stopped at `compliance`, so nobody building an export had any reason to include it. It is now listed with its accepted spellings (`lastSync`, `Last Sync`, `lastSyncDate`, `lastSyncDateTime`), alongside a note that it is *when MDM last checked in* rather than *when a person last signed in*, that the two routinely disagree, and that the dashboard's "devices MDM has not seen recently" list stays empty until the file carries it.

- **The dormant-device list on the dashboard now measures the last MDM check-in instead of the last sign-in.** It used to ask *who has nobody signed in to for 30–90 days*; it now asks *what has MDM not heard from for 30–90 days*, which is the question you chase a missing device with. A machine sitting unused on a shelf still syncs every night, so it no longer clutters the list — and a machine that has genuinely dropped off the network shows up even if the last person to use it signed in yesterday.

  The card and the exported spreadsheet say so throughout: *N devices MDM has not seen recently*, and the sheet's **Last logon date** / **Days since logon** columns are now **Last sync date** / **Days since sync**. **Last logon user** stays — the person MDM last saw on the device is still who to ask about it.

  **Expect a small list at first.** A device only has a sync time once an import has recorded one, and that has only been imported since 10 Aug — so devices no import has covered since then are not counted yet, the same way a device MDM has never seen has never been counted. The list fills in as imports run. Everything else about it is unchanged: over 90 days is still excluded, so are retired devices and anything out on an open hand receipt.

  #### Notes
  - Migration `20260811150000_item_last_sync_at` adds the nullable `Item.lastSyncAt` column (the last-sync text parsed to a real timestamp), its index, and a best-effort backfill of the sync times already stored. **Apply it to Supabase before merging**, per migrate-before-push: Prisma enumerates every column in its SELECT, so until the column exists *every* item read fails, not just the dashboard.
  - Sorting the **Last sync** column on the items list is still not available — the change makes it possible but does not wire it up.

### Removed
- **Home units are no longer guessed from a device's name.** The import used to read a device name like `HI-DCSIM-LT-001`, look for a piece of it that matched a known unit, and fill in the home unit when the spreadsheet left that column blank. It no longer does. A device's home unit comes from the **homeUnit column** in the spreadsheet, or from editing the device in the app — and stays blank otherwise.

  **It was doing more harm than good.** A re-imaged device comes back named `BE-2AD6890X7IOL`, and at some point someone had told the importer that `BE` was a unit — using the very screen that asked them to. So those devices had their home unit rewritten to "BE": **18 of them**, one previously *Safety Office*. Against that, the last full import guessed **one** home unit correctly. The export already carries a real home unit for about 85% of devices, so the feature was inventing values for the rest out of a computer name.

  **The damage was also self-sustaining, and about to get much worse.** Once a device had been renamed to `BE-…`, every later import read `BE` back out of that name — so it could never recover on its own, and repairing a home unit by hand did not stick. The 18 have since been put right, but **82 devices still carry an autogenerated name**: measured against the live property book, the next import would have set every one of their home units to `BE`, **overwriting a real unit on 67 of them** and filling in `BE` on the 15 that were blank, the just-repaired devices among them.

  Renaming a device properly in Intune remains the real cure, and the *Needs rename in Intune* worklist is there to work through them.

  **What went with it:** the step in *Import items* that asked you to name a unit for each device name it could not decode, and the "N units auto-detected" line in the import summary. Nothing else about importing changed, and units themselves are untouched — you still manage them on the Units page, which lists **Devices with no home unit** so you can see exactly which ones need one.

### Fixed
- **The exported dormant-device sheet had unreadable column headings.** The header row was meant to be white on the dark ledger colour and came out black on it — the spreadsheet library renamed that property and silently ignores the old name, so the file was valid, the colours on the data rows were right, and only the headings were affected. Re-export to get a readable one; nothing about which devices are listed has changed.

- **Flagging a batch for service no longer forgets which hand receipt a device came in on.** An item flagged from the receipt builder carries that receipt, and the item page shows it; re-flagging the same device as part of a scanned batch used to blank that link permanently. A batch flag now says nothing about the receipt rather than erasing it.
- **Completing service on a batch no longer touches retired devices.** A retired device's open ticket was being closed and counted among the devices completed. It is now passed over and reported alongside the other skips, matching the other bulk actions. Clearing a stale ticket off a retired device is still possible one device at a time, from its own page.

- **A device's name is no longer replaced by a random one after it is re-imaged.** When a device is re-enrolled, MDM gives it an autogenerated name like `BE-7J5AKRNFLP6B`, and the import treated that as the truth — so a device called `NGHINBPMACN128` simply became `BE-7J5AKRNFLP6B` overnight. The import now keeps the name you gave it and records what MDM wanted instead. The item's page says so: *MDM calls this device BE-XXXX — rename it in Intune*. Rename it there and the note clears itself on the next import.

  **The same problem was quietly wrecking home units.** A device's home unit is worked out from the start of its name, so `BE-2AD6890X7IOL` matched a unit called `BE` and the device's home unit became `BE`. **18 devices are in that state now**, one of them previously `Safety Office`. Keeping the real name fixes this too, because the home unit is worked out from the real name again.

  Nothing is withheld where there is nothing better to keep: a device that already carries an autogenerated name, one with no name at all, and anything brand new to the property book all take whatever MDM calls them.

  **There is a worklist for them.** *Sort & filter* on the items list has a **Needs rename in Intune** tick box, so you can pull up every device waiting on a rename and work through them. The button reads back *· Rename* while it is on, so a list showing 3 devices out of 1,200 always says why.

  **Only devices that are about to lose a good name are flagged.** A device that already carries an autogenerated name is not — nothing is being taken away from it, and there are 82 of those, which would bury the handful actually changing. A flagged device stays flagged until it is renamed in Intune, and if MDM changes its mind about what to call it in the meantime, the note follows the newest name rather than leaving you hunting for one MDM has abandoned.

  **The item page can now tell you what a device used to be called.** A *Previous names* section appears on any device with a naming history worth showing. It gives the real name an autogenerated one replaced — which is what to type back into Intune — and, for a flagged device, the earlier names MDM asked for and moved on from. A long list there means the device has been re-enrolled repeatedly and nobody has renamed it yet.

  #### Notes
  - Migration `20260811000000_item_mdm_proposed_name` adds the nullable `Item.mdmProposedName` column. No backfill — every existing row means "no conflict", which is the correct starting state. **Apply it to Supabase before merging**, per migrate-before-push: Prisma enumerates every column in its SELECT, so until the column exists *every* item read fails, not just the new feature.
  - The junk `Unit` row named `BE` was deleted and the 18 contaminated home units cleared in the same pass. That deletion is what stops the contamination recurring for devices whose stored name is *already* autogenerated — the rename guard alone does not cover them.

- **"Already scanned" now waits three seconds and says which device.** A barcode is re-read many times a second while it sits under the camera, so the message confirming what you just added — *Added HP ProBook 650 G5* — was replaced almost immediately by a bare *Already scanned* that named nothing. A successful scan's message now holds for three seconds before any repeat notice can replace it, and a repeat reads **"2TK94709FN already scanned"** so you can see which label the camera is still pointed at.

  During those three seconds a repeat of a *different* device is silenced too. That is deliberate: on a sweep the camera is moving from one label to the next, not revisiting a third. The "Selection is full" refusal is not affected — it still speaks immediately, because a scan it refuses is one that would otherwise be lost.

## 2026-08-10

### Added
- **Scanning now collects items instead of jumping to one.** The Scan button on the items list used to open the first device it read and close the camera. It now keeps the camera open and lists everything you scan at the bottom of the screen, so you can work down a shelf with the kit in your hands. Tap **Done** and everything you scanned comes back **selected** in the list — ready for Create receipt, Print QR codes, Mark as on hand or Set category, exactly as if you had ticked each row.

  A **retired** device is listed and clearly marked but is not selected, matching the list itself, where retired rows can never be part of a bulk action.

  A serial that **is not in the book** is flagged as you scan it rather than ending the session. On Done, anyone who can manage items gets one form to create them all at once, with make and model already filled in from the label where the code carries them. These are created without a device name, so **they have no home unit until one is added** — the form says so. Once you submit, the sheet tells you how many were actually created and how many already existed under that serial, before it closes — it no longer just vanishes.

  Caught a neighbouring label by mistake? Each row in the list has its own **Remove** button, so you can drop it without losing anything else you scanned or clearing the whole session. The label can be scanned again right after.

  Scanning the same item twice now says so — **"Already scanned"** — instead of silently doing nothing, so a re-scan reads as acknowledged rather than as a broken scanner.

  A category typed while creating an unknown serial now joins the managed category list, exactly like every other place an item's category can be set.

  **Scanning a Dell's Express Service Code barcode creates the item under its Service Tag.** The two barcodes sit a centimetre apart on the same label and hold the same value written two ways — the 11-digit express code, and the 7-character tag Dell actually calls the serial. The tag is what the fleet export carries, so an item created under the express code would match nothing on the next import, and that import would add a *second* entry for the same laptop. Whichever of the two barcodes you scan, the item is now created under the tag. Looking a device up is unchanged: both forms still find it.

  **Scan just one device and Done opens it**, instead of handing you a selection of one. The button says so — it reads *Open 2TK94709FN* rather than *Done · 1 item* — so looking a single device up is still scan, tap, done. Scan a second and it goes back to building a selection; there is no mode to set, it simply follows what you scanned. A retired device opens too, since "why is this on the shelf" is exactly what a single scan usually asks. The one exception is deliberate: if you had already ticked rows before scanning, Done adds to that selection rather than navigating away and quietly discarding it.

### Changed
- **When a device appears twice in one import file, the most recently seen record now wins.** A device that is re-imaged and re-enrolled shows up twice in the MDM export under the same serial: the live record, and a stale enrolment nobody removed. The import previously kept whichever copy came first in the file and ignored the rest.

  That was only ever right by luck. The export happens to be sorted newest-first, so "first" and "newest" were the same row — but nothing checked that, and nothing would have told you if it changed. A different export tool, or someone sorting by device name, and the import would have quietly started writing **months-old** device names and last-logon users into the property book, with no error anywhere. On the current fleet export there are **29 such devices**, every pair disagreeing, the two records between 4 and 208 days apart.

  The import now picks the copy with the newest last-logon date, whatever order the file is in, and the device is renamed to that record's device name — recorded in the item's history like any other name change. Where the export gives no usable date, or the dates are identical, it keeps the first copy exactly as before. A copy that could not be used at all — a *new* serial whose newest row is missing make or model — never wins, so this can't drop a device that would previously have been created.

  On today's export this changes nothing: the same 29 rows are skipped and the same records are kept. It is a guard against tomorrow's export, not a correction to this one. The skipped list now says which case applied, and comes back ordered by row number so it reads against the source file.

- **Approving *Grant Administrator* now makes the person an administrator.** The permission was called *Administer the application* and behaved like the eight beside it: approving it added one permission to whatever the account already had. So approving it for a viewer produced someone who could manage users and change the access PIN but could **not** create a hand receipt, manage items or open analytics — and the Users page still listed them as a plain user, because that page shows the role. It now changes their role to Admin, which confers everything, and the Users page shows **Admin** straight away.

  The permission is renamed **Grant Administrator** on both the request form and the approval page, and both now say plainly that it changes the person's role rather than granting one more permission. Nothing else about deciding changed: it still starts unticked so granting it is deliberate, an administrator still cannot decide their own request, and denying it leaves the account exactly as it was.

  **If you approved one of these before today**, the person is in the half-granted state described above — their role is unchanged. Fix it from the Users page with *Make admin*.

- **Explaining why you need a permission is now optional, and any length.** The request form refused anything under 20 characters, so a perfectly good reason — "taking over returns" — could not be submitted, and people padded text to get past it. Write as much or as little as you like, or nothing at all. The box is marked *(optional)* and says a line of context helps but to leave it blank if you have already spoken to the administrator.

  For administrators, a request filed with no reason now reads **No reason given** on the *Permission requests* page rather than an empty pair of quote marks, so you can see the reason is absent and decide accordingly — including denying it and asking for one. Nothing else about deciding changed: withholding a permission still requires a reason, and that reason is still shown to the requester.

- **The service queue's sorting now works exactly like the items list.** The queue's toolbar carried a *Service type* dropdown, a *Sort by* dropdown and a separate Asc/Desc button side by side; on a phone those wrapped into rows of controls above the first device. They are now behind a single **Sort & filter** button, the same one `/items` already uses, which shows what is currently applied — "Sort & filter · Due ▲ · Repair" — so you can still read the order and the active filter without opening anything.

  Tapping it opens a panel holding **Service type**, **Sort by** and **Direction**. On a phone the panel slides up from the bottom of the screen with a **Done** button, and each dropdown opens the usual iPhone picker wheel; on a computer it drops down under the button. Picking something applies it immediately and the panel stays open, so you can set the filter and the order in one visit. It closes on tapping outside, Escape, or Done.

  Nothing about the sorting itself changed — the same five columns are sortable, the same "no timer sorts last" rule applies to Due, and your choice is still remembered between visits. The queue offers no "Then by" second sort, unlike the items list, because it sorts on one column.

### Added
- **Devices now show when MDM last synced with them, alongside when someone last signed in.** The property book already carried a *Last logon date* — when a **person** last signed in to the device. It now also carries **Last sync** — when **MDM last checked in** with the device. They answer different questions and routinely disagree: a laptop sitting powered on in a cage syncs every night with no logon for months, while one somebody took home may show a recent logon and no sync since. Read together they distinguish a device that is alive but unused from one that has genuinely dropped off the network.

  It is filled from a **`LastSync`** column in the MDM export (`Last Sync`, `last_sync`, `LastSyncDateTime` and `LastSyncDate` are all recognised). A file without that column imports exactly as before and leaves the field blank; a blank cell leaves whatever is already stored untouched, like every other imported column. The downloadable CSV template includes the column and an example value.

  It appears on the device page under *Last sync date*, in the **More** panel on the items list on a phone, and as a **Last sync** column on the items list on a computer — which you can hide from the *Columns* menu like any other. The value is shown exactly as the export wrote it, so it matches what you see in MDM.

  Two deliberate limits. **You cannot sort or filter by it**, because it is stored as the export's own text rather than a real date, and ordering that text would put `10/1/2025` before `7/25/2026` — a wrong answer presented confidently is worse than no sort at all. And a change to it is **not** recorded in a device's edit history: MDM syncs almost every device most nights, so logging it would add about 1,200 history entries a night and bury the custody changes the history exists to show.

  **Note:** adds a nullable `Item.lastSyncDateTime` column (migration `20260810140000_add_last_sync_date_time`). Additive and safe to apply before deploy; no backfill — the field stays blank on every device until the next import carries the column.

- **Readiness analytics can now export the devices nobody has signed in to — a chase list of everything last used between 30 and 90 days ago.** A card sits under the unit filter showing how many devices are in that window, with an **Export CSV** button beside it. The sheet opens in Excel and carries what you need to go and find each one: serial, device name, make, model, category, home unit, UIC, current holder and position, storage location, the last user to log on, the date they did, how many days ago that was, and the device's current readiness.

  **This counts the last *user sign-in*, not the last MDM check-in.** They are different questions and routinely disagree — a laptop sitting powered on in a cage checks in with MDM every night while nobody signs in to it for months. This list finds devices that are not being *used*; it is not a list of devices that have dropped off the network. *Last sync*, added the same day, is the column that answers that one.

  **Devices with no sign-in for more than 90 days are deliberately left out.** They are a different problem needing a different response, and folding them in would bury the devices still worth chasing under a backlog nobody clears. Two other groups are also excluded, each for a reason: a device **nobody has ever signed in to** — or whose logon date could not be read — is not "last used 45 days ago" but "we cannot say", so it does not belong on a list of devices to go and check; and a device **out on an open hand receipt** is already accounted for by that receipt, where an absent sign-in is expected rather than a warning sign. Retired kit is out too, as it is everywhere else on this page. A device whose receipt has been closed, or whose line has come back, counts again.

  The export follows whatever unit filter the page is set to, and the filename says which slice it came from — so `stale-devices-30-90d-alpha-co.csv` is self-describing once it has been mailed on. The count on screen and the rows in the file are produced from one rule, so the two cannot disagree about *which* devices belong on the list. If you leave the dashboard open for hours before exporting, the file can differ from the count by a device that crossed the 30- or 90-day line in the meantime; reload the page if you want the two to match exactly.

- **A fallback way to import the fleet export: collect it from a Google Drive link on a schedule.** This is an **alternative, not a replacement** — posting the CSV straight to the app is still the primary import path and is preferred wherever it works, because the file never leaves the network it was produced on. Use this only where that is impossible: the workstation producing the MDM export cannot reach this application at all — the government network's web filter refuses the domain — so there was no way to get the CSV in from where it is produced. The export can now be published to Drive from that side instead, and the app collects it every morning by itself. Nobody has to carry the file to another computer.

  It only imports when the export has actually **changed**. The file's contents are fingerprinted, so re-running against last night's export does nothing at all rather than churning the whole property book — and a run that finds nothing new says so plainly instead of reporting a silent success.

  **If the Drive file is ever turned off, deleted, replaced, or starts asking whoever opens it to sign in, the import fails loudly.** That case is worth calling out: Google answers an unreadable link with a web page rather than a plain error, and a web page read as a spreadsheet looks exactly like "nothing changed" — so without this check the import would have gone on reporting success every morning while quietly importing nothing, and the property book would have drifted out of date with no sign anywhere that it had stopped working. Both shapes are caught: a deleted file (which answers with a clear error code) and a page served as though nothing were wrong.

  Imports collected this way are attributed to the same automated account the existing machine import uses, so they never read as a person's edits, and everything else about importing is unchanged — the same columns, the same rules about which rows update and which are created, the same item history.

  #### Notes
  - Set **`DRIVE_CSV_URL`** in Vercel to the Drive file's direct-download URL, then redeploy. Left unset, the scheduled run does nothing and reports the misconfiguration as a failure rather than passing quietly. See `DEPLOY.md` §8.
  - Migration `20260810000000_import_batch_source_hash` adds the nullable `ImportBatch.sourceHash` column. No backfill — existing rows keep NULL and are simply never treated as a Drive import. Apply it to Supabase **before** merging, per migrate-before-push.
  - Scheduled from `.github/workflows/drive-import-cron.yml` at 09:17 UTC, alongside the existing nightly purge, and authenticated with the existing `CRON_SECRET`. It can be run on demand from the Actions tab.
  - The publishing side is scripted too: `scripts/drive-upload/Upload-FleetCsv.ps1` replaces the linked file's contents from the exporting workstation, authenticating as a Google **service account**. It updates in place and has no create path, so the "always replace, never re-upload" rule cannot be broken by accident. Verified on Windows PowerShell 5.1 with a P12 key — PowerShell 7 is not required. Setup and troubleshooting: `scripts/drive-upload/README.md`.
  - ⚠️ **The linked Drive file is shared "anyone with the link", so the export is readable by anyone holding that URL** — the whole property book, including serials, units and the assigned-user names and email addresses, in one download. This was an explicit decision taken because the direct paths were blocked; the tradeoff and the two ways out of it are recorded in `docs/SECURITY.md` under *Known gaps & accepted risks*, item 0g.

- **You can ask for permissions, and say why.** Your account page now lists what you can do today, and lets you request anything you do not have — tick what you need, write one explanation covering the lot, and send it. Asking for full administrative control is possible but marked in red, with a line saying what it actually hands over.
- **Administrators decide a request by unticking what they are not granting.** A new *Permission requests* page under the Dashboard shows who asked, when, and their reason, with everything pre-ticked except full administrative control — which always starts unticked, so granting it is a deliberate act. Untick anything you are withholding and the page asks you for a reason, which the requester sees. The button says what you are about to do: *Approve 2 of 3*, or *Deny all*.
- **You are told what happened, line by line.** Your account page and the emailed outcome both show each permission with a green tick or a red cross and the word Approved or Denied beside it, so a partly-granted request reads correctly instead of as a flat "decided". If anything was withheld, the reason appears once underneath.

  #### Notes
  - Migration `20260810120000_permission_requests` adds the `PermissionRequest` and `PermissionRequestItem` tables. No backfill — there is nothing to migrate.
  - Apply the migration to Supabase **before** merging, per migrate-before-push.
  - **An administrator cannot decide their own request** — another administrator has to. If you are the only administrator, grant yourself capabilities by changing a role from the Users page instead.
  - The outcome email goes through the existing sender; if `GMAIL_*` is not live in production it is logged rather than sent, and requesters will only see the outcome on their account page.

### Fixed
- **Scanning an HP service label said "Not an item code".** Two separate things were wrong, and both are fixed.

  **The scanner only ever looked at one code per glance.** An HP label is not one code — the QR square sits within a centimetre of the serial barcode and the product-number barcode, so the camera sees several at once and the reader decides which order they come back in. The scanner took whichever came first and ignored the rest, so on a crowded label the code it needed was routinely thrown away before anything looked at it. It now considers **every** code in view and uses the first one it can actually resolve, which also makes scanning a busy label faster — you no longer have to frame the QR alone.

  **HP's QR is not a bare serial.** It holds several labelled fields at once (`SN:2TK44202X4;PN:…`), and the whole thing was being checked against the shape of a serial, which it never matches. The serial is now read out of that field list — but **only** from a field actually named as one (`SN`, `S/N`, `Serial`, `Serial Number`), never by picking a serial-shaped fragment out of the payload. A product number is shared across thousands of machines, so guessing would mean confidently opening the wrong device's page rather than admitting it could not read the label.

  **"Not an item code" now tells you what it read.** The notice quotes the codes the camera actually decoded, so a label we do not yet understand can be read off the screen and reported instead of being a dead end. If your label names its serial field something other than the four spellings above, this is what will show it.

  Nothing about the codes that already worked changed: our own stickers, Dell service tags and Dell Express Service Codes scan exactly as before.

## 2026-08-09

### Fixed
- **The home unit in an item card's *More* panel wrapped onto a second line on smaller phones.** It is meant to shrink just enough to sit on one line, and it did on a 390px screen — but on a narrower one, or on any phone where Safari's page zoom or a larger text setting leaves less room, the longest unit names ran onto two lines anyway. The sizing was estimating the text from its character count, which charges a space and a comma as if they were capital letters; unit names are full of both, so it ran out of room early and stopped shrinking while there was still space on screen.

  It now estimates the real width of the text, so the unit fits on one line — measured across every home unit in the property book at 320, 360, 375, 390 and 430px, in both Chrome and Safari. **The label and the value stay on the same line, and every value in the panel starts in the same place**, so the rows read as a column rather than as separate facts. A name longer than anything currently in the book still wraps rather than shrinking to nothing.

  The room for that came from the labels: they are a touch smaller and tighter, and the two logon rows now read **Logon user** and **Logon date** rather than *Last logon user* / *Last logon date* — the item page still spells them out in full.

  #### Notes
  - No database, environment or deployment change.
  - **On the narrowest phones (320px wide, e.g. an iPhone SE — or any phone where Safari's page zoom or a larger text setting leaves less room) the longest few unit names still wrap.** Fitting those beside the label would mean text too small to read; they are the exception, not the rule.

### Added
- **You can create your own account.** The sign-in page now offers *Create one*, and there is a sign-up form at `/register`. You confirm your email address by clicking a link we send you — until you do, signing in is refused and tells you so, with a button to resend the link. A brand-new account is **read-only**: it can look up equipment and see the hand receipts you are named on, and nothing else. Issuing hand receipts, editing items and processing returns are separate permissions an administrator grants.
- **A hand receipt list at `/receipts`.** There has never been one — receipts could only be reached by number, by an emailed link, or from an item's history. Signed-in staff who can see all receipts get every receipt, newest first; everyone else sees only the receipts they are named on, so the page says which of the two you are looking at rather than leaving an empty list ambiguous. Non-administrators get a **Receipts** tab; administrators reach it from the Dashboard, because a sixth tab starts truncating labels on a phone.

### Changed
- **The contact book on the Users page now starts collapsed.** The page opened with the user list, then the whole contact book laid out underneath it — a six-field *Add a contact* form and a row for every saved recipient — so on a book of any size the page was mostly not about users. It is now a single *Contact book (N)* control at the bottom, showing how many recipients are saved; opening it reveals the same add form and the same table, unchanged. Nothing about contacts themselves changed, and receipts still file their recipients into the book automatically, so most people never need to open it.
- **Signing in is no longer labelled staff-only.** The navigation said *Staff sign in* and the home page said *Staff log in*; both now just say sign in and log in, and the home page's description of who the app is for no longer claims accounts come only from an administrator.
- **The *Columns* button is gone on phones.** On a phone the items list and the service queue are cards, not a table, and the card shows a fixed set of details — so the ten checkboxes behind *Columns* changed nothing you could see. It was a full-width button at the top of both lists doing nothing; the space now goes to the list. On a laptop or desktop it is unchanged and still hides and shows columns.
- **The home page no longer offers *Create account* as its own button.** Creating an account is a step inside signing in — the sign-in page still ends with *Don't have an account? Create one*, and the explanation further down the home page still links to it. The home page's row of buttons is now the two things you actually choose between: enter the access PIN, or log in.

  #### Notes
  - No database, environment or deployment change. `/register` itself is untouched and still reachable.

  #### Notes
  - Migration `20260809120000_email_verification` adds `User.emailVerifiedAt` and the `EmailVerificationToken` table. **Every existing account is backfilled as already confirmed** — without that, everyone would be refused sign-in on deploy, waiting for a confirmation email they never received.
  - Apply the migration to Supabase **before** merging, per migrate-before-push.
  - Confirmation email goes through the existing sender. **If the `GMAIL_*` variables are not live in Vercel production, the mail is silently logged instead of sent** and nobody can finish signing up — check them before announcing this.
  - Registration is Turnstile-challenged, so the Turnstile variables must be present in production too, and the app must be **redeployed** after setting them (the site key is inlined at build time).

### Fixed
- **Swiping an item card open no longer springs shut when the list is scrolling.** On a phone, dragging a card leftward to reveal its actions worked from a standstill but failed whenever the list was moving or the finger drifted downward as it went: the card followed the finger part of the way and then snapped back to closed on its own, as though the swipe had been refused after the fact. The cause was that the browser and the app were both laying claim to the same touch — the card is allowed to scroll vertically, so once the finger showed any downward travel the browser took the gesture over for scrolling and withdrew it from the app mid-swipe, and a withdrawn gesture is returned to where it started. The app now holds on to a touch it has already committed to as a sideways swipe, so the card stays where the finger puts it. The service queue's cards get the same fix — both lists share the gesture.

  Scrolling and zooming are deliberately untouched. A drag that is mostly vertical still scrolls the list exactly as before — the app only claims a gesture it has already decided is a swipe — and a second finger arriving mid-swipe is still a pinch, so a serial number can be magnified while a card is part-way open.

## 2026-08-08

### Added
- **Permissions are now granted one at a time, instead of only as "admin" or "not admin".** Access is decided by nine named capabilities — viewing inventory, viewing all hand receipts, creating hand receipts, editing an item's holder, managing items, managing the service queue, processing returns, viewing analytics, and administering the application. An administrator can give one person a single capability without making them an administrator, so the technician who handles returns can be given exactly that and nothing else.

  **Nobody's access changes with this release.** Each existing role already carries a set of capabilities matching what it could do before: an administrator holds all nine, and a standard user holds the same four things they could always do — read inventory, read hand receipts, create hand receipts, and correct an item's holder and position.
- **A read-only account type.** A "viewer" can read the property book and nothing else — it cannot create a hand receipt or change an item. Nothing creates a viewer account yet; this release only makes the level exist.

### Changed
- **Signatures on audits and returns are now stored once instead of once per record.** Every time an item was marked as audited, the app saved a fresh copy of the auditor's signature image alongside it — about 12 KB each, and identical every time, because it is the same saved signature being reused. The same happened for the technician's signature on each return. Auditing the whole property book once would have written roughly 16 MB to record one signature 1,204 times, against a 500 MB database limit.

  The image is now kept once and referenced by the records that use it. Measured on a 1,204-item audit cycle, that is **16 MB before and 336 kB after — 49 times smaller**. **Nothing changes on screen:** signatures appear exactly as before on the item page, the receipt page and the DA 2062, existing audits and returns keep the exact image they were signed with, and who may view a signature is unchanged. A past audit's signature still cannot be altered or removed by editing or deleting the saved signature it came from.

  Recipient signatures on hand receipts are deliberately untouched — each of those is genuinely different, so there is nothing to save, and they are covered by the receipt seal.

  #### Notes
  - Migration `20260808150000_signature_asset_dedup` adds the `SignatureAsset` table, moves existing images into it, and removes the two inline columns. The move is verified before anything is dropped: if any row's image does not round-trip byte-for-byte, the migration aborts and changes nothing.
  - Apply it to Supabase **before** merging, per migrate-before-push — `next build` never runs `migrate deploy`, and the deployed code selects a column that will not exist yet.
  - Dropping a column unlinks the data but does not return the disk. Run `VACUUM FULL "ItemAudit";` and `VACUUM FULL "ReturnTransaction";` after deploying to actually reclaim it. Both briefly lock the table, so they cannot run inside the migration.
- **Each administrative screen now asks for the specific permission it needs**, rather than for administrator access in general. Managing items, categories and units asks for item management; the service queue and readiness ask for queue management; processing a return asks for returns; the analytics dashboard asks for analytics. User management, audits, the contact book, saved signatures, the access PIN, receipt timers and receipt seal verification continue to require full administrative access.
- **Editing an item now requires permission to do so.** Correcting a device's holder or position previously needed only a signed-in account of any kind; it now requires the holder-editing permission, so a read-only account is refused. Anyone who could edit before still can.
- **Losing a permission takes effect immediately, on the next page you load** — the same as being demoted or deactivated already did. Permissions are re-read from the database on every protected request rather than being carried in your sign-in token.

  #### Notes
  - Migration `20260808120000_capability_foundation` adds the `Capability` enum, the `VIEWER` role value and the `UserCapability` table. **No data backfill is needed** — existing accounts draw their access from their role's baseline.
  - Apply the migration to Supabase **before** merging, per migrate-before-push: `next build` never runs `migrate deploy`, so deployed code selecting `UserCapability` against a database without that table is a 500.
- **The "More" panel on each item card now shows Home unit, SLOC and the device's MDM status instead of UIC and Category.** On a phone, tapping **More** at the bottom of an item card used to open onto Holder, UIC and Category. It now opens onto **Holder**, **Home unit**, **SLOC**, **Compliance**, **Last logon user** and **Last logon date** — the last three come straight from the fleet import, so you can tell whether a device is actually being used, and by whom, without opening the item.

  UIC and Category were dropped from that panel because the card already implies the category through the make and model, and Home unit is the same fact as the UIC in words. **Both are still columns on the full table** on a computer, and both are still in the Columns menu, sortable and filterable exactly as before. Nothing changed on the item page itself, which continues to show every field.

  A long home unit is shrunk just enough to sit on one line rather than wrapping, so the panel stays scannable; a very long one still wraps rather than being cut off.

  #### Notes
  - No database, environment or deployment change — every field shown was already stored and is already visible on the item page.
  - The three imported fields are shown exactly as the fleet export wrote them, dates included; a device that has never reported one shows a dash.
  - **SLOC appears only on devices that have one.** Most do not, so it is left out entirely rather than showing a dash on nearly every card. The other rows always appear, because a missing holder or logon is worth seeing.
- **Sorting and unit filtering on the items list are now one "Sort & filter" button instead of four separate controls.** The list's toolbar used to carry a Sort by dropdown, an Asc/Desc button, a Then by dropdown and a Unit (UIC) dropdown side by side. On a phone they wrapped into three rows of controls before the first device appeared. They are now behind a single button, which shows what is currently applied — "Sort & filter · Make ▲ · 2/6 IN" — so you can still read the order and the active unit filter without opening anything.

  Tapping the button opens a panel holding all four as dropdowns: **Unit**, **Sort by**, **Direction** and **Then by**. On a phone the panel slides up from the bottom of the screen and has a **Done** button — and each dropdown opens the usual iPhone picker wheel, which is far quicker than scrolling a long list of units. On a computer the panel drops down under the button. Either way, picking something applies it immediately and the panel stays open, so you can set the unit and the order in one visit. It closes when you tap outside it, press Escape, or press Done.

  Nothing about the sorting itself changed — the same columns are sortable, "Then by" is still only offered once you have picked something to sort by, and changing the order or the unit still takes you back to page 1. The arrow marking the sorted column in the table header is unchanged, and any bookmarked or shared `/items` link keeps working exactly as before.

  #### Notes
  - No database, environment or deployment change.
  - On Safari older than version 26 the panel appears as the bottom sheet at every window size rather than as a dropdown. It behaves identically; only the position differs.

### Fixed
- **Your iPhone can now save the sign-in and offer it back with Face ID / Touch ID.** The login fields have advertised themselves to password managers correctly since 2026-08-06, but on a phone nothing was ever offered — because iOS had never been given the chance to *save* the password in the first place, so there was nothing in the keychain to fill. Signing in used to move you to the items list without the browser treating it as leaving the page, and that is precisely the moment Safari decides whether to ask "Would you like to save this password?". It never asked, so autofill had nothing, which looked exactly like the autofill being broken.

  Signing in now leaves the login page properly, so iOS offers to save the password on your next successful sign-in — and from then on tapping the email field offers the saved login. Nothing else about signing in changed: the same challenge, the same lockout rules after repeated wrong passwords, and the same page you land on afterwards.

  #### Notes
  - No database, environment or deployment change.
  - **The prompt appears on the next sign-in, not retroactively** — you have to sign in once more for iOS to capture it. If you would rather not wait, add it by hand in Settings → Passwords.
  - A password saved earlier against an old `*.vercel.app` address is stored under that address and will never be offered on `www.dcsim.us`; save it again on the current one.
  - Signing in is now a full page load rather than an in-page transition, so it may appear marginally slower on a poor connection.

### Removed
- **The `Send-MdmImport.ps1` wrapper script is gone; the scheduled fleet import now uses `curl.exe` directly.** The script existed to pre-check the mistakes people actually make and to refuse a response that was a web page rather than data, but it needed repeated repair to survive the locked-down machine it runs on — .NET calls refused under Constrained Language Mode, then redirects, then the guard being on the wrong side of a status check. `handoff/automated-mdm-import.md` now documents a plain `curl.exe` command instead, which needs no execution policy, works on Windows PowerShell 5.1 and 7 alike, and makes no .NET calls at all. **The import endpoint itself is unchanged** — same address, same secret, same behaviour.

  Two checks the script used to make are now the operator's, and the document says so in both places they matter. A response body that is **HTML rather than JSON means nothing was imported even when the status is 200** — the request was redirected to the login page, and it is the one failure that looks like success. And Task Scheduler's "Last Run Result" will now read success on a failed import, because `curl` exits 0 for any HTTP response it receives; the log file is the record to check, not that column.

  #### Notes
  - Anyone running the old script should switch to the command in §0 of the hand-off document. The script will keep working where it already sits — it is only unmaintained now — but a fresh copy is no longer available from the repository.

### Fixed
- **Tapping outside the "Sort & filter" menu now just closes it, instead of also pressing whatever was behind it.** With the menu open, a tap on the page outside it — most easily **Import CSV** or **+ Log new item**, which sit directly above the toolbar — closed the menu *and* activated that button, so you would find yourself on the import page having only meant to dismiss the menu. The first tap outside is now spent entirely on closing the menu; the control you tapped is not pressed. Tapping it again, with the menu closed, works normally.
- **The nightly import script follows redirects, and now refuses an HTML page even when the server says 200.** Two faults in `handoff/Send-MdmImport.ps1`, both of which stop the fleet import silently. It called `curl` without `-L`, so it never followed a redirect — pointing it at the bare `dcsim.us` (which permanently redirects to `www.dcsim.us`) killed the run with an unexplained `308` before anything was sent. And its guard against being handed a web page instead of data only ran when the server returned an error code. That is the wrong way round: following a redirect can land on the **login page, which answers 200 with HTML**, so the one case the guard exists to catch was the one case it could not see — the job would have reported a clean success while importing nothing. The guard now runs on every response.

  #### Notes
  - No app change, no deploy, no environment variable. This is the PowerShell script handed to whoever runs the scheduled export, so **a copy already sitting on that machine is still affected** — replace it from `handoff/Send-MdmImport.ps1`.

### Added
- **You can now scan the manufacturer's own barcode on a laptop instead of the QR sticker this app prints.** Until now the camera only read our stickers, so a device whose sticker was never applied, has peeled off or has worn illegible could only be added to a hand receipt by finding it in the items list by hand. The scanner now also reads the factory label — a Dell service tag, an HP serial, and the Code 39, Code 128 and DataMatrix barcodes those labels use. It works in two places: on the hand-receipt builder, where a scanned device is added to the receipt exactly as scanning a sticker does; and on the items list, where a new **Scan** button beside the search box opens whatever device you point it at. Our own stickers keep working exactly as before — this is an additional way in, not a replacement.

  Three things worth knowing. Dell prints two barcodes a centimetre apart — the **Service Tag** and the **Express Service Code** — and they are the same number written two ways, so scanning either one finds the same machine rather than leaving you wondering why one of them "doesn't work". If a scanned serial is in no item on the **items list**, you land on the search results for it, where an administrator is offered the usual "create this as a new item" link with the serial already filled in. On the **hand-receipt builder** a serial that matches nothing just says so and keeps scanning: it deliberately does not offer to create the item, because leaving the page would discard the receipt you are part-way through building, signature included.

  Scanning from the items list also opens **retired** devices, which the hand-receipt builder still refuses — you can look a retired machine up to ask what it is, but you cannot put it on a new receipt.

### Removed
- **The `Security docs current` CI check is gone.** It failed any pull request that changed one of a watched list of security-relevant files without also changing `docs/SECURITY.md`, and it was one of three checks required to merge. The check, the script behind it (`scripts/check-security-docs.mjs`), its test and the `npm run check:security-docs` command have all been deleted, and it has been dropped from the required checks on `main` — merging now needs `Semgrep SAST` and `Build (next build)` only. Nothing user-facing changes. What changes for contributors is that keeping `docs/SECURITY.md` current is now a convention upheld in review rather than something CI refuses to merge without: that document now carries the list of security-relevant files itself, so it is the thing to read when touching authentication, authorization, tokens, cookies, the public surface or the CI security posture.

  #### Notes
  - No migration, environment variable or deploy step. The branch-protection change was applied to the repository directly and needs no action on anyone's clone.
  - If the gate is ever wanted back, the deleted script and its watch list are recoverable from git history.

## 2026-08-07

### Fixed
- **The service queue now loads a bounded number of entries instead of every pending one at once.** It showed all of them, so the page grew with the queue rather than staying a fixed size — not a problem at today's nine entries, but it had no ceiling at all. It now loads the 200 most recently flagged. If there are ever more than that, a note at the top says so and warns that the search, filter and sort below cover only the entries shown, so an item that is missing from a search is never mistaken for an item that is not in the queue. Marking items completed brings the rest into view.
- **On a phone, the "Print QR codes" and "Columns" buttons are now the same height.** They sit side by side on the last row of the controls, and Print QR was 4px taller, so it stuck up above its neighbour. Columns was raised to match — the taller size is the deliberate one for main actions, so making it smaller would have shrunk a tap target to tidy up a row.
- **Selecting an item no longer resizes the "Print QR codes" and "Columns" buttons.** Ticking the first item made the Print button grow and the Columns button shrink beside it, and they shifted again each time the count crossed into double or triple figures. The Print button was adding the number of selected items to its own label, and on a phone the two buttons share one row of fixed width, so whatever one gained the other lost. The label is now fixed — the count is still on screen, in the bar along the bottom that reads how many items are selected and how many rows they make.
- **Press and hold on an iPhone now starts selecting items instead of opening the item.** Holding a card was opening the item page every time, which made selecting several items for a hand receipt or a QR sheet impossible by touch. The cause was iOS treating a held card as the start of *dragging a link* — the system took over the press, and by the time you lifted your finger the app only ever saw an ordinary tap. Cards no longer offer themselves to be dragged, so the hold reaches the app. There is also a backstop: a press held for half a second or more will never open the item, even if something else interrupts it. A quick tap still opens the item exactly as before, and on the service queue — where holding does nothing — a slow tap still opens the item too.

### Added
- **Items now carry a storage location ("SLoc").** Any signed-in user can see it on an item's page. Admins can also set it — from the item page, from the admin edit page, and when creating a new item — with suggestions drawn from locations already in use on other items, the same way Make/Model/UIC already suggest. It can also be filled in by CSV import, using a `storageLocation` (or `SLoc`) column; a blank cell leaves the stored value untouched on import — clearing a location is done from the item's edit form, not the CSV. The search box on `/items` now matches it too, alongside device name, make, model and serial.
- **People you fill in on a hand receipt are now saved to the contact book automatically.** Until now the contact book only filled up if an admin went to Users and typed someone in by hand, so the type-ahead on the receipt builder usually had nothing to offer and you re-typed the same recipient's rank, unit, phone number and email every time you issued them a device. Now, when a receipt is filed, anyone on it who is not DCSIM is saved — the recipient when you issue kit out, and the sender when an outside person hands kit back. Next time you start typing their name on the builder, they come up and fill in all four fields. Someone already in the book is updated rather than duplicated, so their unit and phone number stay current: their email is what identifies them, and the rest is refreshed from what you just typed on the recipient side. Three things deliberately do not get overwritten. A **rank left blank** keeps whatever is already saved, since an empty box is usually an oversight rather than a correction. A person's **name** is only ever set when they first enter the book — after that it takes an admin to change it, because the receipt records a name as one line while the book keeps first and last separately, and re-splitting a name that was already filed correctly can get it wrong. And the **sender** side only ever adds someone new, never updates: those boxes are pre-filled from the receipt the device went out on, which can be months old, so treating them as current would undo a correction someone made since. DCSIM technicians are never saved — the book is for outside people, and technicians have accounts. Everything saved this way is an ordinary contact, so an admin can correct or remove it under Users → Contact book.
- **The people on your existing hand receipts can now be loaded into the contact book in one go.** The change above only fills the book going forward, so everyone you have already issued to would have stayed missing from the builder's type-ahead until you happened to issue to them again. A one-off job now reads every receipt already on file and adds each outside person on it — recipients and outside senders both. Where the same person appears on several receipts they are added once, using their **most recent** receipt, so the unit and phone number you end up with are the newest ones on record. Someone already in the book has their details refreshed but keeps the name they were filed under. A name that is only one word is not added, since the book needs a first and a last name. Two limits: it is run by an administrator from the command line rather than from a page in the app, and it can only see receipts still on file — closed receipts are deleted 90 days after closing, so anyone who appeared only on those is already gone and cannot be recovered.
- **The admin dashboard now shows the ten most recent hand receipts.** Until now there was no way to see what had just been issued without already knowing a receipt number to search for: the dashboard listed what was overdue or due soon, which answers "what is late", not "what did we just hand out". The new card sits under the hand-receipt timers and gives each receipt's number, its items, who received it, the date it was created, and whether it is still open or has been closed — and each entry links straight through to the receipt itself. Two limits worth knowing. It is on the **admin** dashboard, so a standard user account does not see it. And closed receipts are permanently deleted 90 days after they close, so once a receipt has been closed for that long it drops off this list along with everything else.

### Changed
- **You can now tap the grooved tab on a card's right edge to open Edit, Retire and Delete — swiping is no longer the only way in.** The tab was drawn to show there was something to pull, but it ignored a finger that landed on it, so anyone who tried tapping it got nothing and had no reason to think a swipe would work either. Tapping it now slides the actions in, and tapping it again puts the card back. The tab is small on purpose — it is meant to read as part of the card's edge, not as a button — so the area that responds to a tap extends a little further in than the tab looks, which makes it comfortable to hit with a thumb. Swiping the card works exactly as before, including swiping from the tab itself. On the service queue the same tab opens **Mark Completed**. Nothing changed on a computer, where the buttons are already visible in each row, and a standard (non-admin) account still has no tab, because the actions behind it are admin-only.
- **On a phone, each item on the Items list is now a small card you tap to open.** Every item used to restack into a tall block that repeated all ten table columns as label-and-value lines, so about one and a half items fitted on the screen and you scrolled past Holder, UIC and Category to reach the next serial. A card now carries only what you need to recognise a device in your hand — the serial number as its heading, the device name with its make and model under it, and one line for readiness, status and the audit light. Everything else is still on the item's own page, and still searchable, filterable and sortable. Tapping anywhere on a card opens that item, so reaching one is a single tap rather than finding the small "View" button on it.
- **A "More" arrow at the bottom of each item card opens the rest of its details.** Tapping it drops down Holder, UIC and Category — the three things the compact card leaves off — and the arrow flips to point up so you can see which cards you have opened. It is per card, so you can leave several open while you scroll, and it works with a keyboard as well as a tap. These fields stay on the item's own page too; this just saves opening it when all you wanted was the holder. Nothing appears on a computer, where all three are already columns in the table.
- **Swipe an item card to the left to reach Edit, Retire and Delete.** Those three buttons used to sit in a row along the bottom of every block, taking up space on every item whether or not you wanted them, and Delete sat next to Retire where a mis-tap is expensive. They now stay hidden until you deliberately pull the card aside, and each is a full-height target. A small grooved tab sits at the middle of each card's right edge to show there is something to pull — it replaced an arrow, which on a phone conventionally means "tap here to go somewhere" and so pointed at the wrong thing. They are admin-only, as they always were, so a standard account has nothing to swipe. If you do not want to swipe — or cannot — tabbing into a card still slides the actions in on their own.
- **The service queue is a list of cards on a phone too.** `/admin/queue` gets the same treatment as the Items list: each entry shows the serial as its heading, the device name and its unit beneath, and one line for the service type and the due badge. Tapping the card opens the device; swiping it left reveals **Mark Completed**. There is no press-and-hold here, because the queue has nothing to select. On a computer the queue table, its search, type filter, sort and Columns menu are unchanged.
- **Press and hold an item card to start selecting items** for a hand receipt or a QR sheet. Checkboxes appear on the cards, and from then on tapping a card ticks it instead of opening it. Deselecting everything ends selection mode. The checkbox on each row is unchanged on a computer, and the buttons that act on a selection are exactly the ones that were there before. Retired items still cannot be selected. Nothing about the Items list changed on a computer: the full sortable table, its Columns menu and its per-row buttons are all as they were.
- **On a phone, the menu has moved to a fixed bar along the bottom of the screen.** The sections are now always visible as tabs with icons, instead of being hidden behind the ☰ button in the top corner that you had to open before you could go anywhere. The tab you are on is marked, so the app also tells you where you are, which the old menu only did once you opened it. Getting between sections is now one tap rather than two, and the tabs sit at the bottom where your thumb already is — this app is meant to be used one-handed while you are holding a device you are checking in or out. On a computer the same sections stay along the top of the page as they always have.
- **Service queue and Users are back as places you can reach directly.** For admins the tabs are Search, Items, Queue, Users and Dashboard. Those two had been folded into the Dashboard page in July so the menu strip along the top would not get too long — a limit a row of tabs along the bottom does not really have, and they are the two admin pages people open most. Everything else admin — Readiness analytics, Device categories, Units, Audit and New item — is still on the Dashboard, one tap from its tab.
- **Your account is now the round profile icon in the top-right corner**, on both phone and computer, instead of a menu entry. It goes to the same Account page, and it is highlighted while you are on it. Putting it there keeps it in one predictable spot and leaves the bottom bar for the sections you move between.
- **Sign out is on the Account page**, at the bottom, under Change password. It used to live inside the ☰ menu, which no longer exists — the profile icon takes you straight to it. It is on the Account page on a computer too now, in addition to staying in the header, so it is somewhere findable rather than only in a corner you may have scrolled past.

### Notes
- The recent-receipts card itself needs no migration, config, or env change: the list is one bounded query ordered by an index that already existed on the receipt table.
- Storage location DOES add a migration: new column `Item.storageLocation` (`20260807000000_item_storage_location`) — apply to Supabase **before** merging, per the migrate-before-push rule. No new environment variables.
- The contact auto-save needs no migration either, and widens who may write to the contact book: hand-editing a contact is still admin-only, but filing a receipt is not, so a standard user account now creates and updates shared contact entries. No new information is exposed — those details are already on the signed receipt — and a standard user still cannot change a contact's email (it is the key that identifies them) or delete one. A standard user also cannot change an existing contact's name, and cannot change anything at all from the sender side. Recorded in `docs/SECURITY.md` §2. A name is split into first and last on a comma if there is one ("Doe, Jane"), otherwise on the first word ("Jane Van Der Berg" saves as Jane / Van Der Berg); a name that is only one word is not saved at all, and someone who types two given names will be filed under the wrong surname until an admin corrects it.
- **Ops step for the backfill:** it does not run itself and there is no migration. Preview it with `npm run backfill:contacts`, which writes nothing and reports how many contacts would be created, refreshed and skipped; re-run with `npm run backfill:contacts -- --apply` to write. It acts on whatever database `DATABASE_URL` points at and prints that target (credentials redacted) before starting, so check the line before applying. Running it more than once is safe.
- **Known limitation:** the contact book on Users is still loaded in full, with no paging. That was fine while it only grew when an admin typed someone in; now that it grows with distinct recipients, that page will get slower as the book fills. Worth paginating before the book reaches a few thousand rows.
- The item and service-queue cards are presentation only — no query, no server action and no permission changed, and the buttons behind the swipe are the same admin-only actions that were already on each row. The Columns menu now shapes the desktop tables only; each card is built from its own cells so that hiding the Serial column cannot leave a card with no heading and no way to open the item.
- The bottom bar is padded for the home indicator on notched iPhones (`env(safe-area-inset-bottom)`), which matters because this app installs to the home screen and so has no browser chrome below it. It is hidden when printing, and sits below the QR scanner overlay rather than on top of it.
- Five tabs is the practical maximum before the labels start being cut short; measured at 375px the tabs are 72px wide and at 320px 61px, with every label still fitting. A test pins the five-item limit so a sixth cannot be added without someone deciding what to drop.

## 2026-08-06

### Added
- **The app now installs properly to a phone's home screen.** Adding it from Safari or Chrome gives you a real app icon and name, and it opens in its own window without the browser address bar. Previously iOS had nothing to work from, so it used a screenshot of whatever page you happened to be on as the icon and opened the site in an ordinary browser tab. This is presentation only — it does not add offline use. Every page still reads live custody data, and showing you a cached property book would mean showing you yesterday's holder for a device, which is worse than showing you an error.
- **Save a hand receipt as a draft.** The new receipt builder has a "Save draft"
  button beside its title. It stores everything you have entered — items, both
  parties, quantities, the return timer and any service flags — so an
  interrupted handoff no longer has to be retyped. Saved drafts appear under
  **Account → Draft hand receipts**, where you can resume or delete them.
  Drafts are private to you.
- Resuming a draft restores your typed work and warns you if any of its devices
  have since been retired or removed from inventory, keeping the rest.

### Changed
- **You now stay signed in for far longer: 7 days without using the app, and 30 days in total before you are asked to sign in again.** It was 4 hours idle and 10 hours total, which was written for a shift at a desk and did not match how the app is actually used. Anyone who had added it to their phone's home screen was meeting the login form nearly every time they opened it — a home-screen app keeps its own separate sign-in from Safari, so it never inherited a login done in the browser, and the 4-hour window had usually lapsed since the last time it was opened. Signing in twice a day on a personal phone mostly teaches people to keep the password somewhere handy, which is the opposite of the point.
- Two things worth knowing, both unchanged by this. **Deactivating an account or changing a password still ends that person's sessions immediately**, on every device — that remains the way to cut off access, and it does not wait out the 30 days. And **a longer session means more time in which a phone left unlocked is a signed-in phone**: lock your device, and tell an admin if you lose it, rather than counting on it signing itself out.

### Fixed
- **Your phone will now offer your saved email and password on the sign-in page.** Tapping the Email box should bring up the usual suggestion above the keyboard instead of nothing. The field was labelled for your device as a *contact* email address rather than as the account you sign in with, so iOS offered addresses from your contact card — or nothing at all — and never the login it had saved for this site. Nothing about the field changed for you otherwise: it still asks for an email and still brings up the email keyboard. **The first time, you have to let your phone save it**: sign in as normal, and when iOS offers to save the password, accept. There is nothing to suggest until then, so if the box still comes up empty, that is why.

### Security
- A recipient signature is **never** saved in a draft. A signature attests to a
  specific list of items, and a draft's list can change, so a resumed draft must
  be signed again before it can be filed.

### Notes
- No migration, config, or env change for the session-length and home-screen work. The session length is a code constant (`src/lib/session-freshness.ts`); existing sessions pick up the new window on their next request rather than needing anyone to sign in again.
- Drafts DO add a migration: new table `ReceiptDraft` (`20260806120000_add_receipt_draft`) — apply to Supabase **before** merging, per the migrate-before-push rule.
- Drafts are deleted automatically 30 days after they were last saved, by the existing nightly `/api/cron/purge` job. No new environment variables.

## 2026-08-05

### Security
- **Changing your password now signs you out everywhere, on every device.** Until now it only replaced the stored password: anyone already signed in as you — on a shared workstation, a borrowed laptop, or with a copied session — stayed signed in, with all of your access, for up to ten more hours. Changing your password is the thing you do when you think someone else is in your account, and it did not actually put them out. It does now. The change takes effect immediately for every existing session, including your own, so you are returned to the sign-in page and asked to sign in again with the new password; the sign-in page says why rather than looking like an unexplained logout. An admin-initiated reset and a deactivated account already worked this way — the self-service change on `/account` was the one path that did not.

### Notes
- No migration, config, or env change. `User.passwordChangedAt` already existed and is already the revocation signal read on every request.

## 2026-08-04

### Added
- **Make, model, unit and category now suggest what the property book already holds**, everywhere an item is edited — the new-item form, the admin edit page, the item detail card and the identity card. Start typing and matching values appear, most-used first; anything not on the list is still accepted, so a device nobody has logged before is never blocked. Category and Home unit suggest from the managed lists at `/admin/categories` and `/admin/units`; make, model and UIC suggest from the values already in use.
- **Admins can now permanently delete an item**, alongside Retire on the items list. It is for rows that should never have existed — a duplicate from a mistyped serial, a bad CSV import — and it asks for confirmation first, naming the device. Deleting an item removes it from inventory along with its audit and edit history. **Hand receipts are not affected:** every receipt keeps the serial number, make, model and signatures it was issued with, because a receipt records what was signed for at the time rather than looking the device up afresh. Retire remains the reversible option for a device that is simply out of service.
- **After logging an item you can go straight to it.** The confirmation screen now offers "Open this item" alongside "Add another" and "Back to items", so adding a note or printing a label no longer means searching for the device you just created.
- **The home search now shows that it is working.** Typing a serial or receipt number used to leave the page completely still until results arrived — through the quarter-second the box waits for you to stop typing *and* the round trip after it — so a search that took well under a second still read as though nothing had happened. A thin progress rule now appears under the search field and animates for exactly as long as the answer is outstanding. It is deliberately an indeterminate sweep rather than a filling percentage bar: a search has no knowable completion point, so a bar creeping toward 100% would be inventing one. Nothing about search speed itself changed — this reports the wait rather than shortening it. Screen readers announce the field as busy while it runs, and the animation is replaced by a static dimmed rule for anyone who has asked their system to reduce motion.

### Changed
- **Creating an item from a search result no longer jumps straight back to the list.** It now shows the same confirmation screen as every other path, with an extra link back to the search you came from — so both routes behave the same way and the new "open this item" choice is available from either.
- **Rank is no longer required on a hand receipt.** Both parties' Rank fields can now be left blank. The property book holds civilians, contractors and outside agency staff who have no rank, and the form previously refused to submit without one — so the only way past it was to invent a value, which then printed on a signed receipt. A receipt with no rank shows the person's name alone, everywhere it appears: on screen, in the item's custody history and on the PDF. Unit, contact number and email are still required, since those are what make a holder reachable. Existing receipts are unchanged.
- **The hand receipt builder now asks for a name as "Name (Last, First)".** The field above each party's name previously read just "Name", and receipts were being filed with the two orders mixed — "Jane Doe" on one, "Doe, Jane" on another, for people who then read as two different holders when someone searched. The field still accepts whatever is typed and nothing is reformatted, so existing receipts are untouched; the label states the convention going forward. The DCSIM technician side is unchanged, since that name comes from the signed-in account or the picked signature rather than being typed.
- **Receipt, return and pickup notices are now a single email instead of several.** Creating a hand receipt used to send a separate message to each party and another to the records inbox, and a return sent the customer one message and the records inbox a second copy of the same thing. All three notices now go out as **one message to the customer, copying** `dcsimservicedesk@gmail.com` and `ng.hi.hiarng.mbx.dcsim-hand-receipt@army.mil` — plus the records inbox and the G6 desk where those are configured. One receipt now means one email thread everyone can reply to, rather than several unconnected copies. Where a receipt is between two outside parties, both are on the message: the recipient on the To line, the other copied.
- Two consequences worth knowing. Everyone copied on a receipt can now see the other addresses on it, which was not true when each got a separate message. And because it is one message, a delivery failure can now cost every recipient the notice rather than just the one bad address; receipt and return mail still never blocks or reverses the custody change it describes.
- **`setup.ps1` accepts every value as a parameter or environment variable**, so it can run unattended or be corrected one field at a time without retyping the rest. Prompting remains the default when a value is not supplied; `-NonInteractive` turns a missing value into a clear failure naming what to provide. Secrets should be passed through the environment rather than as command-line arguments, which are written to shell history and visible to other processes; see `scripts/gmail-token-rotation/README.md`.
- **The consent wait is configurable** via `-TimeoutSeconds` on `rotate-gmail-token.ps1`. The timeout message advised raising it, but no such option existed.
- **Links in receipt, pickup and return emails — and the QR printed on the hand receipt — now open that receipt directly, skipping the access PIN prompt.** Each link carries a token scoped to the one receipt it was sent for; the PIN itself is never included in the link, and the token opens only that receipt, so the rest of the property book still requires the PIN. The link keeps working for as long as the receipt exists — a closed receipt is removed after 90 days — so forwarding the email, or handing someone the printed page, still gets them straight to their receipt.

### Fixed
- **Suggestions now appear on a phone.** The previous suggestion lists used a browser feature (`<datalist>`) that mobile browsers do not display at all, so anyone working from a handset saw nothing — which is most of the people logging devices. Coverage was also uneven: category suggested on three screens, home unit on two, UIC and make/model nowhere.
- **Page content is back to its intended width on desktop.** Every pre-existing page was rendering far wider than designed — on a 1440px-wide window the home and policy pages laid out at 1280px instead of 720px, so text ran in long lines and the content sat wider than the header bar above it. Tailwind was emitting a `container` rule that outranked the original stylesheet's own, and it did so because the word "container" appears in a component file it scans — in an attribute value and in a code comment. Tailwind is now told never to emit that rule. Narrower screens were unaffected, and nothing about the page content changed; only its width.
- **The token rotation tool's reminders never appeared.** The check that was meant to detect "notifications are switched off for this app" was itself suppressing every notification, because Windows PowerShell does not reliably report that setting and an unreadable value was treated as "switched off". It now only suppresses when Windows explicitly says notifications are disabled, and shows the reminder whenever the setting cannot be read. The old behaviour blocked the first notification raised by any process, which is exactly the one the scheduled task raises — so the every-6-hours reminder would never have fired at all.
- **A failed renewal no longer reports that mail is down.** Cancelling or missing the browser prompt was recorded in a way that made the tool report "outbound mail is DOWN" every six hours from then on, even though the credential in use still had days left. The tool now tracks when it last *succeeded* separately from when it last *tried*, so a failed attempt keeps the reminders coming without overstating how urgent they are.
- **`setup.ps1` no longer hangs when run without a console.** It now says so immediately and explains where to run it, instead of looping on an unanswerable prompt until killed.

### Security
- **The unused `nodemailer` dependency is removed.** It was the SMTP client behind the old app-password email path, which was deleted when sending moved to the Gmail API; the package was kept a little longer as a rollback route and nothing has imported it since. Removing it closes a tracked advisory covering SMTP command injection and CRLF header injection — by deleting the code rather than upgrading it, so the class of bug cannot return. No behaviour changes: nothing in the application referenced it.

### Notes
- **Rotating `AUTH_SECRET` got more expensive.** It already signed out every session and retired every unlock cookie; it now also signs the per-receipt link token baked into the QR on every already-printed DA 2062 and into the link in every already-sent receipt/pickup/return email. Rotating it permanently breaks all of those — paper already handed out can't be re-issued, and there is no per-receipt revocation lever (see `docs/SECURITY.md`, Known gap 12, and `DEPLOY.md`).
- Database: adds `20260804190000_transfer_item_nullable_item`, which lets a hand-receipt line outlive the item it points at. **Apply it to production before this merges** — a `next build` never runs `migrate deploy`, and the deployed code deletes items on the assumption the constraint has changed.
- The addresses copied on custody email ship as defaults in the code, so no configuration is needed for the change above to take effect. `RECEIPT_CC_EMAILS` overrides them as a comma-separated list; setting it to an **empty** value switches the copies off, which is deliberately different from leaving it unset (unset means "use the defaults"). Those copies carry party names, contact details and the signed PDF — see `docs/SECURITY.md` §6.
- **Mail to `army.mil` now arrives.** The long-standing silent drops were caused by the `vercel.app` link in the message body, not by authentication, DKIM or SPF — a controlled four-message test showed plain text, a `dcsim.us` link and a PDF attachment all delivered, and only the message containing a `vercel.app` URL discarded. `APP_URL` now points at `https://www.dcsim.us`, so message bodies link there. Any link added to an email in future must be built from the configured app URL, never a deploy URL, or `.mil` delivery breaks again with no bounce to warn anyone. Confirmed end to end: a hand receipt was delivered to an `army.mil` inbox with its PDF attached.
- **QR labels printed before 2026-08-04 encode the old address, but keep working in the app.** A QR code is a picture of a URL, so its origin is fixed when the label is printed — changing the app's address does not change a sticker already on a laptop. Older labels point at `servicedeskapp.vercel.app`, which the government network blocks. **Scanning them with the app's own scanner still works**, because it reads only the item path and ignores the address in front of it, exactly so labels printed before a domain change stay usable. What fails is scanning one with a plain phone camera on a government network, which opens the old address directly and appears to do nothing. Any device can still find the item by searching its serial number. Labels printed from now on carry `www.dcsim.us`. Old ones are worth reprinting eventually, but nothing is broken meanwhile — and since they look identical, the only way to tell is to scan one and see where it leads.
- The Vercel API token this tool uses should be **project-scoped**, not account-wide — Vercel supports Project, Team and Full Account scopes, and a project-scoped token cannot reach any other project and needs no team id. Earlier notes said project scoping was unavailable, which was wrong. Vercel offers no non-expiring token, so the expiry date is worth recording: when it lapses, renewal fails loudly with a 403 rather than mis-sending mail.

## 2026-07-31

### Added
- **Tooling to keep the Gmail sender's credential alive.** `scripts/gmail-token-rotation/` is a local Windows tool that renews the Google OAuth refresh token the app sends mail with, writes it to Vercel production, and redeploys so it takes effect. It exists because the Google consent screen is deliberately left in "Testing" status, which makes Google expire that credential every 7 days; without renewal, receipt and alert email silently stops. A scheduled task checks every 6 hours and notifies when renewal is due, escalating from a reminder at 3 days to "outbound mail is DOWN" past 7. Renewing takes one click, or possibly none — the tool tries a silent renewal first and records which path worked. Nothing in production is touched unless a valid credential is actually obtained, so a cancelled renewal leaves the live one alone and does not make the warnings any more urgent than they already were.
- **The home page now explains what this application is.** Anyone who opens the site — with or without the access PIN — gets a plain description of the app: that it issues IT equipment on signed digital hand receipts, tracks who is holding each device, processes returns, lets a device be looked up by serial number or QR code, runs the service queue, and sends transactional email to the parties on a receipt. It also says who the app is for and links the Privacy Policy and Terms of Service.
- **The items list can now be searched by who is holding the device.** Typing a recipient's name into the search box on the items list returns everything that person currently has signed out — matching on first name, last name, or both, in either order, so "doe jane" finds Jane Doe. Punctuation you type is ignored at the edges of a name, so "Doe, Jane" works too. Only live custody counts: an item comes back while it is out on an open hand receipt and stops matching once that receipt is closed or the item is returned. The list also gained a **Holder** column showing that name (blank for anything nobody has signed for), so it is visible why each row matched; it can be hidden from the column menu. Devices assigned only through the MDM import, with no hand receipt, are not matched by a name search.

### Changed
- **Outbound email now sends through the Gmail API instead of SMTP.** Hand receipts, return notices, pickup notices, password resets and overdue alerts are all sent by the same Gmail account as before and look identical to a recipient; what changed is how the app authenticates to Google — an OAuth2 authorization for send-only access, replacing the account app password. This does not change whether any particular recipient's mail server accepts the message.
- **The home page is no longer behind the access PIN; the records it searches still are.** A logged-out visitor used to be redirected straight from the front page to the 8-digit PIN prompt, so the only thing the site said about itself was "Enter the access PIN" — which is why Google refused the app's branding verification. The front page now opens for everyone and shows the description above, with a button to enter the PIN. Nothing else moved: item pages, hand receipts and receipt PDFs still require the PIN, and the search box on the home page still appears only once you are unlocked or signed in. Searching without the PIN is refused outright rather than quietly returning nothing.
- **A search whose access has expired now says so.** The unlock lasts 12 hours, so it can lapse with the home page still open. A search after that point used to report "No matches" — telling someone their serial number does not exist. It now says access has expired and links back to the PIN prompt.
- **The PIN page points back to the home page.** Anyone who arrives at the PIN wall from an item or receipt link now has a way to read what the application is for.

### Security
- **Email headers are now protected against injection.** Text that reaches an email header — a subject line, a recipient address, an attachment filename — has line breaks stripped, so content drawn from item or receipt data cannot add headers of its own, such as a hidden extra recipient.
- **The account app password is no longer used or accepted.** It is replaced by a send-only OAuth authorization, which cannot read the mailbox.

### Notes
- Outbound email requires four new environment variables — `GMAIL_FROM`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` — which **must be set in Vercel production before this deploys**. Without them the app falls through to the Resend sender, which does not deliver. `GMAIL_USER` and `GMAIL_APP_PASSWORD` are no longer read and should be deleted after the deploy is confirmed working.
- Selection between the two senders is by environment-variable presence only, never by a send failure: if `GMAIL_REFRESH_TOKEN` is set but has expired, sending fails rather than quietly rerouting through Resend. The 7-day expiry itself, and the rotation tooling that keeps the token current, are described in the Added and Notes entries above — this is the same token.
- A new migration adds a trigram index on the hand-receipt recipient name, which the name search needs to stay fast. It must be applied to the production database before this deploys.
- The Gmail token rotation tool is opt-in and installed per workstation; nothing changes for anyone who does not run its `setup.ps1`. Installing it needs a **Desktop app** OAuth client in the `dcsim-hand-receipt` Google Cloud project (installed-app clients accept the loopback redirect the tool captures on), the Gmail API enabled, a **project-scoped** Vercel API token (created at `vercel.com/account/tokens` by picking the individual project in the Scope dropdown, not "All Projects" — a project-scoped token cannot reach any other project, and needs no team id), the Vercel project id, and a Deploy Hook URL targeting `main`. Vercel offers no non-expiring token, so note the expiry date: when it lapses, rotation fails loudly with a 403 rather than mis-sending mail. Secrets are stored encrypted per Windows user under `%LOCALAPPDATA%`, never in the repository.
- **Once installed, production can redeploy without a human present** — every renewal fires the deploy hook, shipping whatever is on `main` at that moment. Apply database migrations at merge time rather than deferring them to the next manual deploy; with this installed there may not be one. See `DEPLOY.md`.
- The 7-day expiry this tool works around disappears entirely if the Google consent screen is published, or if the sender moves to Google Workspace on `dcsim.us`. Both are recorded in `docs/SECURITY.md` under Known gaps.

## 2026-07-30

### Added
- **The nightly Intune export can now import itself.** A scheduled job can POST the CSV straight to the app instead of somebody opening the import page and doing it by hand. Rows whose unit abbreviation the app does not recognise still import — they come back listed in the response so an admin can teach the abbreviation afterwards.
- **A search that finds nothing can now create the item.** When an admin searches the items list and nothing matches, the empty state offers to log that device — opening the new-item form with the searched text already filled in as the serial, and returning to the same filtered search afterwards so the new row is visible. The new-item form also gained UIC and Category fields, and suggests the unit and category names already in use.

### Fixed
- **Sorting the items list by Audit status now respects the second sort you pick.** The Audit column shows one of three badges — Compliant, Overdue, Never audited — but the sort behind it ordered by the exact date and time of the last audit. Audit timestamps are very nearly unique per device (of the 31 audited devices in the catalogue, all 31 have a different timestamp), so there was almost never a tie for a second sort key to break, and choosing "Audit status, then Device name" quietly ignored the device-name part. Sorting by Audit status now groups devices by badge — compliant first, then overdue, then never audited, matching the order the analytics donut uses — and your second choice orders the devices *within* each group. Reversing the direction still reverses the whole list. Note the Audit sort no longer orders by how recently something was audited: inside a badge, the order is whatever second key you pick.
- **The import script no longer makes any .NET method call.** The previous fix replaced the four calls that a simulated Constrained Language Mode rejected, but a machine under real WDAC/AppLocker lockdown still refused the three that remained — `[string]::IsNullOrWhiteSpace` and two `.Trim()` calls, all on `String`, which a runspace-level language-mode flip allows and a locked-down host does not. They are now regex operators, so the script contains none at all. A failure inside the send now also reports the file and line it came from; previously it printed only the message, which is why the first report could not be pinpointed.
- **The import script now runs on a locked-down machine.** `handoff/Send-MdmImport.ps1` used .NET calls (`[System.IO.File]`, `[Math]`, `[System.IO.Path]`) that PowerShell refuses under **Constrained Language Mode** — what WDAC/AppLocker enforce on a managed workstation — so the script died with *"Method invocation is supported only on core types in this language mode"* before it sent anything. It now uses only cmdlets and operators, and prints the detected language mode on startup so a future failure is diagnosable from the log. The hand-off document's instruction for setting the secret as a machine environment variable had the same problem and now uses `setx`. Verified end-to-end under a constrained runspace: success path, `401`, missing file and wrong extension all behave as documented.
- **The import's "auto-detected" home unit count now reflects devices actually changed, not every device whose name still decodes.** A matched (already-in-the-fleet) row was counted as auto-detected whenever `detectHomeUnit` succeeded, even when the derived value was identical to what the item already stored — so a nightly full-fleet CSV with no `homeUnit` column, where nearly every row's device name simply still decodes to its current unit, reported roughly 1,100 "auto-detected" home units when the real number of devices filled in or corrected was a handful. The count now only increments when detection actually fills a blank home unit or corrects a different stored one.
- **Logging a new item no longer silently drops its category, and says so when the serial is taken.** A category typed on the new-item form now joins the managed category list instead of leaving the device holding a value that appeared in no picker, and the items list is refreshed so a newly created item is not missing from it. Creating an item whose serial already exists used to fail with a generic error; it now names the serial and links to the item that already has it.
- **Creating an item from a filtered search no longer returns you to an empty list.** The new-item form now prefills its UIC field from the unit filter that was active on the search, and the return trip only restores that filter when the item you just created actually carries it — otherwise the filter is dropped so the item you made is visible. Previously the UIC box was left blank, so an item created while filtered to a unit came back with no UIC set, the return trip re-applied the filter, and the list showed "No items match" for the row that was just created.

### Notes
- New environment variable **`MDM_IMPORT_SECRET`** must be set in Vercel and in the scheduled job. Unset, the endpoint refuses everything.
- A new migration seeds an **`MDM Import (automated)`** account that automated imports are recorded under. It cannot be signed in to.
- Measured: a full 2000-row all-update import takes ~0.8s locally (Docker Postgres), well inside the transaction and function-duration budgets.

## 2026-07-29

### Added
- **A Units page for admins** at `/admin/units`. Add a unit one at a time, or paste a whole block of `ABBREVIATION,Unit name` lines to add or re-teach many at once — a malformed line is reported by its line number and nothing is saved until every line parses. Correcting a unit's full name also rewrites every item currently assigned to it, and the page shows how many that will affect before you save. Removing a unit is refused while any item still uses it, naming the count.
- **`/admin/units` now shows when the fleet was last imported, and flags it when the scheduled import may have stopped running.** With a nightly automated import replacing the human-driven browser flow, nobody is watching each run — a dead job and a fleet that has simply stopped changing look identical otherwise. The page now shows the last import time and warns when it is more than 48 hours old. It also lists a sample of devices that imported with no home unit (device name recognized by no known abbreviation), with a note that these devices already exist in the fleet, so teaching the abbreviation above resolves one of them the next time it is included in an import — a device that has dropped out of the export entirely is never matched, so it is never backfilled that way; set it directly on the item's edit page instead. The disclosure heading always shows the true count of such devices, not just how many are listed — on a fleet with more than the sample size, the panel says so ("Showing the first 50").

### Changed
- **Marking a device "on hand" now sticks.** Previously an MDM logon dated after the marking flipped the device back to **Deployed** — but a device sitting on our own shelf produces those routinely (powering it on to image it, a check-in, a test before reissue), so kit we were physically holding kept reading as issued out. A marking is now overridden only by something that actually shows the device left: a service flag, an open unreturned hand receipt, or retirement.
  - **Issuing a device out is unaffected** — building a hand receipt still reads **Deployed** straight away, without waiting for the next MDM import.
  - **Devices that were never marked on hand are unaffected**, including the large majority that are deployed on MDM telemetry alone with no hand receipt.
  - The gap this leaves is handing a device to someone **without** creating a hand receipt: nothing then contradicts an older marking. Record the receipt and it behaves as before.
- **Unit abbreviations are now case-insensitive.** `WABC01` and `wabc01` are one unit, not two. Matching an item to its unit is also now case- and whitespace-insensitive everywhere the app compares them, so correcting a unit's name also folds in items whose home unit was already the right unit but spelled with different capitalization — those are counted as updated too, since they genuinely changed; an item already spelled exactly like the new name is left alone and does not add to that count.
- **The CSV importer now keeps an existing device's home unit in step with the spreadsheet, instead of only ever setting it on first creation.** A matched (already-in-the-fleet) row now gets its `homeUnit` written the same way a brand-new row does — the CSV's own `homeUnit` column, verbatim, when it has one, otherwise re-derived from the device name using the taught abbreviations — and this **overwrites** whatever was already stored. The importer is now the single source of truth for a device's home unit: correcting it by hand or via a unit rename on `/admin/units` lasts only until the next import that carries a value for that device.

### Fixed
- **A failed search no longer reports "No matches."** If the public search is temporarily throttled or unreachable it now says so, instead of telling you your serial number does not exist.
- **Resetting a password is now counted per link rather than per network.** Five people clicking yesterday's expired reset links used to lock out the sixth, who was holding a perfectly good one. The reset form also now carries the same browser check as sign-in — it is the one place where a correct guess would hand over an account outright.

### Security
- **The sign-in page still works if its JavaScript does not.** The Sign in button was being sent from the server already disabled, so any failure that stopped the page's scripts running left a form nobody could submit and nothing explaining why.
- **The staff hand-receipt builder and the return page now send you to sign in** when you are logged out, instead of the recipient PIN page or a bare "this page is for browsers" refusal. Nothing was ever accessible that should not have been — it was the wrong signpost, not a missing lock.
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
- **Migration `20260729130000_unit_abbreviation_citext` makes `Unit.abbreviation` case-insensitive.** It fails to apply if any two existing `Unit` rows differ only by letter case (e.g. `WABC01` and `wabc01`) — check for and resolve a collision like that before deploying.

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
- **Sign-in, password reset and the public PIN are now rate-limited per network.** Five *failed* attempts in fifteen minutes from the same IP and the form says to try again later, naming how long. The wait it names is real but not always a full fifteen minutes: the window decays rather than resetting all at once, so depending on when you ran out it can be as little as a minute. The public PIN is different again — one shared secret, so it is twenty attempts per network and correct entries count too. Getting it right gives the per-account attempt back, because the desk shares one internet connection and counting successful sign-ins against your own account would have taken everyone offline after five people logged in. The wider per-connection ceiling does still count successes — it is sixty, so a normal shift change is nowhere near it. Requesting a reset email is the one exception and counts every request, because mass-requesting is the abuse there. Item pages, hand receipts and the public search are separately capped at 300 requests a minute per network for **logged-out visitors** — no person browsing will reach it, a scraper will, and signed-in staff are not counted at all.

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
  history on an item's page (`/i/<id>`, whose Audit card is staff-only — the
  page itself is public behind the PIN gate), each auditor's
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

### Notes
- Database: adds the `ItemAudit` table (`20260716000000_item_audit`).

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

### Notes
- Database: adds the `ItemEdit` (`20260715000653_item_details_and_edit_history`),
  `Signature` (`20260715005357_named_signatures`) and `Contact`
  (`20260715160000_contact_book`) tables.

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
- Database: `20260714212256_item_level_service_queue` reshapes the **existing**
  `ServiceQueueItem` table (created 2026-07-13 as a receipt-level queue) into the
  item-level one — it adds the `ServiceType` enum, replaces `READY_TO_ISSUE` with
  `COMPLETED`, and moves the row's identity from `transferId` to a unique
  `itemId`. Because a receipt-level row has no item to attach to, **the migration
  deletes every existing queue row**; anything still queued at the time had to be
  re-flagged by hand.
- Database: `20260714234429_user_email_citext` makes `User.email`
  case-insensitive.

## 2026-07-13

### Added
- **A service queue for incoming hand receipts** at `/admin/queue` (admin only).
  Every receipt created lands in it automatically, grouped by the day it
  arrived, showing the receipt number, its items, the recipient and their unit.
  Clearing an entry marks it **Ready to issue when needed** rather than deleting
  it, so nothing about the receipt is lost. Routing a receipt into the queue is
  best-effort: a queue failure never fails the receipt somebody has just signed.
- **Closed hand receipts are now permanently deleted 90 days after they close.**
  A receipt's expiry is stamped at the moment it closes, and a nightly job
  sweeps the ones that have come due and removes them for good. The same sweep
  hard-deletes accounts that have been deactivated for three months or more —
  except where something that must keep its author still points at the account
  (items they logged, imports they ran), in which case the account is skipped
  rather than the record being broken.

### Changed
- **A closed hand receipt is now immutable.** Once a receipt closes it cannot be
  reopened, edited or otherwise altered; anything that would change it is
  refused. A receipt counts as closed on either signal — its status or its
  closing timestamp — so a half-written close still locks it.
- **"Notify customer — items ready for pickup" is now DCSIM-only on the server
  too.** The button was already hidden for a non-DCSIM recipient; the request is
  now rejected outright as well, so it cannot be submitted out of band.

### Security
- **Resetting a password now signs that account out everywhere.** Previously the
  reset set a new password but left every existing sign-in alive until it
  expired on its own — so the very thing a reset is for (someone else has your
  password) did not actually end their session. Sessions opened before the last
  password change are now rejected on their next request. Sessions that predate
  this change are grandfathered, and a database error lets the request through
  rather than locking everyone out.
- **The reset link no longer leaks out of the page it lands on.** The reset and
  forgot-password pages now send no referrer, and the token is stripped from the
  address bar (and browser history) as soon as the page loads, so the one-time
  link cannot travel to a third-party site or sit in a shared browser's history.
- **Requesting a reset no longer reveals whether an address has an account.**
  The lookup, token creation and email now happen after the response is already
  on its way, so a registered and an unregistered address take the same time to
  answer, and a single account can only request one link a minute. Consuming a
  token is a single atomic step, and an account deactivated after the link was
  issued is re-checked at the moment it is used.

### Notes
- New env var **`CRON_SECRET`**. The purge endpoint (`/api/cron/purge`) has no
  user session, so this shared secret is its only authentication — it is
  compared in constant time and the endpoint fails closed when the secret is
  unset. Scheduled daily at 08:00 UTC; it can also be triggered by hand with the
  same `Authorization: Bearer` header.
- Migration `20260713200631_ticket_lifecycle_and_service_queue` adds the
  `ServiceQueueItem` table, `Transfer.closedAt` / `Transfer.purgeAfter` (with an
  index for the sweep) and `User.deactivatedAt`. Migration `20260713150502` adds
  `User.passwordChangedAt`.
- The purge is genuinely destructive and has no undo — a receipt 90 days past
  closing is gone, PDF and all. The two sweeps run independently, so a failure
  in one is reported without stopping the other.

## 2026-07-12

### Added
- **The site can now be verified in Google Search Console**, via a verification
  token in the page metadata and a verification file at the site root.

### Changed
- **The browser tab and search-result listing now name the application.** The
  page title is "Hand Receipt" with a description of what it does, replacing the
  generic "Service Desk App" placeholder.

## 2026-07-10

### Added
- **Self-service forgot/reset password.** A link on the sign-in page emails a
  single-use reset link that expires after an hour; following it sets a new
  password. The request always answers the same way whether or not the address
  has an account, so it cannot be used to find out who has one. Only a hash of
  the link's token is stored — the link itself exists only in the email.
- **Device Name is now a field on every item**, required when logging or editing
  one, shown on the item page and on the QR label, and imported as its own CSV
  column. Existing items with no device name still display and edit normally.
- **The items list gained a Device Name column, a sort control and a Columns
  menu.** Device Name leads the table; the toolbar sorts by any field ascending
  or descending; the Columns menu hides the ones you do not want. Your sort and
  hidden columns are remembered on that browser.
- **Print QR labels for a whole selection.** Selecting items on the list and
  choosing **Print QR codes** opens a printable sheet — 8 labels across with the
  serial centred beneath each code, about 72 to a page.
- **"Notify customer — items ready for pickup"** on a hand receipt page. It
  emails the customer a list of the items waiting for them and reports success
  or failure inline.
- **Privacy Policy and Terms of Service pages**, linked from a new site-wide
  footer.
- **An archival copy of receipt email to a records inbox.** When
  `ADMIN_INBOX_EMAIL` is set, every new receipt and every return is copied there
  with the signed PDF attached, independently of the parties' own email — so the
  records copy still goes out when both parties are DCSIM or the customer has no
  address on file.
- **Contact numbers format themselves as you type**, as `(xxx)-xxx-xxxx`, on the
  receipt builder, the registration form and the admin new-user form. Backspace
  still works one character at a time.

### Changed
- **Customer email now says which of three things happened.** Subjects carry the
  classification and the receipt number — **NEW** for a new receipt, **UPDATED**
  for a partial return, **CLOSED** for the return that closes it — and the
  bodies are short: the items issued, the returned/not-returned split, or the
  full list at closing, each with the link to view or download the receipt. The
  regulatory boilerplate is gone.
- **The items list is wider on large screens**, so device names and the row
  actions stop wrapping. Other pages keep the narrower layout.

### Fixed
- **The return that closes a receipt no longer takes a quantity column of its
  own on the PDF.** It was drawing a column showing a zero balance *and* the
  CLOSED watermark and closing attestation for the same event. Only partial
  returns — the ones that leave a balance — get a column now.
- **The Privacy Policy and Terms pages were redirecting anonymous visitors to
  the sign-in page.** They are public pages and now open for everyone.
- **The pickup-notify button no longer disappears when the customer has no email
  on file.** It stays visible and explains why it is unavailable, instead of the
  option silently not existing.
- **The password-reset email is now sent as HTML as well as plain text.** A
  text-only message whose entire content is a tokenised link is a classic spam
  signature and was being deferred or filtered; one reset arrived in one inbox
  and never landed in another.
- The file-picker button on the CSV import form is vertically centred in its
  field.

### Notes
- A Gmail-based email sender was added and reverted the same day; sending stayed
  on Resend. (It returns for good on 2026-07-31.)
- New table `PasswordResetToken` holds only the SHA-256 hash of each link's
  token. New env var **`ADMIN_INBOX_EMAIL`** — unset means no archival copies
  are sent, which is the previous behaviour.

## 2026-07-09

### Added
- **Property returns, partial and full.** An admin opens a hand receipt, checks
  off the serials physically coming back, and the receipt records exactly that —
  a partial return leaves the rest outstanding and the receipt open; returning
  the last item closes it. Every return is written to a ledger, so a receipt
  carries the whole history of how it was cleared rather than just its current
  state.
- **The receipt page shows what has come back.** Returned items are struck
  through, a **CLOSED** banner appears once the last one is in, and a section
  below lists each return with who processed it and when.
- **The hand receipt PDF records the return history across the DA 2062 quantity
  columns.** Each return takes the next column (A is the recipient's original
  signature, B–F the returning technicians), with that transaction's signature
  and date in its own column, rather than overwriting column A. A closed receipt
  is watermarked **CLOSED**, with the accepting technician's attestation set
  parallel to the watermark beneath it. Every signed column is capped with guard
  bars so entries cannot be added to it afterwards.
- **Technician signatures.** A return cannot be submitted without the processing
  technician signing for it; the signature can be saved to their profile and
  managed from the account page, so it does not have to be redrawn every time.
  The technician who accepts a return is named on the receipt page and on the
  PDF.
- **The signed PDF is attached to receipt and return email**, and return
  notifications go to the customer with the desk copied.

### Fixed
- **Two people processing the same return at once can no longer return the same
  item twice.** Returns for one receipt are now serialised, and the closing
  stamp is written only if it is still unset — so the second attempt sees the
  first one's result instead of double-counting it.
- The "who currently holds this" lookup was reading custody from the wrong end
  of a receipt's history.

## 2026-07-08

### Added
- **Mass item import from a CSV.** An admin uploads a spreadsheet and the whole
  file is written in one transaction — either every valid row lands or none
  does. Column headings are matched regardless of spacing and capitalisation,
  rows missing required values are reported rather than silently skipped, and a
  serial that appears twice in the file is only created once. Each import is
  recorded as a batch, listed on the admin audit page with who ran it, when, and
  how many rows it created. The file size is capped so a runaway upload cannot
  be submitted.

## 2026-07-07

### Added
- **A hand receipt can now carry several items instead of exactly one.** Items
  are selected from the items list and built into one receipt at
  `/receipts/new`, where identical make-and-model items are grouped onto a
  single line with a quantity, the way a DA 2062 is actually written. The PDF
  renders every line with its own authorised and issued quantities; the
  recipient's signature and date still read up column A beneath the last row.
  A receipt is capped at 10 item lines, with the description text shrunk to stay
  inside the form's boxes.
- **Preview PDF** alongside Download, on the receipt page and straight after
  creating one — it opens in the browser's own viewer instead of downloading.

### Changed
- **Receipt email is now just the receipt number as the subject**, with a short
  body and the link on its own line, sent from a named sender rather than a bare
  address.

### Removed
- **The single-item transfer flow.** Issuing one item is now the same flow as
  issuing ten, so the item-scoped transfer page and its action are gone.

### Notes
- New `TransferLine` / `TransferItem` tables hold a receipt's lines and the
  items on them; existing single-item receipts were migrated into the new shape
  without data loss.

## 2026-07-06

### Added
- **The home search returns results as you type.** Both serial-number and
  receipt-number modes show a list of matches while typing — no Search button,
  no page reload — and clicking one opens it. Results are announced to screen
  readers, and "No matches" is held back until the search has actually settled,
  so it no longer flashes mid-word or when switching modes.
- **A staff-only detail block on the item page.** Signed-in staff see the fuller
  record — including who logged the item — while the public page keeps to what
  it always showed. A **View** action on the items list links straight to it.
- **A consistent navigation bar on every page**, scoped to the viewer's role,
  with the current section highlighted. The five separately-written page headers
  are now one component.
- **A mobile layout.** The header collapses to a hamburger menu, tables restack
  into readable cards on phones, and the viewport is declared so the site is no
  longer rendered as a shrunken desktop page.

### Changed
- **Signing out returns to the search page** rather than a dead end, and the
  sign-in page has a way back to it.
- **Item notes are admin-only.** The rest of an item's details stay visible to
  all staff.

### Fixed
- **Receipt-number search now matches as you type.** It was an exact-match
  lookup, so a partial receipt number found nothing until the last character
  was typed — unlike serial search beside it.
- The item page now reads the current holder from the item's latest completed
  receipt rather than the first one it happened to load.

### Security
- **Search results no longer carry anything the results do not show.** The
  query returns only the receipt number and item summary, so signature images
  and party details are not shipped to the browser on every keystroke.
- **The navigation bar re-reads role and active status from the database**
  instead of trusting the signed-in token, so a demotion or deactivation is
  reflected immediately rather than at the next sign-in.
- **Sensitive server modules are marked server-only**, so the database client,
  password hashing and the authorization helpers cannot be pulled into a browser
  bundle by accident. Unexpected errors in server actions now log the detail on
  the server and return a generic message.
- **The seed script no longer contains a default admin password.** It requires
  the credentials to be supplied through the environment and refuses to run
  without them.

## 2026-07-02

### Added
- **Hand receipts are now created on one device, from a shared item list.** The
  two-device handshake is gone (see Removed): a technician picks the item, types
  both parties — rank, name, unit, contact, and whether each side is DCSIM — and
  the recipient signs on the same screen. The receipt is written as a completed
  record on the spot, with both parties snapshotted onto it so later edits to an
  account cannot change what the signed document says. The next receipt for an
  item pre-fills its sender from whoever last received it.
- **Public hand-receipt lookup.** Anyone holding a receipt number can find the
  receipt, read it, and download its PDF without signing in — the point being
  that the recipient is usually not a staff member.
- **A public item page and item QR labels.** Each item has a page at `/i/<id>`
  and a printable QR label pointing at it, so a code stuck to a laptop leads to
  that laptop's record. Admins get the printable label pages.
- **Home search with a mode dropdown** — look up by serial number or by receipt
  number from the same box. Serial results are capped at 50.
- **Sequential receipt numbers.** Receipts are numbered `HR-000001` upward from
  a database sequence, replacing the random identifiers issued earlier in the
  day, so the numbering is legible and gapless.
- **Receipt email.** A receipt link is emailed to the parties when one is
  created, through a pluggable sender (Resend in production, a logging stub
  locally). Sending is best-effort — a mail failure never undoes a receipt that
  has already been signed.
- **The DA 2062 now carries both parties**, with unit and contact number on the
  FROM/TO name line, sized to fit the box.

### Changed
- **Items are simpler.** Asset tag is gone and "home location" is now **home
  unit**. New-user records carry a unit and contact number.
- **Signing in lands on the receipt flow**, not the public search page — a
  successful login used to look like it had done nothing.

### Removed
- **The two-device custody handshake.** Initiating a transfer to another account
  and waiting for them to accept, decline or cancel it — along with the
  standard-user dashboard of incoming and outgoing transfers, the admin override
  reassignment, and the per-item pending-transfer lock — is replaced by the
  single-device flow above. A recipient no longer needs an account at all.

### Notes
- Self-registration was removed with the two-device flow and re-enabled later
  the same day, since a peer initiating a receipt still needs an account.
- The single-item kiosk page at `/new` shipped and was retired within the day in
  favour of starting from the shared item list.

## 2026-07-01

### Added
- **A drawn signature completes a transfer.** The recipient signs on screen to
  accept custody, and the signature is stored with the transfer record.
- **A dashboard for standard users** showing what they hold and what is coming
  in or going out.
- **Admin user management** — create accounts, change roles, deactivate — plus
  an audit view of every transfer, and the ability to reassign an item to
  someone directly when the normal handshake is not possible.
- **A printable DA Form 2062 hand receipt per transfer**, filled per the
  official field guidance: the item's description carries its serial, quantities
  read down column A, and the recipient's signature and date are rotated to read
  up that column, the way a hand receipt is actually signed. Black guard bars
  fill the empty cells above and below the signed block so entries cannot be
  added afterwards. A single-page item QR PDF downloads from the QR page.
- **Self-service password change** at `/account`, so the seeded admin password
  can be rotated from the application rather than the database.
- **Self-registration**, a searchable person picker, and a **rank** field
  separate from the name — rank and name are snapshotted onto a transfer
  together, so the hand receipt's FROM/TO lines read the way the form expects.

### Changed
- **Every date and time is displayed in Hawaii Standard Time**, on screen and on
  the hand receipt. Timestamps are still stored in UTC; only the display moved.
- **A full visual restyle** — a coherent design system across every screen,
  replacing the framework's starter styling.
- **Email addresses are normalised to lowercase** on sign-in and on account
  creation, so capitalisation can no longer keep someone out of their own
  account.

### Security
- **A demotion or deactivation now takes effect on the account's very next
  request**, rather than whenever their sign-in happened to expire. An admin
  cannot demote or deactivate their own account, now that those changes bite
  immediately.
- **Every admin page checks admin rights itself**, in addition to the section
  guard around them.
- **A submitted signature is validated** — it must be a PNG image and under
  5 MB — before it is stored.

### Fixed
- Two people starting a transfer for the same item at the same moment now get a
  clear "already pending" message instead of a server error.

### Notes
- Deployment targets Vercel with Supabase Postgres: a pooled connection at
  runtime and a direct one for migrations, with the client generated at build
  time. Note that Vercel's free tier refuses to build a commit whose author
  email is not linked to a GitHub account on the team.

## 2026-06-30

### Added
- **The first working version of the application.** An administrator signs in
  with an email and password, and every page other than sign-in requires a
  session; accounts carry a role (`ADMIN` or `USER`) that decides what they can
  reach.
- **An equipment catalogue.** Admins log an item with its make, model, serial
  number and asset tag, search the list, edit it, and retire it when it leaves
  the fleet. Retiring is a status change, not a deletion — the item's history
  survives it.
- **A QR code per item**, with a printable page carrying the code and the item's
  details, so a code stuck to a device leads to that device's record.
- **A public item page** showing an item's read-only details, reachable without
  signing in — the page a scanned QR code opens.
- **Custody transfers between accounts.** The holder starts a transfer to
  another person, who accepts or declines it; either party can cancel while it
  is pending. An item can only have one transfer pending at a time — enforced by
  the database, not just by the application — so two people cannot start one for
  the same item at once. An admin can reassign an item outright when the normal
  handshake is not possible, and every item carries the full history of who held
  it and when.
