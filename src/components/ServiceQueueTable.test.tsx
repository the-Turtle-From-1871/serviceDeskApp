// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ServiceQueueTable } from "./ServiceQueueTable";
import { DRAWER_WIDTH } from "./swipe-row";
import { QUEUE_COLUMNS, type QueueRowVM } from "./service-queue-view";

vi.mock("@/app/admin/actions/queue", () => ({ completeServiceAction: vi.fn() }));

// This suite runs without vitest `globals: true`, so @testing-library/react's
// auto-cleanup never registers. Mirrors ItemSelectTable.test.tsx.
afterEach(cleanup);

// The sort and hidden-column prefs are localStorage-backed (`makeStore` in
// persisted-pref.ts) and jsdom keeps one storage per FILE, so without this a
// test that picks a sort leaks it into every test after it — which is exactly
// how the summary assertion below first read "Due ▲" before anything had been
// chosen. The store re-reads the key on every get(), so clearing is enough.
beforeEach(() => localStorage.clear());

const ROW: QueueRowVM = {
  id: "sq-1",
  itemId: "item-1",
  serialNumber: "SN1",
  deviceName: "Laptop 1",
  homeUnit: "COMPANY D",
  serviceType: "Repair",
  serviceTypeRaw: "REPAIR",
  dueAt: null,
};

/**
 * The "Sort & filter" menu, shared with /items via SortFilterMenu.
 *
 * jsdom implements NO Popover API — `showPopover` is undefined and
 * `:popover-open` never matches — while it DOES apply the UA's
 * `[popover]:not(:popover-open) { display: none }`. So the panel is permanently
 * closed here: every query needs `hidden: true`, and nothing below exercises
 * opening, dismissing or focus. `useDismissSwallowsTap` is inert for the same
 * reason. The sheet/dropdown layout and the outside-tap fix are browser-verified
 * only — see the matching note in ItemSelectTable.test.tsx.
 */
describe("ServiceQueueTable — Sort & filter menu", () => {
  const MENU_ID = "queue-sortfilter";
  const renderTable = () => render(<ServiceQueueTable rows={[ROW]} />);
  const fieldNamed = (name: string) =>
    screen.getByRole("combobox", { name, hidden: true }) as HTMLSelectElement;
  const optionsOf = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent);

  // The trap the whole component is built around, pinned here as it is for
  // /items: an author `display` on the [popover] element beats the UA rule that
  // hides it, so a closed panel would render and swallow taps meant for the
  // toolbar behind it. jsdom cannot see the overlay; it CAN see the structure.
  it("puts the panel's styling classes on an inner wrapper, never on the [popover] element", () => {
    const { container } = renderTable();
    const popover = container.querySelector(`#${MENU_ID}`)!;
    expect(popover).not.toBeNull();
    expect(popover.getAttribute("popover")).toBe("auto");
    expect(popover.getAttribute("class")).toBeNull();
    expect(popover.querySelector(".popup-menu__panel")).not.toBeNull();
  });

  // The id is the CSS hook — globals.css styles this popover by id precisely so
  // no shared class can grow a `display`. A renamed id silently loses every
  // rule, and the panel would render unstyled in the middle of the viewport.
  it("uses its own id, and the trigger points at it", () => {
    const { container } = renderTable();
    const trigger = container.querySelector("button.menu-trigger")!;
    expect(trigger.getAttribute("popovertarget")).toBe(MENU_ID);
    // Must stay the popover's immediate previous sibling: the chevron's open
    // state is read with `.menu-trigger:has(+ [popover]:popover-open)`.
    expect(trigger.nextElementSibling?.id).toBe(MENU_ID);
  });

  it("offers every queue column as a sort option, plus the default", () => {
    renderTable();
    expect(optionsOf(fieldNamed("Sort by"))).toEqual([
      "Default (newest)",
      ...QUEUE_COLUMNS.map((c) => c.label),
    ]);
  });

  // The queue's sortQueueRows takes ONE key, so a tie-breaker would be a control
  // that changes nothing. This is the deliberate difference from /items.
  it("offers no 'Then by' — the queue sorts on a single key", () => {
    renderTable();
    expect(screen.queryByRole("combobox", { name: "Then by", hidden: true })).toBeNull();
  });

  it("folds the service-type filter into the menu", () => {
    renderTable();
    expect(optionsOf(fieldNamed("Service type"))).toEqual([
      "All types", "Reimage", "Repair", "Other",
    ]);
  });

  // Direction is inert until something is being sorted — the same rule the old
  // toolbar enforced with `disabled={!sort.field}` on its Asc/Desc button.
  it("disables Direction until a sort key is chosen", () => {
    renderTable();
    expect(fieldNamed("Direction").disabled).toBe(true);
    fireEvent.change(fieldNamed("Sort by"), { target: { value: "due" } });
    expect(fieldNamed("Direction").disabled).toBe(false);
  });

  // The trigger is the only thing that reports the current order while the panel
  // is shut, which is most of the time.
  it("reads the current sort and filter back on the trigger", () => {
    const { container } = renderTable();
    const value = () => container.querySelector(".menu-trigger__value")!.textContent;
    expect(value()).toBe("Newest");

    fireEvent.change(fieldNamed("Sort by"), { target: { value: "due" } });
    expect(value()).toBe("Due ▲");

    fireEvent.change(fieldNamed("Direction"), { target: { value: "desc" } });
    expect(value()).toBe("Due ▼");

    fireEvent.change(fieldNamed("Service type"), { target: { value: "REPAIR" } });
    expect(value()).toBe("Due ▼ · Repair");
  });

  // The controls must actually drive the table, not just the summary.
  it("filters the rows by the service type chosen in the menu", () => {
    render(
      <ServiceQueueTable
        rows={[ROW, { ...ROW, id: "sq-2", itemId: "item-2", serialNumber: "SN2", serviceType: "Reimage", serviceTypeRaw: "REIMAGE" }]}
      />,
    );
    expect(screen.getAllByText(/^SN[12]$/).length).toBeGreaterThan(0);
    fireEvent.change(fieldNamed("Service type"), { target: { value: "REIMAGE" } });
    expect(screen.queryByText("SN1")).toBeNull();
    expect(screen.getAllByText("SN2").length).toBeGreaterThan(0);
  });
});

