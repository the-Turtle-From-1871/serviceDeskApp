"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/SignOutButton";
import { isActive, type NavItem } from "@/components/nav";

export function AppHeader({ items, loggedIn }: { items: NavItem[]; loggedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const pathname = usePathname();
  const headerRef = useRef<HTMLElement>(null);
  // Match the header width to the page's content width. The Items list uses the
  // wide container (.container-wide), so widen the header there too, keeping the
  // brand/nav aligned with the table edges instead of a narrower centered band.
  const wide = pathname === "/items";

  // Close the open mobile menu on Escape or a tap/click outside the header.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <header className="app-header" ref={headerRef}>
      <div className={`app-header__inner${wide ? " app-header__inner--wide" : ""}`}>
        <Link href="/" className="brand" onClick={close}>
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
