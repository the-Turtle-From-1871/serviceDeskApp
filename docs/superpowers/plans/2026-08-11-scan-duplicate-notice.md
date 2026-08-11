# Scan duplicate notice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold a successful scan's message for 3 seconds before any "already scanned" notice can replace it, make that notice name the device, and pin — with a test and a device check — that a mixed scanned batch survives creating its unknown serials.

**Architecture:** Everything is local to `src/app/items/ItemsScanButton.tsx`: two new refs (`lastAddedAt`, `seenSerial`), one constant (`NOTICE_GRACE_MS`), and one helper (`sayAlreadyScanned`) that the three existing repeat branches route through. No other source file changes. The selection-persistence half of the original report was already fixed by `e84897a` (#119), so this plan verifies it rather than re-implementing it.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Vitest + Testing Library (jsdom via `npm run test:ui`).

**Spec:** `docs/superpowers/specs/2026-08-11-scan-duplicate-notice-design.md`

## Global Constraints

Every task's requirements implicitly include all of these.

- **Only `src/app/items/ItemsScanButton.tsx` changes in `src/`.** If a task seems to need an edit anywhere else under `src/`, stop and report — that is a signal the plan is wrong, not a licence to widen it.
- **Do not touch the selection provider, `item-selection-store.ts`, or the 500-item cap.** All three shipped in `e84897a` (#119) and work as designed.
- **`NOTICE_GRACE_MS` is `3000`.** One constant, module scope, referenced everywhere — never a literal at a call site.
- **The grace must NOT silence `refuseIfFull`.** That is a different notice about a refused scan, not an appended one. `ItemsScanButton.test.tsx:361` ("counts the rows collected in THIS session against the cap") scans a hit and then a refusal back to back, inside what becomes the grace window — it is the standing guard and it must keep passing untouched.
- **A suppressed notice must not touch `lastNotice`.** Recording one opens a 1.5s throttle window nobody saw, delaying the first repeat worth reporting.
- **Tests sit beside their subject.** `ItemsScanButton.test.tsx` already carries `// @vitest-environment jsdom` on line 1 — do not add a second docblock.
- **jsdom has no camera and no layout engine, and `npm run build` is evidence for neither.** Nothing in Tasks 1-2 proves the feature works on a phone; Task 3 is that evidence.
- **Docs ship in the same commit as the code**, per `CLAUDE.md`.
- **No `docs/SECURITY.md`, `CLAUDE.md` or `.claude/rules/*` change.** No authz, crypto, cookie, public surface, retention window or documented rule is touched.
- **Line numbers in this plan refer to the files as they stand at the branch point** (`origin/main` = `e84897a`). Re-locate by the quoted code, not by the number, if an earlier step has shifted them.

---

## File Structure

**Modify:**
- `src/app/items/ItemsScanButton.tsx` — the constant, two refs, the helper, and the three rewired call sites.
- `src/app/items/ItemsScanButton.test.tsx` — the post-create regression test (Task 1), then the notice tests (Task 2).
- `CHANGELOG.md` — a `### Fixed` subsection under the existing `## 2026-08-11` heading.

**Create:** nothing.

---

### Task 1: Pin that a mixed batch survives creating its unknown serials

This task adds **no production code**. It writes the regression test the scan suite is missing and records what the current code does.

**Read this before writing anything.** The reported bug was that creating the unknown serials emptied the `/items` selection. The cause was the in-memory `useState` Map in `ItemSelectionProvider` being destroyed by the page refresh `createScannedItemsAction` triggers with `revalidatePath("/items")`. That Map is gone — `e84897a` (#119) moved the selection to localStorage — so the bug is expected to be fixed already. jsdom does not model `revalidatePath`, so this test exercises **only the client logic**, which was never the culprit. **A pass here is the expected, informative outcome, not a failure of the task.** Do not change production code to make it pass.

**Files:**
- Modify: `src/app/items/ItemsScanButton.test.tsx`

**Interfaces:**
- Consumes: the file's existing `setup(canCreate)`, `open(user)` and `Selection` probe helpers, and the `createScannedItemsAction` mock configured in `beforeEach` (lines 100-105), which resolves `{ ok: true, items: [{ id: "i3", make: "Acme", model: "Widget", serialNumber: "NOSUCH123", status: "ACTIVE" }], created: 1, existed: 0 }`.
- Produces: nothing importable. A committed regression test.

- [ ] **Step 1: Add the test**

Append inside the top-level `describe("ItemsScanButton", …)` block, immediately after the existing `"reports how many were created (and how many already existed)…"` test (currently ending at line 512) and before the block's closing brace:

```tsx
  // Both halves of a mixed batch must survive the create step: the in-book
  // devices committed by Done, and the serials created from the form. Losing
  // either means re-selecting a shelf by hand before any bulk action can run.
  //
  // TWO devices, deliberately — the found HP (i1) and the unknown serial the
  // create mock returns as i3 — so the assertion tells "kept the found half"
  // apart from "kept the created half".
  //
  // SCOPE: this pins the CLIENT logic only. The bug reported against this flow
  // was the page refresh from createScannedItemsAction's revalidatePath("/items")
  // destroying an in-memory selection; jsdom models neither, and the selection
  // is localStorage-backed now anyway. Read a pass here as "the sheet commits
  // both halves", never as "the reported bug is fixed" — that is a device check.
  it("keeps the in-book items AND the created ones selected after the create form", async () => {
    const user = userEvent.setup();
    setup(true);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    await screen.findByText("2TK94709FN");
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    await screen.findByText(/^Not in the book$/i);

    await user.click(screen.getByRole("button", { name: /^Done/ }));
    await user.type(await screen.findByLabelText(/Make for NOSUCH123/i), "Acme");
    await user.type(screen.getByLabelText(/Model for NOSUCH123/i), "Widget");
    await user.click(screen.getByRole("button", { name: /^Create 1/ }));
    await screen.findByText(/1 item created\./i);

    await waitFor(() => expect(screen.getByTestId("sel").textContent).toBe("i1,i3"));
  });
```

- [ ] **Step 2: Run it and record the outcome**

Run: `npx vitest run ItemsScanButton`
Expected: **PASS**, whole file.

If it **FAILS**, stop and report the failure verbatim before doing anything else — the client is losing the selection on its own, which contradicts the spec's diagnosis and means this plan is incomplete.

- [ ] **Step 3: Commit**

```bash
git add src/app/items/ItemsScanButton.test.tsx
git commit -m "test(scan): pin that a mixed batch survives creating its unknown serials"
```

---

### Task 2: A three-second grace, and a repeat that names the device

A linear barcode re-decodes on every camera frame, so the frame after a hit reports the same code and *"Already scanned"* overwrites *"Added HP ProBook 650 G5"* before anyone can read it — while naming no device, which on a batch of thirty says nothing about which label the camera is stuck on.

**Files:**
- Modify: `src/app/items/ItemsScanButton.tsx`
- Modify: `src/app/items/ItemsScanButton.test.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the component's existing `seen`, `linkedKey`, `lastNotice`, `willSelect` refs and its `noticeThrottled`, `refuseIfFull`, `say`, `push`, `remove`, `start` locals. All are function-scoped inside `ItemsScanButton`; nothing here is exported.
- Produces: no new exports. Behaviour only.

- [ ] **Step 1: Write the failing tests**

Three edits to `src/app/items/ItemsScanButton.test.tsx`.

**(a) Stub the clock.** The component reads `Date.now()` directly and schedules no timers, so a stubbed clock is enough — `vi.useFakeTimers()` would additionally need `userEvent.setup({ advanceTimers })` and buys nothing. Add immediately after the existing `beforeEach` block (which currently ends at line 106), leaving that block untouched:

```tsx
// The grace window and the repeat throttle are both wall-clock comparisons, so
// these tests move time by hand. `vi.clearAllMocks()` in the beforeEach above
// only clears call records, not this implementation, so the order is immaterial.
let nowMs = 1_754_870_000_000;
beforeEach(() => {
  nowMs = 1_754_870_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
});
afterEach(() => { vi.mocked(Date.now).mockRestore(); });
```

**(b) Replace the whole `describe("re-scanning an already-listed item", …)` block** (currently lines 422-448) with:

```tsx
  describe("re-scanning an already-listed item", () => {
    // The success message has to survive the repeat decodes of the code still
    // sitting under the camera, or the operator never sees what was added.
    it("says nothing at all for 3 seconds after a successful scan", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText("2TK94709FN");
      vi.mocked(beep).mockClear();

      nowMs += 2_999;
      await user.click(screen.getByRole("button", { name: "emit-hp" }));

      expect(screen.getByTestId("scan-notice").textContent).toMatch(/^Added HP/);
      expect(beep).not.toHaveBeenCalled();
    });

    it("names the serial once the grace has expired, and adds no second row", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText("2TK94709FN");

      nowMs += 3_000;
      await user.click(screen.getByRole("button", { name: "emit-hp" }));

      expect(await screen.findByText("2TK94709FN already scanned")).toBeDefined();
      // Exactly one node holds the bare serial: the list row. The notice reads
      // "2TK94709FN already scanned", which this exact-match query does not hit.
      expect(screen.getAllByText("2TK94709FN")).toHaveLength(1);
    });

    // A serial scan registers the item-id key AND the sn: key it resolved from,
    // so a later sticker scan of the same device arrives on the OTHER one and
    // must still be able to name it. Both keys carry the serial for this reason.
    it("names the serial when the repeat arrives on the row's other key", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText("2TK94709FN");

      nowMs += 3_000;
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));

      expect(await screen.findByText("2TK94709FN already scanned")).toBeDefined();
    });

    it("does not beep on every frame the code sits in view", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText("2TK94709FN");
      vi.mocked(beep).mockClear();

      // Past the 3s grace, so a repeat is reportable at all...
      nowMs += 3_000;
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      // ...but these three land inside the 1.5s per-key throttle behind it.
      for (let i = 0; i < 3; i++) {
        nowMs += 400;
        await user.click(screen.getByRole("button", { name: "emit-hp" }));
      }

      expect(beep).toHaveBeenCalledTimes(1);
    });
  });
