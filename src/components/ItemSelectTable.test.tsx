// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ItemSelectTable } from "./ItemSelectTable";
import { LONG_PRESS_MS, CARD_LAYOUT_QUERY } from "./swipe-row";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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
  return render(
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
  };

  function renderRow() {
    return render(
      <ItemSelectTable
        items={[ROW]}
        isAdmin
        q=""
        sort={null}
        dir="asc"
        page={1}
        totalPages={1}
        sortKeys={[]}
        uic=""
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
  };
  const RETIRED = { ...ROW, id: "item-2", serialNumber: "SN2", status: "RETIRED" as const };

  function renderRows(props: Partial<Parameters<typeof ItemSelectTable>[0]> = {}) {
    return render(
      <ItemSelectTable
        items={[ROW, RETIRED]}
        isAdmin
        q=""
        sort={null}
        dir="asc"
        page={1}
        totalPages={1}
        sortKeys={[]}
        uic=""
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
  };
  const RETIRED = { ...ROW, id: "item-2", serialNumber: "SN2", status: "RETIRED" as const };

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
  });
  afterEach(() => vi.useRealTimers());

  function renderRows(items = [ROW, RETIRED]) {
    return render(
      <ItemSelectTable
        items={items}
        isAdmin
        q=""
        sort={null}
        dir="asc"
        page={1}
        totalPages={1}
        sortKeys={[]}
        uic=""
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
