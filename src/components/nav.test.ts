import { describe, it, expect } from "vitest";
import { navItemsFor, isActive } from "./nav";

describe("navItemsFor", () => {
  it("logged out: Search + Staff sign in", () => {
    expect(navItemsFor({ loggedIn: false, isAdmin: false })).toEqual([
      { label: "Search", href: "/", icon: "search" },
      { label: "Staff sign in", href: "/login", icon: "signin" },
    ]);
  });
  it("user: Search, Items, Account", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: false })).toEqual([
      { label: "Search", href: "/", icon: "search" },
      { label: "Items", href: "/items", icon: "items" },
      { label: "Account", href: "/account", icon: "account" },
    ]);
  });
  // Queue, Users, Audit, and New item moved OFF the header and under the
  // Dashboard hub (/admin) — see admin/page.tsx. The admin header is now just
  // Search, Items, Dashboard, Account.
  it("admin: Search, Items, Dashboard, Account", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: true })).toEqual([
      { label: "Search", href: "/", icon: "search" },
      { label: "Items", href: "/items", icon: "items" },
      { label: "Dashboard", href: "/admin", icon: "dashboard" },
      { label: "Account", href: "/account", icon: "account" },
    ]);
  });

  // Every item must carry an icon: the mobile bottom rail renders one per tab
  // and would otherwise crash on an undefined component. A toEqual above would
  // catch a MISSING icon, but not one added to a new item with a key the rail
  // does not map.
  it("every nav item carries an icon", () => {
    for (const flags of [
      { loggedIn: false, isAdmin: false },
      { loggedIn: true, isAdmin: false },
      { loggedIn: true, isAdmin: true },
    ]) {
      for (const item of navItemsFor(flags)) {
        expect(item.icon, `${item.label} has no icon`).toBeTruthy();
      }
    }
  });
});

describe("isActive", () => {
  it("home matches only exactly", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/items")).toBe(false);
  });
  it("non-home matches self and subtree", () => {
    expect(isActive("/items", "/items")).toBe(true);
    expect(isActive("/items", "/items/abc/transfer")).toBe(true);
    expect(isActive("/items", "/admin/items/new")).toBe(false);
    expect(isActive("/admin/users", "/admin/audit")).toBe(false);
  });
  // Now that Queue/Users/Audit/New item live under the Dashboard hub, "/admin"
  // matches its whole subtree so Dashboard stays highlighted across the admin
  // area (it no longer competes with separate sub-links in the header).
  it("admin dashboard matches its whole subtree", () => {
    expect(isActive("/admin", "/admin")).toBe(true);
    expect(isActive("/admin", "/admin/queue")).toBe(true);
    expect(isActive("/admin", "/admin/users")).toBe(true);
    expect(isActive("/admin", "/admin/items/new")).toBe(true);
    // but not non-admin pages
    expect(isActive("/admin", "/items")).toBe(false);
  });
});