```

**(c) Fix the one remaining bare-notice assertion**, in `describe("scanning our own printed sticker (/i/<id>)", …)` — the test named `"scanning the same sticker twice adds exactly one row and flags the repeat"` (currently lines 475-484). Replace its body with:

```tsx
    it("scanning the same sticker twice adds exactly one row and flags the repeat", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));
      await screen.findByText("2TK94709FN");

      nowMs += 3_000;
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));

      expect(await screen.findByText("2TK94709FN already scanned")).toBeDefined();
      expect(screen.getAllByText("2TK94709FN")).toHaveLength(1);
    });
```

Leave every other test alone. In particular do **not** touch `"adds the item to the list on the very first scan"` (line 451), whose `queryByText(/^Already scanned$/i)` asserting *null* stays correct, or any test in the cap `describe` block.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run ItemsScanButton`
Expected: FAIL — the grace test finds `"Already scanned"` in the notice instead of `/^Added HP/`, and the three serial-named tests find no element reading `"2TK94709FN already scanned"`.

- [ ] **Step 3: Add the grace constant**

In `src/app/items/ItemsScanButton.tsx`, at module scope, after the imports (currently ending line 12) and before the `ItemsScanButton` docblock:

```tsx
/** How long a successful scan's message is protected from an "already scanned"
 *  notice. A linear barcode re-decodes on EVERY camera frame, so without this
 *  the frame right after a hit overwrites "Added HP ProBook 650 G5" before
 *  anyone can read it — and on a shelf sweep the operator needs those seconds
 *  to move the camera off the label it just read. */
const NOTICE_GRACE_MS = 3000;
```

