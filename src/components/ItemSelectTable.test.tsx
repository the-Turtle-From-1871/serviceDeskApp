// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ItemSelectTable } from "./ItemSelectTable";

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
});
