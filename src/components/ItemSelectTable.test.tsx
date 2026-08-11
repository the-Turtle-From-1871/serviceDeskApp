// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ItemSelectTable } from "./ItemSelectTable";
import { ItemSelectionProvider } from "./ItemSelection";
import { SORTABLE_COLUMNS, estimateTextEm } from "./items-view";
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, CARD_LAYOUT_QUERY, DRAWER_WIDTH, AXIS_LOCK_PX } from "./swipe-row";

// Selection now lives in ItemSelectionProvider (see ItemSelection.tsx), not in
// ItemSelectTable's own state — the /items Scan sheet is a SIBLING client
// component that has to commit into the same selection. Every render in this
// file goes through the provider so the table can reach useItemSelection().
const renderTable = (ui: ReactElement) =>
  render(<ItemSelectionProvider>{ui}</ItemSelectionProvider>);

// One shared spy rather than a fresh vi.fn() per useRouter() call, so the
// sort/filter suite can assert the URL a menu choice pushes. Hoisted because
// vi.mock's factory is lifted above the imports.
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  usePathname: () => "/items",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/admin/actions/items", () => ({ toggleItemStatusAction: vi.fn(), deleteItemAction: vi.fn() }));

// This suite runs without vitest `globals: true`, so @testing-library/react's
// auto-cleanup (which checks for a global `afterEach`) never registers.
// Without this, DOM nodes from each `renderEmpty()` pile up across tests in
// this file and later assertions see duplicates. Mirrors ContactCombobox.test.tsx.
afterEach(cleanup);

function renderEmpty(props: Partial<Parameters<typeof ItemSelectTable>[0]> = {}) {
  return renderTable(
    <ItemSelectTable
      items={[]}
      isAdmin
      q="ABC123"
      sort="deviceName"
      dir="asc"
      page={1}
      totalPages={1}
      sortKeys={[]}
      uic=""
      uics={[]}
      needsRename={false}
      categories={[]}
      {...props}
    />,
  );
}

describe("ItemSelectTable — empty state", () => {
  it("offers an admin a prefilled create link for the searched text", () => {
    renderEmpty();
    const link = screen.getByRole("link", { name: /create .*ABC123.* as a new item/i });
    expect(link.getAttribute("href")).toBe("/admin/items/new?serialNumber=ABC123");
  });

  it("carries the active unit filter into the link", () => {
    renderEmpty({ uic: "WABC01" });
    expect(screen.getByRole("link", { name: /as a new item/i }).getAttribute("href"))
      .toBe("/admin/items/new?serialNumber=ABC123&uic=WABC01");
  });

  it("percent-encodes a searched value containing URL metacharacters", () => {
    renderEmpty({ q: "A&B C" });
    expect(screen.getByRole("link", { name: /as a new item/i }).getAttribute("href"))
      .toBe("/admin/items/new?serialNumber=A%26B%20C");
  });

  it("offers nothing to a non-admin", () => {
    renderEmpty({ isAdmin: false });
    expect(screen.queryByRole("link", { name: /as a new item/i })).toBeNull();
  });

  // A UIC-only empty result gives us nothing to prefill and no evidence the
  // admin was hunting a specific device.
  it("offers nothing when the search box is empty", () => {
    renderEmpty({ q: "   ", uic: "WABC01" });
    expect(screen.queryByRole("link", { name: /as a new item/i })).toBeNull();
  });

  it("still shows the plain message", () => {
    renderEmpty();
    expect(screen.getByText(/No items match/i)).toBeTruthy();
  });
});

// Regression coverage for the closed-<dialog> layout bug (fix round 1):
// `dialog:not([open]) { display: none }` is a UA type-selector rule, which any
// author class selector (.card => display:block, .stack => display:flex)
// outranks regardless of specificity within the class — so a closed <dialog>
// carrying either class renders anyway, full-size, on top of the row's
// buttons. jsdom has no layout engine and cannot measure the resulting
// 375x375 box or the intercepted click a real browser catches; what it CAN
// assert is the structural invariant that prevents it: the styling classes
// live on a wrapper INSIDE the dialog, never on the <dialog> element itself.
describe("ItemSelectTable — delete dialog structure (closed-dialog layout regression)", () => {
  const ROW = {
    id: "item-1",
    deviceName: "Laptop 1",
    make: "Dell",
    model: "L5420",
    serialNumber: "SN1",
    status: "ACTIVE" as const,
    auditState: null,
    deviceUIC: null,
    deviceCategory: null,
    readiness: "UNTRIAGED" as const,
    holderName: null,
    homeUnit: null,
    storageLocation: null,
    lastLogonUserPrincipalName: null,
    lastLogonDate: null,
    compliance: null,
    lastSyncDateTime: null,
  };

  function renderRow() {
    return renderTable(
      <ItemSelectTable
        items={[ROW]}
        isAdmin
        q=""
        sort={null}
        dir="asc"
        page={1}
        totalPages={1}
        sortKeys={[]}
        uic="" needsRename={false}
        uics={[]}
        categories={[]}
      />,
    );
  }

  it("puts the dialog's styling classes on an inner wrapper, never on <dialog> itself", () => {
    const { container } = renderRow();
    const dialog = container.querySelector("dialog");
    expect(dialog).not.toBeNull();
    // The whole bug was an author class (.card / .stack, from globals.css)
    // landing directly on the <dialog>, which beats the UA's
    // `dialog:not([open]) { display: none }` and renders it while closed.
    expect(dialog!.getAttribute("class")).toBeNull();
    // The card styling must still exist, just one level in.
    const wrapper = dialog!.querySelector(":scope > .card.stack");
    expect(wrapper).not.toBeNull();
    // And the dialog content (e.g. the confirmation copy) lives inside that
    // wrapper, not as a direct child of <dialog> alongside it.
    expect(wrapper!.textContent).toMatch(/Delete this item permanently/i);
  });

  // The mobile drawer's own hazard: the delete <dialog> is a SIBLING of the
  // Delete button inside `.actions`, so the drawer's `> *` flex rule would set
  // `display` on a closed dialog and re-create exactly the bug above. The CSS
  // excludes `dialog`; what jsdom can pin is the structure that makes the
  // exclusion necessary, so a future refactor that moves the dialog elsewhere
  // is a deliberate choice rather than a silent one.
  it("keeps the delete dialog inside the actions cell, as a sibling of its button", () => {
    const { container } = renderRow();
    const dialog = container.querySelector("td.row-actions .actions > dialog");
    expect(dialog).not.toBeNull();
  });
});