- [ ] **Step 4: Add the two refs**

Immediately after the `willSelect` ref (currently line 62):

```tsx
  // Epoch ms of the last row actually APPENDED — see sayAlreadyScanned. Set in
  // push() only on a genuine append: push returns false for a repeat, and that
  // path must not re-open the window that is suppressing it.
  const lastAddedAt = useRef(0);
  // seen key -> the serial to NAME in an "already scanned" notice. BOTH keys an
  // entry may register are recorded, because a repeat can arrive on either: a
  // serial scan registers `id:<item>` AND the `sn:<serial>` it resolved from, so
  // a later sticker scan of that device lands on the first and a later
  // raw-serial scan on the second.
  const seenSerial = useRef(new Map<string, string>());
```

- [ ] **Step 5: Add the reporting helper**

Immediately after `refuseIfFull` (currently ending line 83):

```tsx
  /**
   * Report a repeat — unless the grace window or the per-key throttle says not
   * to. All three call sites share it so the rule cannot drift between them.
   *
   * The grace is checked FIRST and deliberately leaves `lastNotice` untouched:
   * recording a suppressed notice would open a 1.5s throttle window the operator
   * never saw, delaying the first repeat that IS worth reporting.
   *
   * refuseIfFull above is deliberately NOT routed through here. It reports a
   * scan that was REFUSED rather than appended, and silencing it would let
   * someone keep scanning into a selection that cannot take the devices.
   *
   * Naming the device is the point: on a batch of thirty, a bare "Already
   * scanned" says nothing about which label the camera is stuck on.
   */
  const sayAlreadyScanned = (key: string) => {
    if (Date.now() - lastAddedAt.current < NOTICE_GRACE_MS) return;
    if (!noticeThrottled(key)) return;
    const serial = seenSerial.current.get(key);
    say("err", serial ? `${serial} already scanned` : "Already scanned");
  };
```

