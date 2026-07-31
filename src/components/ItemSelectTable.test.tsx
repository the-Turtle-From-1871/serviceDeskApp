// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ItemSelectTable } from "./ItemSelectTable";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/items",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/admin/actions/items", () => ({ toggleItemStatusAction: vi.fn() }));

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