/**
 * The mobile card. jsdom has no layout engine and no touch screen, so none of
 * this is evidence that the card LOOKS right or that a swipe FEELS right —
 * that was measured in a browser. What these pin is the structure the CSS
 * depends on, which is the part a later edit can quietly break: the card is
 * built from cells the Columns menu cannot remove, and its tap target is a
 * real link rather than a click handler.
 */
describe("ItemSelectTable — mobile card structure", () => {
  const ROW = {
    id: "item-1",
    deviceName: "Laptop 1",
    make: "Dell",
    model: "L5420",
    serialNumber: "SN1",
    status: "ACTIVE" as const,
    auditState: null,
    deviceUIC: null,
    deviceCategory: null,
    readiness: "UNTRIAGED" as const,
    holderName: null,
    // Real values here, unlike the other fixtures: the More panel below is what
    // renders them, and the Home unit string is deliberately long enough to
    // wrap in a ~230px column — that is the case the fit sizing exists for.
    homeUnit: "HHC, 1-506 IN, 1BCT, 101ABN",
    storageLocation: "Bldg 4 cage 2",
    lastLogonUserPrincipalName: "jane.doe@army.mil",
    lastLogonDate: "7/25/2026 1:40:21 AM",
    compliance: "Compliant",
    lastSyncDateTime: "8/9/2026 6:02:11 AM",
  };
  const RETIRED = { ...ROW, id: "item-2", serialNumber: "SN2", status: "RETIRED" as const };

  function renderRows(props: Partial<Parameters<typeof ItemSelectTable>[0]> = {}) {
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
        uics={[]}
        categories={[]}
        {...props}
      />,
    );
  }

  it("opts the items table into the card treatment, and nothing else", () => {
    const { container } = renderRows();
    expect(container.querySelector("table.table.table--cards")).not.toBeNull();
  });

  // Reported: selecting an item resized the "Print QR codes" button and the one
  // beside it. On a phone the toolbar's buttons share a flex row, so the ` (N)`
  // this label used to append widened this button by 8.9px and shrank its
  // neighbour by exactly that much — then jittered again at (10) and (100).
  // (Measured against the Columns menu, which is desktop-only now; the
  // neighbour is Sort & filter and the row behaves the same.) jsdom has no
  // layout engine, so what is pinned here is the CAUSE: the label is constant.
  // The count is not lost — the selection bar below reads "N selected · N rows".
  it("keeps the Print QR label constant when items are selected, so the toolbar cannot resize", () => {
    const { container } = renderRows();
    const btn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent!.trim().startsWith("Print QR"),
    )!;
    expect(btn.textContent!.trim()).toBe("Print QR codes");

    const box = container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
    act(() => { fireEvent.click(box); });

    // The selection really happened...
    expect(screen.getByText(/1 selected · /)).toBeTruthy();
    // ...and the label did not move.
    expect(btn.textContent!.trim()).toBe("Print QR codes");
  });

  it("makes the card a real link to the item, not a click handler", () => {
    const { container } = renderRows();
    const link = container.querySelector("td.cell-serial a.card-link");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/i/item-1");
    // The visible serial has to be IN the accessible name (WCAG 2.5.3) — the
    // card shows "SN1" and a voice user must be able to say it.
    expect(link!.getAttribute("aria-label")).toContain("SN1");
  });

  // The reason the card is built from three dedicated cells: every data cell
  // is rendered conditionally by the Columns menu, so a user who hid Serial
  // would otherwise get a card with no heading and — since the heading holds
  // the link — no way to open the item at all.
  it("still renders the card when every optional column is hidden", () => {
    // parseHiddenCols keeps at least one column, so hide all but one.
    window.localStorage.setItem(
      "items:hiddenCols",
      JSON.stringify(["serialNumber", "deviceName", "make", "model", "holder", "deviceUIC", "deviceCategory", "readiness", "status"]),
    );
    const { container } = renderRows();
    expect(container.querySelector("td.cell-serial a.card-link")).not.toBeNull();
    expect(container.querySelector("td.cell-primary")).not.toBeNull();
    expect(container.querySelector("td.cell-meta")).not.toBeNull();
    window.localStorage.clear();
  });

  // The fields the compact card drops live behind the bottom chevron.
  // jsdom cannot measure the 44px strip or prove the tap beats the stretched
  // link — both were measured in a browser — but it can pin that the panel is a
  // native <details> (so it works without JS and takes Enter/Space for free)
  // and that it carries exactly the fields the card gave up.
  it("puts the dropped custody and telemetry fields behind a native details toggle", () => {
    const { container } = renderRows();
    const details = container.querySelector("td.cell-more details.card-more");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    // A <summary> is what makes it keyboard-operable without a single handler.
    expect(details!.querySelector(":scope > summary")).not.toBeNull();
    const terms = [...details!.querySelectorAll("dt")].map((d) => d.textContent);
    expect(terms).toEqual([
      "Holder",
      "Home unit",
      "SLOC",
      "Compliance",
      "Logon user",
      "Logon date",
      "Last sync",
    ]);
    // UIC and Category were moved out; they stay desktop columns only.
    expect(terms).not.toContain("UIC");
    expect(terms).not.toContain("Category");
  });

  // Last sync and Logon date are different facts, and the card is the surface
  // where they sit closest together — so pin that both render their own value
  // rather than one shadowing the other.
  it("renders the last sync time and the logon date as separate rows", () => {
    const { container } = renderRows();
    const pairs = [...container.querySelectorAll("td.cell-more dt")].map((dt, i) => [
      dt.textContent,
      [...container.querySelectorAll("td.cell-more dd")][i]?.textContent,
    ]);
    expect(pairs).toContainEqual(["Logon date", "7/25/2026 1:40:21 AM"]);
    expect(pairs).toContainEqual(["Last sync", "8/9/2026 6:02:11 AM"]);
  });

  // SLOC is the one row that goes away rather than showing a dash — most of the
  // catalogue has no storage location, and a dash on nearly every card is noise
  // between the facts either side of it. Every OTHER row stays, dash and all, so
  // two cards can still be read against each other.
  it("drops the SLOC row when there is no storage location, and keeps every other row", () => {
    const blank = [
      { ...ROW, storageLocation: null },
      { ...ROW, id: "item-3", serialNumber: "SN3", storageLocation: "   " },
    ];
    const { container } = renderRows({ items: blank });
    const rows = [...container.querySelectorAll("tbody tr")];
    // Assert the fixture actually rendered before looping over it: a bare
    // `for…of` over an empty NodeList runs zero assertions and reports green,
    // which would leave this branch — the only coverage of the conditional
    // row — silently unguarded if the table ever stopped rendering rows.
    expect(rows).toHaveLength(blank.length);
    for (const tr of rows) {
      const terms = [...tr.querySelectorAll("td.cell-more dt")].map((d) => d.textContent);
      expect(terms).toEqual([
        "Holder",
        "Home unit",
        "Compliance",
        "Logon user",
        "Logon date",
        "Last sync",
      ]);
    }
  });

  // The blank rule these fields share: null, "" and "   " must all read as
  // missing and render the dash. `""` in particular had NO fixture anywhere —
  // it is the exact case that makes `??` wrong here, so without it a later
  // "consistency" pass to `??` would go green while every MDM-blank device
  // showed three labelled but empty rows on a phone.
  it("renders a dash for null, empty and whitespace-only values alike", () => {
    const shapes = [
      { ...ROW, id: "b1", serialNumber: "B1", holderName: null, homeUnit: null, storageLocation: null, compliance: null, lastLogonUserPrincipalName: null, lastLogonDate: null, lastSyncDateTime: null },
      { ...ROW, id: "b2", serialNumber: "B2", holderName: "", homeUnit: "", storageLocation: "", compliance: "", lastLogonUserPrincipalName: "", lastLogonDate: "", lastSyncDateTime: "" },
      { ...ROW, id: "b3", serialNumber: "B3", holderName: "  ", homeUnit: "   ", storageLocation: "  ", compliance: " ", lastLogonUserPrincipalName: "  ", lastLogonDate: " ", lastSyncDateTime: "   " },
    ];
    const { container } = renderRows({ items: shapes });
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(shapes.length);
    for (const tr of rows) {
      const values = [...tr.querySelectorAll("td.cell-more dd")].map((d) => d.textContent);
      // Six, not seven: a blank SLOC drops its row entirely, in all three shapes.
      expect(values).toEqual(["—", "—", "—", "—", "—", "—"]);
    }
  });

  // A whitespace-only unit must not reach the fit sizing: it would render a
  // blank value under a label AND charge the font clamp for characters nobody
  // can see, shrinking the one row that spans the panel's full width.
  it("treats a whitespace-only home unit as missing rather than sizing it", () => {
    const { container } = renderRows({ items: [{ ...ROW, homeUnit: "     " }] });
    const dd = container.querySelector("td.cell-more dd.card-more__fit");
    expect(dd!.textContent).toBe("—");
    expect(dd!.querySelector("span")!.style.getPropertyValue("--w")).toBe("");
  });

  // Every pair is a direct child of the <dl>, home unit included, so all six
  // values line up in the grid's one value column. jsdom cannot measure that
  // alignment (it was measured in a browser), but it CAN pin the structure that
  // produces it: the moment one pair is wrapped in anything, that row leaves the
  // shared columns and its value starts somewhere of its own.
  it("keeps every label/value pair in the panel's shared grid columns", () => {
    const { container } = renderRows();
    const dl = container.querySelector("td.cell-more dl.card-more__list")!;
    const kids = [...dl.children].map((el) => el.tagName);
    expect(new Set(kids)).toEqual(new Set(["DT", "DD"]));
    expect(dl.querySelector(":scope > dd.card-more__fit")).not.toBeNull();
  });

  // The fit sizing is CSS (`clamp` over a container query), so jsdom — which has
  // no layout engine and does not resolve `cqi` — cannot show the rendered size.
  // What it CAN pin is the one input React owns: the estimated width reaching
  // CSS as `--w` on the span, not on the dd. Drop it and the clamp silently
  // falls back to its 20em default for every unit, which looks fine on short
  // strings and long ones alike until someone measures.
  it("hands the home unit's estimated width to CSS as --w", () => {
    const { container } = renderRows();
    const dd = container.querySelector("td.cell-more dd.card-more__fit");
    expect(dd).not.toBeNull();
    const span = dd!.querySelector("span");
    expect(span!.textContent).toBe(ROW.homeUnit);
    expect(span!.style.getPropertyValue("--w")).toBe(String(estimateTextEm(ROW.homeUnit)));
    // Not the character count — that is the bug this replaced. A unit full of
    // spaces and commas is far narrower than its length implies, and charging
    // it as if it were all capitals is what drove the font onto its floor.
    expect(estimateTextEm(ROW.homeUnit)).toBeLessThan(ROW.homeUnit.length * 0.64);
  });

  // Not driven by the Columns menu, exactly like the card cells above: the panel
  // exists to show what the CARD dropped, which is a fixed set, not what a
  // desktop preference happens to have hidden.
  it("shows the same fields regardless of the Columns preference", () => {
    // `lastSyncDateTime` is hidden here on purpose: it is the one panel field
    // that is ALSO a desktop column, so it is the only one that could plausibly
    // disappear from the card when the menu hides it. It must not.
    window.localStorage.setItem("items:hiddenCols", JSON.stringify(["holder", "deviceUIC", "deviceCategory", "lastSyncDateTime"]));
    const { container } = renderRows();
    // First row only — renderRows() draws two, so an unscoped query returns
    // both cards' worth.
    const terms = [...container.querySelectorAll("tbody tr:first-child td.cell-more dt")].map((d) => d.textContent);
    expect(terms).toEqual([
      "Holder",
      "Home unit",
      "SLOC",
      "Compliance",
      "Logon user",
      "Logon date",
      "Last sync",
    ]);
    window.localStorage.clear();
  });

  // The pull tab is now a CONTROL, not a decoration: tapping it opens the same
  // drawer the swipe does, so it must be a real button with a real name. (It
  // used to be an aria-hidden <span> with `pointer-events: none`; the tests
  // below replace that one.) jsdom cannot check the 44px hit box or that the
  // tab out-stacks the stretched card link — both measured in a browser — so
  // what is pinned here is the markup and the state it drives.
  it("makes the swipe pull tab a named button, not a decoration", () => {
    const { container } = renderRows();
    const grip = container.querySelector("tbody tr .swipe-grip") as HTMLButtonElement;
    expect(grip).not.toBeNull();
    expect(grip.tagName).toBe("BUTTON");
    // `type` matters: the card lives in a <table> that contains the Retire
    // <form>, and a bare button defaults to submit.
    expect(grip.getAttribute("type")).toBe("button");
    expect(grip.getAttribute("aria-hidden")).toBeNull();
    expect(grip.getAttribute("aria-label")).toBe("Show actions");
    expect(grip.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the row's action drawer when the tab is tapped, and closes it on a second tap", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0] as HTMLElement;
    const grip = row.querySelector(".swipe-grip") as HTMLButtonElement;
    expect(row.style.getPropertyValue("--swipe")).toBe("0px");

    act(() => { fireEvent.click(grip); });
    // The drawer is revealed by sliding the row exactly its width; the value
    // React renders from `openId` is the same one a settled swipe writes.
    expect(row.style.getPropertyValue("--swipe")).toBe(`${-DRAWER_WIDTH}px`);
    expect(grip.getAttribute("aria-expanded")).toBe("true");
    expect(grip.getAttribute("aria-label")).toBe("Hide actions");

    act(() => { fireEvent.click(grip); });
    expect(row.style.getPropertyValue("--swipe")).toBe("0px");
    expect(grip.getAttribute("aria-expanded")).toBe("false");
  });

  // (One drawer at a time, and the tab's behaviour under a real pointer, are
  // pinned in the gesture suite below — those need the card-layout matchMedia
  // mock that `onPointerDown` consults.)

  // The tab is rendered on exactly the condition `swipeEnabled` carries, so it
  // never offers a drawer that is empty (a standard user's) or one that
  // selection mode is force-closing behind it.
  it("offers no tab to a standard user, whose drawer would be empty", () => {
    const { container } = renderRows({ isAdmin: false });
    expect(container.querySelector("tbody tr .swipe-grip")).toBeNull();
  });

  it("withdraws the tab in selection mode", () => {
    const { container } = renderRows();
    expect(container.querySelector("tbody tr .swipe-grip")).not.toBeNull();
    act(() => { fireEvent.click(container.querySelector('tbody input[type="checkbox"]')!); });
    expect(screen.getByText(/1 selected · /)).toBeTruthy();
    expect(container.querySelector("tbody tr .swipe-grip")).toBeNull();
  });

  it("keeps View out of the drawer — tapping the card is View", () => {
    const { container } = renderRows();
    const drawer = container.querySelector("td.row-actions");
    expect(drawer).not.toBeNull();
    // Present in the DOM (the desktop table still needs it) but marked as the
    // one action the drawer hides.
    expect(drawer!.querySelector("a.action-view")).not.toBeNull();
  });
});

