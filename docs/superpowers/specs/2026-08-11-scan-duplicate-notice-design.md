# A duplicate scan notice that waits, and says which device — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Builds on:** `2026-08-10-multi-item-scan-design.md` (#109), `29d635c` *a single scanned device opens it* (#118), and `e84897a` *bulk audit, service flag and service completion on a scanned batch* (#119).
**Surface:** `src/app/items/ItemsScanButton.tsx` only.

## Problem

Two complaints from the desk, both about scanning a shelf of thirty devices where a
handful are not yet in the property book.

1. **Creating the unknown serials emptied the selection.** Scan a mixed batch, tap *Done*,
   fill in make and model for the strangers, tap *Create N* — and come back to `/items`
   with nothing selected, so a shelf had to be re-selected by hand before any bulk action
   could run.

2. **"Already scanned" fires before the operator can read what just happened.** A linear
   barcode re-decodes on every camera frame, so the frame *after* a successful scan already
   reports the same code. The success line — *"Added HP ProBook 650 G5"* — is overwritten
   within a frame or two by *"Already scanned"*, which names no device. On a batch of
   thirty that says nothing about which label the camera is stuck on.

### #1 is very probably already fixed, and this spec does not re-fix it

The scan component was never the culprit: `finish()` calls `commitFound()` →
`addMany(found items)` before switching to the create form
(`ItemsScanButton.tsx:245`), `onCreated` calls `addMany(res.items)` for the newly created
ones (`:295`), and nothing on that path calls `clear()`. What the selection could not
survive was the page refresh `createScannedItemsAction` triggers with
`revalidatePath("/items")` (`scanned-items.ts:60`), because `ItemSelectionProvider` held
the batch in an in-memory `useState` Map.

