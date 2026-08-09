import { describe, it, expect } from "vitest";
import { navItemsFor, isActive, activeHref } from "./nav";

describe("navItemsFor", () => {
  it("logged out: Search + Sign in", () => {
    expect(navItemsFor({ loggedIn: false, isAdmin: false })).toEqual([
      { label: "Search", href: "/", icon: "search" },
      { label: "Sign in", href: "/login", icon: "signin" },
    ]);
  });
  it("user: Search, Items", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: false })).toEqual([
      { label: "Search", href: "/", icon: "search" },
      { label: "Items", href: "/items", icon: "items" },
      { label: "Receipts", href: "/receipts", icon: "receipts" },
    ]);
  });
  // Queue and Users returned as top-level entries (they had been folded into
  // the Dashboard hub in 4dc1fe5 to keep the header short — a constraint a
  // bottom rail does not have). Dashboard remains the hub for Analytics,
  // Categories, Units, Audit and New item.
  it("admin: Search, Items, Queue, Users, Dashboard", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: true })).toEqual([
      { label: "Search", href: "/", icon: "search" },
      { label: "Items", href: "/items", icon: "items" },
      { label: "Queue", href: "/admin/queue", icon: "queue" },
      { label: "Users", href: "/admin/users", icon: "users" },
      { label: "Dashboard", href: "/admin", icon: "dashboard" },
    ]);
  });

  // Account is reached from the header's profile icon, not the nav list, so it
  // never consumes a rail tab. If it reappears here it becomes a tab again.
  it("never includes Account — that is the profile icon", () => {
    for (const flags of [
      { loggedIn: false, isAdmin: false },
      { loggedIn: true, isAdmin: false },
      { loggedIn: true, isAdmin: true },
    ]) {
      expect(navItemsFor(flags).map((i) => i.href)).not.toContain("/account");
    }
  });

  // The rail renders one icon per tab and would crash on an undefined
  // component. toEqual above catches a MISSING icon but not one added to a new
  // item with a key the rail does not map.
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

  // Five tabs is the practical ceiling at 375px before labels truncate.
  it("gives a non-admin a Receipts tab — it is one of their only destinations", () => {
    const labels = navItemsFor({ loggedIn: true, isAdmin: false }).map((i) => i.label);
    expect(labels).toContain("Receipts");
  });

  // A budget decision, NOT an access one: /receipts is open to every signed-in
  // account. An admin already spends four slots, and a sixth truncates labels
  // at 375px, so they reach it from the Dashboard hub instead.
  it("withholds the Receipts TAB from an admin to stay inside the rail budget", () => {
    const labels = navItemsFor({ loggedIn: true, isAdmin: true }).map((i) => i.label);
    expect(labels).not.toContain("Receipts");
  });

  it("is at most five items, the rail's tab budget", () => {
    expect(navItemsFor({ loggedIn: true, isAdmin: true }).length).toBeLessThanOrEqual(5);
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
  // The subtree answer is deliberately retained — activeHref, not this
  // predicate, is what resolves the Dashboard/Queue overlap.
  it("admin dashboard still matches its whole subtree", () => {
    expect(isActive("/admin", "/admin")).toBe(true);
    expect(isActive("/admin", "/admin/queue")).toBe(true);
    expect(isActive("/admin", "/admin/users")).toBe(true);
    expect(isActive("/admin", "/admin/items/new")).toBe(true);
    expect(isActive("/admin", "/items")).toBe(false);
  });
});

describe("activeHref", () => {
  const admin = navItemsFor({ loggedIn: true, isAdmin: true });

  // The whole reason this function exists: Queue and Users are inside the
  // Dashboard's subtree, so without "longest match wins" both would be marked.
  it("prefers the most specific match over the Dashboard subtree", () => {
    expect(activeHref(admin, "/admin/queue")).toBe("/admin/queue");
    expect(activeHref(admin, "/admin/users")).toBe("/admin/users");
  });
  it("keeps the deeper pages of a tab on that tab", () => {
    expect(activeHref(admin, "/admin/queue/some-id")).toBe("/admin/queue");
    expect(activeHref(admin, "/items/abc/transfer")).toBe("/items");
  });
  it("falls back to Dashboard for admin pages with no tab of their own", () => {
    expect(activeHref(admin, "/admin")).toBe("/admin");
    expect(activeHref(admin, "/admin/audit")).toBe("/admin");
    expect(activeHref(admin, "/admin/analytics")).toBe("/admin");
    expect(activeHref(admin, "/admin/categories")).toBe("/admin");
    expect(activeHref(admin, "/admin/units")).toBe("/admin");
    expect(activeHref(admin, "/admin/items/new")).toBe("/admin");
  });
  it("marks Search on the home page only", () => {
    expect(activeHref(admin, "/")).toBe("/");
    expect(activeHref(admin, "/items")).toBe("/items");
  });
  // /account has no nav item — the profile icon carries the marker instead.
  it("returns null where no item matches", () => {
    expect(activeHref(admin, "/account")).toBeNull();
    expect(activeHref(admin, "/receipts/HR-000001")).toBeNull();
  });
  it("never marks an admin tab for a non-admin, who has no such items", () => {
    const user = navItemsFor({ loggedIn: true, isAdmin: false });
    expect(activeHref(user, "/admin/queue")).toBeNull();
  });
});
