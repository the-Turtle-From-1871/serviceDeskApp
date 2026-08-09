// @vitest-environment jsdom
//
// The mobile nav is a fixed bottom rail, not a hamburger, and Account is the
// header's profile icon rather than a tab. Both navs are rendered at every
// width and CSS alone decides which is visible (see the .nav-rail block in
// globals.css), so these tests pin the MARKUP contract the stylesheet depends
// on — jsdom has no layout engine and can prove nothing about the rail's
// position, height or safe-area padding. That has to be measured in a browser.
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
const railTabs = () => within(rail()).getAllByRole("link");
const profile = () => screen.queryByRole("link", { name: "Account" });
const currentRailTabs = () =>
  railTabs()
    .filter((t) => t.getAttribute("aria-current") === "page")
    .map((t) => t.textContent);

describe("AppHeader bottom rail", () => {
  it("renders one tab per nav item, for each role", () => {
    for (const [flags, expected] of [
      [{ loggedIn: false, isAdmin: false }, ["Search", "Sign in"]],
      [{ loggedIn: true, isAdmin: false }, ["Search", "Items", "Receipts"]],
      [
        { loggedIn: true, isAdmin: true },
        ["Search", "Items", "Queue", "Users", "Dashboard"],
      ],
    ] as const) {
      render(<AppHeader items={navItemsFor(flags)} loggedIn={flags.loggedIn} />);
      expect(railTabs().map((t) => t.textContent)).toEqual([...expected]);
      cleanup();
    }
  });

  it("gives every tab an icon, so a tab is never a bare label", () => {
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    for (const tab of railTabs()) {
      expect(tab.querySelector("svg")).not.toBeNull();
    }
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

describe("AppHeader active tab", () => {
  it("marks exactly one tab, and the header nav agrees with the rail", () => {
    pathname.mockReturnValue("/items");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    expect(currentRailTabs()).toEqual(["Items"]);
    // Both navs are in the DOM at once; they must agree about where we are.
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(2);
  });

  // The regression this guards: Queue and Users sit inside /admin's subtree, so
  // a naive isActive() per item lights up TWO tabs and puts aria-current on two
  // links at once.
  it("marks Queue — not Dashboard — on the queue page", () => {
    pathname.mockReturnValue("/admin/queue");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    expect(currentRailTabs()).toEqual(["Queue"]);
  });

  it("marks Users — not Dashboard — on the users page", () => {
    pathname.mockReturnValue("/admin/users");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    expect(currentRailTabs()).toEqual(["Users"]);
  });

  it("falls back to Dashboard on an admin page with no tab of its own", () => {
    pathname.mockReturnValue("/admin/audit");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    expect(currentRailTabs()).toEqual(["Dashboard"]);
  });
});

describe("AppHeader profile icon", () => {
  it("is a link to /account, with an accessible name and an icon", () => {
    pathname.mockReturnValue("/items");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    const p = profile();
    expect(p).not.toBeNull();
    expect(p!.getAttribute("href")).toBe("/account");
    expect(p!.querySelector("svg")).not.toBeNull();
  });

  it("is absent when logged out — there is no account to reach", () => {
    pathname.mockReturnValue("/");
    render(<AppHeader items={navItemsFor({ loggedIn: false, isAdmin: false })} loggedIn={false} />);
    expect(profile()).toBeNull();
  });

  it("carries the current marker on /account, where no tab does", () => {
    pathname.mockReturnValue("/account");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    expect(currentRailTabs()).toEqual([]);
    expect(profile()!.getAttribute("aria-current")).toBe("page");
  });

  it("is not marked current anywhere else", () => {
    pathname.mockReturnValue("/items");
    render(<AppHeader items={navItemsFor({ loggedIn: true, isAdmin: true })} loggedIn />);
    expect(profile()!.getAttribute("aria-current")).toBeNull();
  });
});
