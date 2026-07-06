"use client";
import { useState } from "react";
import Link from "next/link";

export function AppHeader({ brandHref = "/", children }: { brandHref?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link href={brandHref} className="brand" onClick={close}>
          <span className="brand__mark">HR</span>
          Hand Receipt
        </Link>
        <span className="spacer" />
        {children != null && (
          <button
            type="button"
            className="nav-toggle"
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="nav-toggle__bar" />
            <span className="nav-toggle__bar" />
            <span className="nav-toggle__bar" />
          </button>
        )}
        {/* Tapping a link (or anywhere in the panel) closes the menu. */}
        <div className={`app-nav${open ? " app-nav--open" : ""}`} onClick={close}>
          {children}
        </div>
      </div>
    </header>
  );
}
