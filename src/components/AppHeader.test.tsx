// @vitest-environment jsdom
//
// The mobile nav is a fixed bottom rail, not a hamburger dropdown. Both navs
// are rendered at every width and CSS alone decides which is visible (see the
// .nav-rail block in globals.css), so these tests pin the MARKUP contract the
// stylesheet depends on — jsdom has no layout engine and can prove nothing
// about the rail's position, height or safe-area padding. That has to be
// measured in a real browser.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const pathname = vi.fn(() => "/items");
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
}));

// The header's SignOutButton imports a Server Action. Next only ships a
// reference to the client, but Vitest really imports the module — which drags
// next-auth (and Prisma behind it) into jsdom. The button's job here is just to
// be present, so stub the action.
vi.mock("@/app/actions/auth", () => ({ logoutAction: vi.fn() }));

import { AppHeader } from "./AppHeader";
import { navItemsFor } from "./nav";

afterEach(cleanup);

const rail = () => screen.getByRole("navigation", { name: "Main" });

describe("AppHeader bottom rail", () => {
  it("renders one tab per nav item, for each role", () => {
    for (const [flags, expected] of [
      [{ loggedIn: false, isAdmin: false }, ["Search", "Staff sign in"]],
      [{ loggedIn: true, isAdmin: false }, ["Search", "Items", "Account"]],
      [{ loggedIn: true, isAdmin: true }, ["Search", "Items", "Dashboard", "Account"]],
    ] as const) {
      render(<AppHeader items={navItemsFor(flags)} loggedIn={flags.loggedIn} />);
      const tabs = within(rail()).getAllByRole("link");
      expect(tabs.map((t) => t.textContent)).toEqual([...expected]);
      cleanup();
    }
  });

  it("gives every tab an icon, so a tab is never a bare label", () => {
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    for (const tab of within(rail()).getAllByRole("link")) {
      expect(tab.querySelector("svg")).not.toBeNull();
    }
  });

  it("marks only the active tab, matching the header nav's own active link", () => {
    pathname.mockReturnValue("/items");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);

    const current = within(rail())
      .getAllByRole("link")
      .filter((t) => t.getAttribute("aria-current") === "page");
    expect(current.map((t) => t.textContent)).toEqual(["Items"]);
    // Both navs are in the DOM at once; they must agree about where we are.
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(2);
  });

  it("keeps Dashboard active across the admin subtree", () => {
    pathname.mockReturnValue("/admin/queue");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    const current = within(rail())
      .getAllByRole("link")
      .filter((t) => t.getAttribute("aria-current") === "page");
    expect(current.map((t) => t.textContent)).toEqual(["Dashboard"]);
  });

  it("has no hamburger toggle left to open a menu that no longer exists", () => {
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    expect(screen.queryByRole("button", { name: /menu/i })).toBeNull();
    expect(document.querySelector(".nav-toggle")).toBeNull();
  });

  it("keeps Sign out out of the rail — it lives on /account now", () => {
    pathname.mockReturnValue("/account");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: false })} loggedIn />);
    expect(within(rail()).queryByText(/sign out/i)).toBeNull();
  });
});
