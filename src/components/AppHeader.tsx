"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/SignOutButton";
import { isActive, type NavItem } from "@/components/nav";

export function AppHeader({ items, loggedIn, brandHref = "/" }: { items: NavItem[]; loggedIn: boolean; brandHref?: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const pathname = usePathname();
  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link href={brandHref} className="brand" onClick={close}>
          <span className="brand__mark">HR</span>
          Hand Receipt
        </Link>
        <span className="spacer" />
        <button type="button" className="nav-toggle" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="nav-toggle__bar" />
          <span className="nav-toggle__bar" />
          <span className="nav-toggle__bar" />
        </button>
        <div className={`app-nav${open ? " app-nav--open" : ""}`} onClick={close}>
          {items.map((it) => {
            const active = isActive(it.href, pathname);
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
      </div>
    </header>
  );
}