describe("ItemSelectTable — long-press selection", () => {
  const ROW = {
    id: "item-1",
    deviceName: "Laptop 1",
    make: "Dell",
    model: "L5420",
    serialNumber: "SN1",
    status: "ACTIVE" as const,
    auditState: null,
    deviceUIC: null,
    deviceCategory: null,
    readiness: "UNTRIAGED" as const,
    holderName: null,
    homeUnit: null,
    storageLocation: null,
    lastLogonUserPrincipalName: null,
    lastLogonDate: null,
    compliance: null,
    lastSyncDateTime: null,
  };
  const RETIRED = { ...ROW, id: "item-2", serialNumber: "SN2", status: "RETIRED" as const };
  let realSetPointerCapture: HTMLElement["setPointerCapture"];

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom ships no matchMedia; the click handler asks it whether the card
    // layout is on screen before treating a tap as a selection toggle.
    window.matchMedia = ((query: string) => ({
      matches: query === CARD_LAYOUT_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    // jsdom tracks no live pointers, so the real setPointerCapture throws
    // NotFoundError for a synthetic pointerId. The swipe path claims the
    // pointer the moment a gesture commits to the horizontal axis. Restored
    // in afterEach — a permanent prototype patch would silently disarm any
    // later test that needs to observe a real capture failure.
    realSetPointerCapture = window.HTMLElement.prototype.setPointerCapture;
    window.HTMLElement.prototype.setPointerCapture = () => {};
  });
  afterEach(() => {
    window.HTMLElement.prototype.setPointerCapture = realSetPointerCapture;
    vi.useRealTimers();
  });

  function renderRows(items = [ROW, RETIRED]) {
    return renderTable(
      <ItemSelectTable
        items={items}
        isAdmin
        q=""
        sort={null}
        dir="asc"
        page={1}
        totalPages={1}
        sortKeys={[]}
        uic="" needsRename={false}
        uics={[]}
        categories={[]}
      />,
    );
  }

  const press = (el: Element, ms: number, pointerType = "touch") => {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, pointerType, clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(ms); });
  };

  it("selects the pressed row and flips the table into selection mode", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0];
    expect(container.querySelector("table.is-selecting")).toBeNull();

    press(row, LONG_PRESS_MS);

    expect(container.querySelector("table.is-selecting")).not.toBeNull();
    expect(screen.getByText(/1 selected · /)).toBeTruthy();
  });

  it("does nothing on a press that is released early", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0];
    press(row, LONG_PRESS_MS - 50);
    fireEvent.pointerUp(row, { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(container.querySelector("table.is-selecting")).toBeNull();
  });

  // A retired row renders no checkbox and is excluded from every bulk action,
  // so the gesture must not be a back door into the selection.
  it("refuses to select a retired row", () => {
    const { container } = renderRows();
    const retiredRow = container.querySelectorAll("tbody tr")[1];
    press(retiredRow, LONG_PRESS_MS);
    expect(container.querySelector("table.is-selecting")).toBeNull();
  });

  // A mouse has no card layout to act on: below 720px there is no mouse, and
  // above it a held button would silently start selecting rows.
  it("ignores a held mouse button", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0];
    press(row, LONG_PRESS_MS, "mouse");
    expect(container.querySelector("table.is-selecting")).toBeNull();
  });

  it("suppresses the navigation the long press would otherwise trigger", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0];
    press(row, LONG_PRESS_MS);
    fireEvent.pointerUp(row, { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });

    const link = container.querySelector("td.cell-serial a.card-link")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  // Reported from a real iPhone: holding a card OPENED the item instead of
  // selecting. iOS can hand a held link to its own drag gesture and fire
  // `pointercancel`, which kills the long-press timer — and the lift still
  // produces a click, so the hold read as a tap. The `-webkit-user-drag` /
  // `draggable={false}` guards are what stop the takeover; this pins the
  // fail-safe, so that if one ever gets through the press still cannot
  // navigate. Not reproducible in Chromium OR WebKit with synthetic events —
  // both suppress correctly — so it is pinned at the unit level instead.
  it("never navigates from a held card, even if the pointer is taken away mid-press", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0];
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    // iOS takes the touch for its own gesture before our timer can fire.
    fireEvent.pointerCancel(row, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 50); });

    const link = container.querySelector("td.cell-serial a.card-link")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
  });

  // The other half of that rule: the fail-safe keys off DURATION, so a quick
  // tap must still open the item. Otherwise the card stops working entirely.
  it("still navigates from a quick tap", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0];
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(80); });
    fireEvent.pointerUp(row, { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });

    const link = container.querySelector("td.cell-serial a.card-link")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(false);
  });

  // One drawer at a time — in ONE tap.
  //
  // The pointerdown here is not decoration. `onPointerDown` is what dismisses
  // the other row's drawer, and it used to spend the incoming click doing so,
  // so the second row's tab needed pressing twice: the first press retracted
  // the other drawer and did nothing visible under the finger. A bare
  // `fireEvent.click` never reaches that code and reported this as working
  // when a real finger did not (confirmed with CDP touch events at 390px).
  it("opens a second row's drawer and closes the first in a single tap", () => {
    const { container } = renderRows();
    const rows = container.querySelectorAll("tbody tr");
    const tap = (row: Element) => {
      const grip = row.querySelector(".swipe-grip")!;
      act(() => {
        fireEvent.pointerDown(grip, { button: 0, pointerId: 1, pointerType: "touch", clientX: 380, clientY: 40 });
        fireEvent.pointerUp(grip, { button: 0, pointerId: 1, pointerType: "touch", clientX: 380, clientY: 40 });
        fireEvent.click(grip);
      });
    };
    tap(rows[0]);
    expect((rows[0] as HTMLElement).style.getPropertyValue("--swipe")).toBe(`${-DRAWER_WIDTH}px`);

    tap(rows[1]);
    expect((rows[0] as HTMLElement).style.getPropertyValue("--swipe")).toBe("0px");
    expect((rows[1] as HTMLElement).style.getPropertyValue("--swipe")).toBe(`${-DRAWER_WIDTH}px`);
  });

  // The hold fail-safe in `consumeSuppressedClick` refuses any click ending a
  // press of ≥ LONG_PRESS_MS, so that a hold can never NAVIGATE. The tab does
  // not navigate, so it opts out: a press held a beat too long — long enough
  // to trip that arm, but moved just enough to cancel the long-press timer —
  // would otherwise leave the newly-advertised control doing nothing at all.
  it("still opens the drawer when the tab is pressed slowly", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0] as HTMLElement;
    const grip = row.querySelector(".swipe-grip")!;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, pointerType: "touch", clientX: 380, clientY: 40 });
    // Past the long-press slop (so the timer is cancelled) but short of the
    // axis lock (so no swipe is ever committed), then held past the threshold.
    fireEvent.pointerMove(grip, { pointerId: 1, pointerType: "touch", clientX: 380, clientY: 40 + LONG_PRESS_SLOP_PX + 1 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
    fireEvent.pointerUp(grip, { button: 0, pointerId: 1, pointerType: "touch", clientX: 380, clientY: 40 + LONG_PRESS_SLOP_PX + 1 });
    // Selection mode must NOT have engaged — the slop break cancelled it.
    expect(container.querySelector("table.is-selecting")).toBeNull();

    act(() => { fireEvent.click(grip); });
    expect(row.style.getPropertyValue("--swipe")).toBe(`${-DRAWER_WIDTH}px`);
  });

  // The pull tab is a <button>, and useRowGestures refuses a press that starts
  // on a control — so making the tab tappable would have killed the very
  // gesture it advertises, right where a finger reaches for it. `.swipe-grip`
  // is excluded from that guard; this pins both halves of the result: the drag
  // still opens the drawer, and the click the release synthesises does not
  // then close it again.
  it("still starts a swipe when the finger lands on the pull tab", () => {
    const { container } = renderRows();
    const row = container.querySelectorAll("tbody tr")[0] as HTMLElement;
    const grip = row.querySelector(".swipe-grip") as HTMLButtonElement;

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, pointerType: "touch", clientX: 380, clientY: 40 });
    // Past the axis lock, then the full width of the drawer.
    fireEvent.pointerMove(grip, { pointerId: 1, pointerType: "touch", clientX: 380 - AXIS_LOCK_PX - 1, clientY: 40 });
    fireEvent.pointerMove(grip, { pointerId: 1, pointerType: "touch", clientX: 380 - DRAWER_WIDTH, clientY: 40 });
    act(() => {
      fireEvent.pointerUp(grip, { button: 0, pointerId: 1, pointerType: "touch", clientX: 380 - DRAWER_WIDTH, clientY: 40 });
    });
    expect(row.style.getPropertyValue("--swipe")).toBe(`${-DRAWER_WIDTH}px`);

    // The browser synthesises a click at the end of that gesture, and it lands
    // on the tab the finger lifted from. Toggling on it would slam the drawer
    // shut the instant the swipe opened it.
    act(() => { fireEvent.click(grip); });
    expect(row.style.getPropertyValue("--swipe")).toBe(`${-DRAWER_WIDTH}px`);
  });

  it("marks the card link undraggable, so iOS cannot start a link-drag on it", () => {
    const { container } = renderRows();
    const link = container.querySelector("td.cell-serial a.card-link")!;
    expect(link.getAttribute("draggable")).toBe("false");
  });

  it("turns a tap into a toggle once selection mode is on", () => {
    const second = { ...ROW, id: "item-3", serialNumber: "SN3" };
    const { container } = renderRows([ROW, second, RETIRED]);
    const rows = container.querySelectorAll("tbody tr");
    press(rows[0], LONG_PRESS_MS);
    fireEvent.pointerUp(rows[0], { button: 0, pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    expect(screen.getByText(/1 selected · /)).toBeTruthy();

    // A plain tap on the SECOND card — a fresh gesture, so nothing is left
    // suppressed. Selection mode alone has to turn the tap into a toggle,
    // otherwise the second tap navigates away and abandons the selection.
    const link = rows[1].querySelector("td.cell-serial a.card-link")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByText(/2 selected · /)).toBeTruthy();
  });

  // Outside the card layout the same table is an ordinary desktop table: a row
  // may well be checked, and clicking the serial there must still open it.
  it("leaves the link alone above the card breakpoint", () => {
    const { container } = renderRows();
    const rows = container.querySelectorAll("tbody tr");
    // Selected by checkbox, the way a desktop user does it — no gesture, so
    // nothing is suppressed and only the layout check can decide this click.
    act(() => { fireEvent.click(rows[0].querySelector("input[type=checkbox]")!); });
    expect(screen.getByText(/1 selected · /)).toBeTruthy();

    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    const link = rows[0].querySelector("td.cell-serial a.card-link")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { link.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(false);
  });
});

