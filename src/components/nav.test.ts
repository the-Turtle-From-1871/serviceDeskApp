import { describe, it, expect } from "vitest";
import { navItemsFor, isActive } from "./nav";

describe("navItemsFor", () => {
  it("logged out: Search + Staff sign in", () => {
    expect(navItemsFor({ loggedIn: false, isAdmin: false })).toEqual([
      { label: "Search", href: "/" },
      { label: "Staff sign in", href: "/login" },
    ]);
  });
  it("user: Search, Items, Account", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: false })).toEqual([
      { label: "Search", href: "/" },
      { label: "Items", href: "/items" },
      { label: "Account", href: "/account" },
    ]);
  });
  // Queue, Users, Audit, and New item moved OFF the header and under the
  // Dashboard hub (/admin) — see admin/page.tsx. The admin header is now just
  // Search, Items, Dashboard, Account.
  it("admin: Search, Items, Dashboard, Account", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: true })).toEqual([
      { label: "Search", href: "/" },
      { label: "Items", href: "/items" },
      { label: "Dashboard", href: "/admin" },
      { label: "Account", href: "/account" },
    ]);
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