**That Map is gone.** `e84897a` (#119) moved the selection onto
`src/components/item-selection-store.ts` — localStorage through `makeStore` /
`usePersistedPref` — so a router refresh can no longer destroy it. The report predates
that merge.

So the entire remedy for #1 is **evidence**, not code:

- a regression test that pins the behaviour, which does not exist today (the scan suite's
  last case checks only the *"1 item created"* message);
- a check on a real device, because jsdom does not model `revalidatePath` and therefore
  cannot prove the thing that was actually broken.

If the device check still shows an empty selection bar after *Create N*, the diagnosis
above is wrong and this becomes a debugging task rather than a verification one. That
outcome must be reported, not patched around.

## Non-goals

- **No change to the selection provider, the store, or the cap.** All three shipped in
  #119 and are working as designed.
- **No change to the create form, the lookup order, the express-service-code rule, the
  single-scan-opens-the-item rule, or the 500-cap refusal.**
- **No change to the dedupe keys.** `seen` still dedupes forever; only what is *said* about
  a repeat changes.

## What changes, from the operator's side

- A successful scan's message stays on screen for **3 seconds** before any "already
  scanned" notice can replace it.
- A repeat names the device: **"2TK94709FN already scanned"**, not "Already scanned".

Nothing else moves.

## Architecture

Both changes are local to `ItemsScanButton.tsx`. Nothing is exported and no other file is
touched.

### 1. A three-second grace after a successful scan

One new ref, `lastAddedAt`, stamped with `Date.now()` inside `push()` **only when a row was
actually appended** (`push` returns `false` for a repeat, and that path must not open a
window). All three "already scanned" branches — the cheap pre-check (`:127`), the
post-resolve repeat (`:154`) and the unknown-serial repeat (`:188`) — return silently, with
no notice and no beep, while `Date.now() - lastAddedAt.current < NOTICE_GRACE_MS` (3000).

The grace sits **in front of** the existing per-key `noticeThrottled` window rather than
replacing it. The three windows do different jobs and all three are still needed: `seen`
dedupes forever, the 1.5s throttle stops a label left under the camera beeping every frame,
and the grace is what protects the success message.

A suppressed notice deliberately does **not** touch `lastNotice`. Recording one would open
a 1.5s throttle window the operator never saw, delaying the first repeat that *is* worth
reporting.

**Every append counts as a success, including the ones that read as errors** — *"…is
retired — not added to the selection"* and *"…is not in the book"*. Those messages matter
more than a repeat notice does, and each marks a row the operator has to act on.

**The full-selection refusal is NOT affected.** `refuseIfFull` (`:77`) is a different
notice about a different condition, it fires on a scan that was *refused* rather than
appended, and silencing it would let an operator keep scanning into a selection that cannot
take the devices. It keeps its own `noticeThrottled` call and is left alone.

**A different device's repeat is silenced too, for those 3 seconds.** This is the accepted
cost of a single timer: telling "the label still under the camera" apart from "a genuinely
different duplicate" would need per-key grace state, and the second case is rare next to
the first — during a sweep the camera is moving off one label and onto the next, not
revisiting a third.

### 2. The repeat names the device

A second ref, `seenSerial` (`seen key → serial string`), written in `push()` for **both**
keys an entry may register — `entry.key` and the `linkedSeenKey` a serial-kind scan resolves
from — and cleared in `remove()` alongside `seen` and `linkedKey`. Both are required: a
serial scan registers `id:<item>` *and* the `sn:<serial>` it resolved from, so a later
sticker scan of the same device arrives on the first key and a later raw-serial scan on the
second.

The message is `` `${serial} already scanned` ``, matching the phrasing of its neighbours
(`"${newSerial} is not in the book"`, `"${item.serialNumber} is retired — …"`). It falls
back to the bare `"Already scanned"` when the map has no entry, so an unforeseen key path
degrades to today's behaviour rather than printing `undefined`.

One helper, `sayAlreadyScanned(key)`, owns the grace check, the throttle check and the
message, and all three call sites route through it — so the rule cannot drift between them.

`start()` resets `lastAddedAt` and `seenSerial` alongside the refs it already clears.

## Error handling

| Case | Behaviour |
| --- | --- |
| A repeat arrives inside the grace | Silent: no notice, no beep, `lastNotice` untouched. |
| A repeat arrives inside the 1.5s throttle but after the grace | Silent, exactly as today. |
| `seenSerial` has no entry for the key | Message falls back to `"Already scanned"`. Never `undefined`. |
| The row was removed from the sheet | `remove()` releases both keys from `seen` and `seenSerial`, so the label scans fresh — unchanged behaviour, with the new map kept in step. |
| The selection is full | `refuseIfFull` still speaks, throttled per code. The grace does not silence it. |
| A new scan session | `start()` zeroes both new refs, so a grace cannot carry across sessions. |

## Testing

**jsdom component — `src/app/items/ItemsScanButton.test.tsx`**

For #1, the regression test that does not exist today:
- After the create form submits, the selection holds the in-book items **and** the created
  ones. Written and committed *before* anything else, so its result is evidence rather than
  a by-product. It is expected to **pass** on current code — jsdom does not model
  `revalidatePath`, so it pins the client logic and nothing more, and that limit is stated
  in the test itself.

For #2 and #3:
- A repeat inside the grace produces no notice and no beep, and the success message is
  still on screen.
- A repeat after the grace names the serial.
- A repeat arriving on the row's *other* registered key still names the serial.
- The 1.5s throttle still holds once the grace has expired.
- The full-selection refusal still speaks inside the grace window — the one guard that the
  grace must not silence.

Time is controlled by stubbing `Date.now` from a mutable variable. `vi.useFakeTimers()`
would additionally need `userEvent.setup({ advanceTimers })` and buys nothing: the component
reads `Date.now()` directly and schedules no timers.

**Three existing tests change**, and each change is the point of the feature rather than
collateral: the two `/^Already scanned$/i` assertions now match a serial-prefixed message,
and *"does not beep on every frame the code sits in view"* must step past the grace first
or it would assert zero beeps and stop covering the throttle it exists for.

**Not provable here.** jsdom has no camera and no layout engine, and `npm run build` is
evidence for neither. The scan loop and the post-create selection both need a real iPhone
through the cloudflared tunnel (the camera needs a secure context).

**Run `npm test` before opening a PR.** The DB-backed files need a quiet database — a
concurrent session truncates the shared test DB, which masquerades as flaky failures in
files this change never touches.

## Documentation, in the same commit

- **`CHANGELOG.md`** — a `### Fixed` entry under today's date for the notice change.
  **No entry for #1**: #119 already shipped the behaviour and carries its own changelog
  line, and claiming a fix twice would misdescribe what changed today.
- **No `docs/SECURITY.md` entry.** No authz check, crypto, cookie, public surface or
  retention window is touched.
- **No `CLAUDE.md` or `.claude/rules/*` change.** No rule is created or retired.

## Rejected alternatives

- **Re-implementing the persistence from the original spec.** It is already on `main`. The
  first thing this work did was check.
- **A per-key grace window instead of one timer.** Would let a genuinely different
  duplicate through during the 3 seconds, at the cost of a second Map keyed the way `seen`
  is, for a case the sweep workflow barely produces.
- **Extending the existing 1.5s throttle to 3s instead of adding a window.** Simpler, and
  wrong: the throttle is keyed per code, so it does nothing about the *first* repeat of the
  code just scanned — which is the frame that overwrites the success message.
- **Suppressing the repeat notice entirely and relying on the row list.** The list already
  shows what was collected, but a silent repeat gives the operator no signal that the
  camera is stuck on a label they think they have moved past.
- **Silencing `refuseIfFull` during the grace too.** It would hide a hard stop behind a
  success message, which is how an operator ends up scanning twenty devices into a
  selection that cannot hold them.

## Risks

- **Three seconds is a guess.** It is the operator's stated number and it is one constant,
  but it has not been measured against a real sweep cadence. Too long and a genuine
  duplicate on the next label goes unannounced; too short and the original complaint
  returns.
- **The regression test for #1 pins client logic, not the bug that was reported.** It will
  pass whether or not the real problem is fixed, so it must not be read as proof. The
  device check is the evidence.
- **Three windows now govern one notice** (`seen`, the 1.5s throttle, the 3s grace). One
  helper owns all three call sites to keep them consistent; splitting that helper later
  would let them drift.