/**
 * The "Sort & filter" popup menu, which replaced four toolbar controls (Sort
 * by, Asc/Desc, Then by, Unit). The panel now holds those same four as native
 * <select>s rather than the radio lists it shipped with.
 *
 * READ THIS BEFORE ADDING A TEST HERE. **jsdom implements no Popover API at
 * all** — `showPopover` is undefined and `:popover-open` never matches — while
 * it DOES apply the UA's `[popover]:not(:popover-open) { display: none }`. So
 * the panel is permanently hidden in this environment and there is no way to
 * open it: every query into it passes `hidden: true`, and none of these tests
 * exercises opening, dismissing or focus.
 *
 * TWO CONSEQUENCES, both deliberate:
 *   - None of this is evidence that the sheet clears the safe-area inset, that
 *     the dropdown anchors under its button, that Escape returns focus to the
 *     trigger, or that a tap outside closes it. That was measured in a real
 *     browser at 390x844 and at desktop width.
 *   - `useDismissSwallowsTap` is INERT here. It gates on
 *     `matches(":popover-open")`, which jsdom answers false for, so the
 *     swallow never arms and cannot be unit-tested. The behaviour it fixes —
 *     an outside tap closing the menu AND pressing "Import CSV" underneath —
 *     is browser-verified only.
 */
