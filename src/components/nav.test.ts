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
  it("admin: Search, Items, New item, Users, Audit, Account", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: true })).toEqual([
      { label: "Search", href: "/" },
      { label: "Items", href: "/items" },
      { label: "New item", href: "/admin/items/new" },
      { label: "Users", href: "/admin/users" },
      { label: "Audit", href: "/admin/audit" },
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
});