/**
 * The mobile card. As with /items, jsdom has no layout engine and no touch
 * screen, so none of this proves the card looks or feels right — that was
 * measured in a browser. What it pins is the structure the shared
 * `.table--cards` CSS depends on, so a later edit to this table cannot quietly
 * drift away from the one in ItemSelectTable.
 */
describe("ServiceQueueTable — mobile card structure", () => {
  const renderTable = (rows: QueueRowVM[] = [ROW]) => render(<ServiceQueueTable rows={rows} />);

  it("opts into the shared card treatment", () => {
    const { container } = renderTable();
    expect(container.querySelector("table.table.table--cards")).not.toBeNull();
  });

  it("makes the card a real link to the item, not a click handler", () => {
    const { container } = renderTable();
    const link = container.querySelector("td.cell-serial a.card-link");
    expect(link).not.toBeNull();
    // The queue row's own id is NOT the destination — the card opens the ITEM.
    expect(link!.getAttribute("href")).toBe("/i/item-1");
    // The visible serial must be in the accessible name (WCAG 2.5.3).
    expect(link!.getAttribute("aria-label")).toContain("SN1");
  });

  // Same reasoning as ItemSelectTable: the data cells are rendered
  // conditionally by the Columns menu, so a card built from them would lose its
  // heading — and with it the only way to open the item — when SN is hidden.
  it("still renders the card when the Columns menu has hidden almost everything", () => {
    window.localStorage.setItem(
      "queue:hiddenCols",
      JSON.stringify(["serialNumber", "deviceName", "homeUnit", "serviceType"]),
    );
    const { container } = renderTable();
    expect(container.querySelector("td.cell-serial a.card-link")).not.toBeNull();
    expect(container.querySelector("td.cell-primary")).not.toBeNull();
    expect(container.querySelector("td.cell-meta")).not.toBeNull();
    window.localStorage.clear();
  });

  it("puts Mark Completed in the drawer and keeps View out of it", () => {
    const { container } = renderTable();
    const drawer = container.querySelector("td.row-actions");
    expect(drawer).not.toBeNull();
    expect(drawer!.textContent).toContain("Mark Completed");
    // Present for the desktop table, flagged as the action the drawer hides
    // because tapping the card already is View.
    expect(drawer!.querySelector("a.action-view")).not.toBeNull();
  });

  // The tab is the tap half of the swipe, and the queue shares it with /items —
  // an identical-looking tab that only worked on one of the two tables would
  // read as a bug. No admin gate here: the whole route is behind requireAdmin.
  it("makes the pull tab a named button that opens the drawer", () => {
    const { container } = renderTable();
    const row = container.querySelector("tbody tr") as HTMLElement;
    const grip = row.querySelector(".swipe-grip") as HTMLButtonElement;
    expect(grip.tagName).toBe("BUTTON");
    // The card sits in a <table> carrying the Mark Completed <form>; a bare
    // button would default to submit.
    expect(grip.getAttribute("type")).toBe("button");
    expect(grip.getAttribute("aria-label")).toBe("Show actions");
    expect(row.style.getPropertyValue("--swipe")).toBe("0px");

    act(() => { fireEvent.click(grip); });
    expect(row.style.getPropertyValue("--swipe")).toBe(`${-DRAWER_WIDTH}px`);
    expect(grip.getAttribute("aria-label")).toBe("Hide actions");

    act(() => { fireEvent.click(grip); });
    expect(row.style.getPropertyValue("--swipe")).toBe("0px");
  });

  // The queue has no bulk selection, so it must not carry the selection-mode
  // scaffolding /items needs — no checkbox cell, and never the is-selecting
  // class that would give one a 44px box.
  it("renders no selection scaffolding", () => {
    const { container } = renderTable();
    expect(container.querySelector("td.cell-select")).toBeNull();
    expect(container.querySelector("table.is-selecting")).toBeNull();
  });
});