- [ ] **Step 6: Record the serial and stamp the clock in `push`**

Replace `push` (currently lines 91-103) with:

```tsx
  const push = (entry: ScannedEntry, linkedSeenKey?: string) => {
    if (seen.current.has(entry.key)) return false;
    const serial = entry.kind === "new" ? entry.serial : entry.item.serialNumber;
    seen.current.add(entry.key);
    seenSerial.current.set(entry.key, serial);
    if (linkedSeenKey) {
      seen.current.add(linkedSeenKey);
      seenSerial.current.set(linkedSeenKey, serial);
      linkedKey.current.set(entry.key, linkedSeenKey);
    }
    // A retired row is listed but never selected (addMany refuses it), so it
    // costs no slot against the cap.
    if (entry.kind !== "retired") willSelect.current += 1;
    setScanned((prev) => [...prev, entry]);
    // Opens the grace window. A row that is LISTED rather than selected — a
    // retired device, a serial not in the book — counts: those messages matter
    // more than a repeat notice does, and each marks a row to act on.
    lastAddedAt.current = Date.now();
    return true;
  };
```

- [ ] **Step 7: Release the serial in `remove`**

Replace `remove` (currently lines 109-118) with:

```tsx
  const remove = (key: string, kind: ScannedEntry["kind"]) => {
    setScanned((prev) => prev.filter((e) => e.key !== key));
    if (kind !== "retired") willSelect.current = Math.max(0, willSelect.current - 1);
    seen.current.delete(key);
    seenSerial.current.delete(key);
    const linked = linkedKey.current.get(key);
    if (linked) {
      seen.current.delete(linked);
      seenSerial.current.delete(linked);
      linkedKey.current.delete(key);
    }
  };
```

- [ ] **Step 8: Route the three repeat branches through the helper**

Three replacements inside `onDecode`. Each replaces a `noticeThrottled` + `say("err", "Already scanned")` pair.

The cheap pre-check (currently lines 127-130):

```tsx
    if (seen.current.has(preKey)) {
      sayAlreadyScanned(preKey);
      return;
    }
```

The post-resolve repeat (currently lines 154-156) — the `else if` becomes a plain `else`:

```tsx
        } else {
          sayAlreadyScanned(entry.key);
        }
```

The unknown-serial repeat (currently lines 188-190) — likewise:

```tsx
        } else {
          sayAlreadyScanned(preKey);
        }
```

After this, `"Already scanned"` must appear in exactly one place in the file: the fallback inside `sayAlreadyScanned`.

- [ ] **Step 9: Reset both refs in `start`**

Replace `start` (currently lines 250-260) with:

```tsx
  const start = () => {
    setScanned([]);
    willSelect.current = 0;
    seen.current = new Set();
    seenSerial.current = new Map();
    linkedKey.current = new Map();
    lastNotice.current = { key: "", at: 0 };
    lastAddedAt.current = 0;
    setNotice(null);
    setResult(null);
    setPhase("scanning");
    setScanning(true);
  };
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run ItemsScanButton`
Expected: PASS, every case in the file.

Pay particular attention to the cap `describe` block. `"counts the rows collected in THIS session against the cap"` scans a hit and then a refusal back to back — inside the new grace window — so it fails if `refuseIfFull` was wrongly routed through `sayAlreadyScanned`. That test passing is the guard that the grace stayed off the full-selection refusal.

- [ ] **Step 11: Run the component suite and the linter**

