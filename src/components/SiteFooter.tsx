import Link from "next/link";

// Site-wide footer with the legal links, rendered once in the root layout.
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <span className="subtle">© 2026 DCSIM Service Desk</span>
        <nav className="site-footer__links">
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms of Service</Link>
        </nav>
      </div>
    </footer>
  );
}