describe("ItemSelectTable — Sort & filter menu", () => {
  const MENU_ID = "items-sortfilter";

  beforeEach(() => push.mockClear());

  function renderMenu(props: Partial<Parameters<typeof ItemSelectTable>[0]> = {}) {
    return renderTable(
      <ItemSelectTable
        items={[]}
        isAdmin
        q=""
        sort="make"
        dir="asc"
        page={1}
        totalPages={1}
        sortKeys={[{ key: "make", dir: "asc" }]}
        uic="" needsRename={false}
        uics={["WABC01", "WXYZ99"]}
        categories={[]}
        {...props}
      />,
    );
  }

  // `hidden: true` throughout — see the note above; the panel can never be
  // opened here, so the accessibility tree excludes all of it.
  const fieldNamed = (name: string) =>
    screen.getByRole("combobox", { name, hidden: true }) as HTMLSelectElement;
  const optionsOf = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);

  // The whole reason this component splits its markup the way it does. The UA
  // hides a closed popover with `[popover]:not(:popover-open) { display: none }`
  // and any author `display` rule beats it — identical to the closed-<dialog>
  // bug pinned above, which put 50 invisible boxes over this page's Delete
  // buttons. jsdom has no layout engine and cannot see the resulting overlay;
  // the structural invariant that prevents it is what it CAN assert.
  it("puts the panel's styling classes on an inner wrapper, never on the [popover] element", () => {
    const { container } = renderMenu();
    const popover = container.querySelector(`#${MENU_ID}`)!;
    expect(popover).not.toBeNull();
    expect(popover.getAttribute("popover")).toBe("auto");
    expect(popover.getAttribute("class")).toBeNull();
    const panel = popover.querySelector(":scope > .popup-menu__panel");
    expect(panel).not.toBeNull();
    // And the content lives inside that wrapper, not beside it.
    expect(within(panel as HTMLElement).getByRole("combobox", { name: "Sort by", hidden: true })).toBeTruthy();
  });

  // popovertarget is what supplies the implicit aria-expanded/aria-details
  // pair, focus-order insertion and Escape-with-focus-return. Break the id
  // reference and all of that silently goes away while the button still looks
  // fine — and nothing in this file could tell, because jsdom implements none
  // of those behaviours to begin with.
  it("wires the trigger to the panel by id, and the panel is its next sibling", () => {
    const { container } = renderMenu();
    const trigger = screen.getByRole("button", { name: /Sort & filter/ });
    expect(trigger.getAttribute("popovertarget")).toBe(MENU_ID);
    // The card lives in a <table> that contains the Retire <form>, and a bare
    // button defaults to submit.
    expect(trigger.getAttribute("type")).toBe("button");
    // The chevron's open-state rotation selector is
    // `.menu-trigger:has(+ [popover]:popover-open)`, and the outside-tap
    // swallow finds the panel by id — both need this adjacency to hold.
    expect(trigger.nextElementSibling).toBe(container.querySelector(`#${MENU_ID}`));
  });

  // With the panel closed, the trigger is the only thing saying what order the
  // list is in — which the four selects used to answer just by being on screen.
  it("reads the current sort and unit back on the closed trigger", () => {
    renderMenu({ uic: "WABC01" });
    expect(screen.getByRole("button", { name: /Sort & filter/ }).textContent).toContain("Make ▲ · WABC01");
  });

  it("offers the four fields as selects, each showing the current value", () => {
    renderMenu({ uic: "WXYZ99" });
    expect(fieldNamed("Unit").value).toBe("WXYZ99");
    expect(fieldNamed("Sort by").value).toBe("make");
    expect(fieldNamed("Direction").value).toBe("asc");
    expect(fieldNamed("Then by").value).toBe("");
  });

  it("falls back to Default (newest) when nothing is sorted", () => {
    renderMenu({ sort: null, sortKeys: [] });
    expect(fieldNamed("Sort by").value).toBe("");
    expect(screen.getByRole("button", { name: /Sort & filter/ }).textContent).toContain("Newest");
  });

  // A tie-breaker with nothing to break is meaningless, and the default
  // (newest) order has no ties worth resolving. The old toolbar enforced this
  // with `disabled={!sort}` on both selects.
  it("leaves Direction and Then by inert until a primary key is chosen", () => {
    renderMenu({ sort: null, sortKeys: [] });
    expect(fieldNamed("Direction").disabled).toBe(true);
    expect(fieldNamed("Then by").disabled).toBe(true);
  });

  it("enables them once a primary key is set", () => {
    renderMenu();
    expect(fieldNamed("Direction").disabled).toBe(false);
    expect(fieldNamed("Then by").disabled).toBe(false);
  });

  // Ordering a column within itself resolves nothing, and parseSortKeys
  // collapses a duplicate to its first occurrence anyway — so offering it would
  // be a choice with no effect.
  it("excludes the primary key from the Then by options", () => {
    renderMenu();
    const thenBy = optionsOf(fieldNamed("Then by"));
    expect(thenBy).not.toContain("Make");
    expect(thenBy).toContain("Model");
    // Every other sortable column is still offered, plus the "—" opt-out.
    expect(thenBy).toHaveLength(SORTABLE_COLUMNS.length);
    // Sort by offers all of them, plus its own default.
    expect(optionsOf(fieldNamed("Sort by"))).toHaveLength(SORTABLE_COLUMNS.length + 1);
  });

  it("pushes the chosen sort key, keeping the current direction", () => {
    renderMenu();
    act(() => { fireEvent.change(fieldNamed("Sort by"), { target: { value: "model" } }); });
    expect(push).toHaveBeenCalledWith("/items?sort=model&dir=asc");
  });

  // The menu offers Ascending and Descending as two options, so it asks for a
  // direction outright. A flip would make re-picking the current one reverse
  // the list.
  it("pushes a direction outright rather than flipping it", () => {
    renderMenu();
    act(() => { fireEvent.change(fieldNamed("Direction"), { target: { value: "desc" } }); });
    expect(push).toHaveBeenCalledWith("/items?sort=make&dir=desc");
  });

  // Compound sort travels as two parallel comma lists the server pairs
  // positionally, so they must always be written together and in the same
  // order. ItemSelectTable's hrefFor is the only thing that writes them — the
  // menu never builds a URL.
  it("pushes a compound sort as paired comma lists", () => {
    renderMenu();
    act(() => { fireEvent.change(fieldNamed("Then by"), { target: { value: "serialNumber" } }); });
    expect(push).toHaveBeenCalledWith("/items?sort=make%2CserialNumber&dir=asc%2Casc");
  });

  it("pushes a unit filter and drops back to page 1", () => {
    renderMenu({ page: 3 });
    act(() => { fireEvent.change(fieldNamed("Unit"), { target: { value: "WXYZ99" } }); });
    expect(push).toHaveBeenCalledWith("/items?sort=make&dir=asc&uic=WXYZ99");
  });

  it("clears the unit filter from All units", () => {
    renderMenu({ uic: "WXYZ99" });
    act(() => { fireEvent.change(fieldNamed("Unit"), { target: { value: "" } }); });
    expect(push).toHaveBeenCalledWith("/items?sort=make&dir=asc");
  });

  // A lone "All units" option is a control that cannot change anything.
  it("offers no Unit field when there are no units to filter by", () => {
    renderMenu({ uics: [] });
    expect(screen.queryByRole("combobox", { name: "Unit", hidden: true })).toBeNull();
    expect(fieldNamed("Sort by")).toBeTruthy();
  });

  // Sheet-only, and hidden above 720px by globals.css. It closes the panel
  // through the platform, so it needs no handler and no state — but that only
  // holds while both attributes are present.
  it("closes the sheet through the platform, with no handler", () => {
    const { container } = renderMenu();
    const done = within(container.querySelector(".popup-menu__footer") as HTMLElement)
      .getByRole("button", { name: "Done", hidden: true });
    expect(done.getAttribute("popovertarget")).toBe(MENU_ID);
    expect(done.getAttribute("popovertargetaction")).toBe("hide");
  });

  // The four controls this replaced. Leaving one behind would mean two surfaces
  // writing the same querystring. Note the selects moved INTO the popover, so
  // this has to exclude the panel rather than look for selects at all.
  it("leaves no duplicate sort or unit control loose in the toolbar", () => {
    const { container } = renderMenu();
    const loose = [...container.querySelectorAll(".toolbar select")]
      .filter((el) => !el.closest(`#${MENU_ID}`));
    expect(loose).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^(Asc|Desc)/, hidden: true })).toBeNull();
  });
});