Run: `npm run test:ui`
Expected: PASS.

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 12: Add the changelog entry**

`CHANGELOG.md` has a `## 2026-08-11` section whose subsections currently run `### Changed`, `### Removed`, and whatever #119 added. Add a `### Fixed` subsection at the **end** of that section — immediately before the next `## ` date heading, keeping one blank line either side. Per Keep a Changelog, Fixed sorts after Removed.

```markdown
### Fixed
- **"Already scanned" now waits three seconds and says which device.** A barcode is re-read many times a second while it sits under the camera, so the message confirming what you just added — *Added HP ProBook 650 G5* — was replaced almost immediately by a bare *Already scanned* that named nothing. A successful scan's message now holds for three seconds before any repeat notice can replace it, and a repeat reads **"2TK94709FN already scanned"** so you can see which label the camera is still pointed at.

  During those three seconds a repeat of a *different* device is silenced too. That is deliberate: on a sweep the camera is moving from one label to the next, not revisiting a third. The "Selection is full" refusal is not affected — it still speaks immediately, because a scan it refuses is one that would otherwise be lost.
```

Do **not** add an entry about the selection surviving the create step. `e84897a` (#119) shipped that behaviour and carries its own changelog line; claiming it again would misdescribe what changed.

- [ ] **Step 13: Commit**

```bash
git add src/app/items/ItemsScanButton.tsx src/app/items/ItemsScanButton.test.tsx CHANGELOG.md
git commit -m "fix(scan): hold a scan result for 3s, and name the device on a repeat"
```

---

### Task 3: Verify on hardware

Nothing above proves either fix works for the operator: jsdom has no camera, and the selection bug that was actually reported involves a page refresh jsdom does not model. This task is the evidence.

**Files:** none. If something fails here, fix it in the task it belongs to and re-run.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS.

The DB-backed files need a quiet database — a concurrent agent session running `npm test` truncates the shared test DB, which masquerades as flaky failures in files this change never touched. If unrelated DB tests fail, confirm nothing else is running before investigating.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Verify on a real iPhone**

Start the dev server and a cloudflared tunnel (the camera needs a secure context), sign in on the phone, and on `/items`:

1. Scan two devices that ARE in the book and one label that is not.
2. Tap **Done · 2 items**, fill in make and model, tap **Create 1**, tap **Done**.
3. **Confirm the selection bar reads "3 selected"** and the bulk actions are available. This is the originally reported bug. If the bar is empty or short, `e84897a` did not fix it and the spec's diagnosis is wrong — report that rather than patching around it.
4. Leave one label under the camera after a successful scan. **Confirm the "Added …" message stays put for about three seconds**, then that the repeat notice reads `<serial> already scanned` and beeps at most every 1.5s.
5. Reload the page. **Confirm the selection is still there.**

- [ ] **Step 4: Report**

Report what each of the five checks did, including anything that did not behave as described. Do not claim the feature works on the strength of the test suite alone.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| #1 is already fixed — pin it with a test, prove it on a device | Task 1; Task 3 Step 3 checks 3 and 5 |
| §1 Three-second grace after a successful scan | Task 2, Steps 3-9 |
| §1 The full-selection refusal is not affected | Task 2, Step 5 (helper comment) and Step 10 (the standing guard test) |
| §2 The repeat names the device, both keys, with a fallback | Task 2, Steps 4-8 |
| §2 `start()` resets both refs | Task 2, Step 9 |
| Error handling — grace, throttle, missing serial, removal, full selection, new session | Task 2 Steps 5-9; asserted by Step 1's tests plus the untouched cap and removal blocks |
| Testing — grace, serial-named, other-key, throttle, three amended tests | Task 2, Step 1 |
| Testing — post-create regression | Task 1 |
| Docs — CHANGELOG only, no SECURITY.md, no rules | Task 2, Step 12 |
| "Not provable here" — device check | Task 3 |

**Type consistency.** `NOTICE_GRACE_MS`, `lastAddedAt`, `seenSerial` and `sayAlreadyScanned` are spelled identically across Task 2 Steps 3-9. `remove(key, kind)` keeps the two-argument signature #119 gave it, and `push(entry, linkedSeenKey?)` keeps its own — neither call site changes.

**Ordering note.** Task 1's test must be written and committed before Task 2 changes the component, or its result carries no diagnostic value.
