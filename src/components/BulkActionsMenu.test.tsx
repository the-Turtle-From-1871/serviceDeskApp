// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BulkActionsMenu } from "./BulkActionsMenu";

/**
 * READ THIS BEFORE ADDING A TEST HERE. **jsdom implements no Popover API at
 * all** — `showPopover` is undefined and `:popover-open` never matches — while
 * it DOES apply the UA's `[popover]:not(:popover-open) { display: none }`. So
 * the panel is permanently hidden in this environment and there is no way to
 * open it: every ROLE query into it passes `hidden: true`, and none of these
 * tests exercises opening, dismissing or focus. `useDismissSwallowsTap` (shared with
 * SortFilterMenu) is likewise INERT here — it gates on `:popover-open`.
 *
 * Nothing below is evidence that the sheet clears the safe-area inset, that the
 * dropdown anchors under its own button rather than the Sort & filter one, or
 * that a tap outside closes it without pressing what is underneath. All of that
 * is browser-only, at both widths.
 */

// There is no app-router context under render(), so useRouter() would throw.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// Server Actions cannot be imported into jsdom (they carry a "use server"
// directive and reach Prisma), so the module boundary is stubbed. These tests
// assert structure and capability gating only — no action is invoked.
vi.mock("@/app/admin/actions/audit", () => ({ recordAuditsAction: vi.fn() }));
vi.mock("@/app/admin/actions/queue", () => ({
  flagItemsForServiceAction: vi.fn(),
  completeServiceItemsAction: vi.fn(),
}));

// This suite runs without vitest `globals: true`, so @testing-library/react's
// auto-cleanup never registers. Mirrors ItemSelectTable.test.tsx.
afterEach(cleanup);

const SIGS = [{ id: "s1", name: "SGT Smith" }];

// jsdom applies the UA `display: none` to a closed popover, so the panel's
// contents are outside the accessibility tree — a ROLE query into it has to opt
// into hidden nodes. (getByLabelText/getByText do no such filtering and take no
// `hidden` option, so they reach the panel unaided.)
const hidden = { hidden: true } as const;

test("the popover element carries NO class — a layout class would render it while closed", () => {
  const { container } = render(
    <BulkActionsMenu itemIds={["a1"]} signatures={SIGS} canAudit canQueue />,
  );
  const popover = container.querySelector("[popover]");
  expect(popover).not.toBeNull();
  expect(popover!.getAttribute("popover")).toBe("auto");
  expect(popover!.getAttribute("class")).toBeNull();
  // The layout lives on an inner wrapper instead.
  expect(popover!.querySelector(":scope > .popup-menu__panel")).not.toBeNull();
});

// popovertarget is what supplies the implicit aria-expanded/aria-details pair,
// focus-order insertion and Escape-with-focus-return; the chevron's rotation
// selector (`.menu-trigger:has(+ [popover]:popover-open)`) and the outside-tap
// swallow both depend on the adjacency. jsdom implements none of those, so the
// wiring is all that can be pinned.
test("wires the trigger to the panel by id, and the panel is its next sibling", () => {
  const { container } = render(
    <BulkActionsMenu itemIds={["a1"]} signatures={SIGS} canAudit canQueue />,
  );
  const trigger = screen.getByRole("button", { name: /More actions/ });
  expect(trigger.getAttribute("popovertarget")).toBe("items-bulkactions");
  // This bar renders inside a page whose table contains the Retire <form>; a
  // bare button defaults to submit.
  expect(trigger.getAttribute("type")).toBe("button");
  expect(trigger.nextElementSibling).toBe(container.querySelector("#items-bulkactions"));
});

test("audit controls are absent without ADMINISTER", () => {
  const { unmount } = render(
    <BulkActionsMenu itemIds={["a1"]} signatures={SIGS} canAudit canQueue />,
  );
  expect(screen.getByLabelText(/sign as/i)).toBeTruthy();
  unmount();

  render(<BulkActionsMenu itemIds={["a1"]} signatures={[]} canAudit={false} canQueue />);
  expect(screen.queryByLabelText(/sign as/i)).toBeNull();
});

test("queue controls are absent without MANAGE_QUEUE", () => {
  const { unmount } = render(
    <BulkActionsMenu itemIds={["a1"]} signatures={SIGS} canAudit canQueue />,
  );
  expect(screen.getByLabelText(/service type/i)).toBeTruthy();
  unmount();

  render(<BulkActionsMenu itemIds={["a1"]} signatures={SIGS} canAudit canQueue={false} />);
  expect(screen.queryByLabelText(/service type/i)).toBeNull();
});

test("the whole menu is absent when the caller can do neither", () => {
  const { container } = render(
    <BulkActionsMenu itemIds={["a1"]} signatures={[]} canAudit={false} canQueue={false} />,
  );
  expect(container.querySelector("[popover]")).toBeNull();
  expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
});

// The signature list is the one thing that can be empty while the capability is
// held, and an empty <select> with no explanation reads as a broken control.
test("says why the audit control is unusable when there are no saved signatures", () => {
  render(<BulkActionsMenu itemIds={["a1"]} signatures={[]} canAudit canQueue={false} />);
  expect((screen.getByLabelText(/sign as/i) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText(/No saved signatures/i)).toBeTruthy();
});

// Nothing selected means nothing to act on. The bar that hosts this only
// renders with a selection, but the component is handed the ids directly, so it
// must not offer a button that would post an empty batch.
test("disables every control when the selection is empty", () => {
  render(<BulkActionsMenu itemIds={[]} signatures={SIGS} canAudit canQueue />);
  const trigger = screen.getByRole("button", { name: /More actions/ }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  for (const name of [/^Audit /, /^Flag for service$/, /^Complete service$/]) {
    expect((screen.getByRole("button", { name, ...hidden }) as HTMLButtonElement).disabled).toBe(true);
  }
});
