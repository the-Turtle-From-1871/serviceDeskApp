"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Search,
  ClipboardList,
  Wrench,
  Users,
  LayoutDashboard,
  LogIn,
  CircleUserRound,
  type LucideIcon,
} from "lucide-react";
import { SignOutButton } from "@/components/SignOutButton";
import { activeHref, type NavIcon, type NavItem } from "@/components/nav";

// Resolved here rather than in nav.ts so that module stays pure — see NavIcon.
const ICONS: Record<NavIcon, LucideIcon> = {
  search: Search,
  items: ClipboardList,
  queue: Wrench,
  users: Users,
  dashboard: LayoutDashboard,
  signin: LogIn,
};

const ACCOUNT_HREF = "/account";

/**
 * Header nav on desktop, fixed bottom rail on mobile.
 *
 * Below the 720px breakpoint the header keeps the brand and the profile icon,
 * and the rail owns navigation, so there is no hamburger, no open/closed state
 * and no outside-click or Escape handling to get wrong — the destination is
 * always on screen.
 *
 * Account is NOT in `items` and so is never a rail tab: it is the profile icon
 * in the top-right corner, at every width, which is where it is looked for and
 * costs no tab. Sign out is not in the rail either — it is a card on /account
 * (plus the header button on desktop).
 *
 * Both navs render at every width; CSS decides which is visible. Duplicating
 * the links in the DOM is deliberate — the alternative is a viewport check in
 * JS, which a Server Component can't do and which would flash the wrong nav on
 * first paint.
 */
export function AppHeader({ items, loggedIn }: { items: NavItem[]; loggedIn: boolean }) {
  const pathname = usePathname();
  // Match the header width to the page's content width. The Items list uses the
  // wide container (.container-wide), so widen the header there too, keeping the
  // brand/nav aligned with the table edges instead of a narrower centered band.
  const wide = pathname === "/items";
  // ONE current item, by longest match — Queue and Users sit inside the
  // Dashboard's subtree, so marking every match would light two tabs at once.
  const current = activeHref(items, pathname);
  const onAccount = pathname === ACCOUNT_HREF || pathname.startsWith(ACCOUNT_HREF + "/");

  const profileIcon = loggedIn ? (
    <Link
      href={ACCOUNT_HREF}
      className={`profile-link${onAccount ? " is-active" : ""}`}
      aria-current={onAccount ? "page" : undefined}
      // The icon is the whole control, so it needs its own accessible name.
      aria-label="Account"
      title="Account"
    >
      <CircleUserRound className="profile-link__icon" aria-hidden="true" />
    </Link>
  ) : null;

  return (
    <>
      <header className="app-header">
        <div className={`app-header__inner${wide ? " app-header__inner--wide" : ""}`}>
          <Link href="/" className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </Link>
          <span className="spacer" />
          <div className="app-nav">
            {items.map((it) => {
              const active = it.href === current;
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={`btn btn-ghost btn-sm nav-link${active ? " is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  {it.label}
                </Link>
              );
            })}
            {loggedIn && <SignOutButton />}
          </div>
          {profileIcon}
        </div>
      </header>

      {/* aria-label distinguishes this from the header nav for a screen reader,
          which sees both landmarks regardless of which one CSS is showing. */}
      <nav className="nav-rail" aria-label="Main">
        {items.map((it) => {
          const active = it.href === current;
          const Icon = ICONS[it.icon];
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`nav-rail__item${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="nav-rail__icon" aria-hidden="true" />
              <span className="nav-rail__label">{it.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
