// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ServiceQueueTable } from "./ServiceQueueTable";
import { DRAWER_WIDTH } from "./swipe-row";
import type { QueueRowVM } from "./service-queue-view";

vi.mock("@/app/admin/actions/queue", () => ({ completeServiceAction: vi.fn() }));

// This suite runs without vitest `globals: true`, so @testing-library/react's
// auto-cleanup never registers. Mirrors ItemSelectTable.test.tsx.
afterEach(cleanup);

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
