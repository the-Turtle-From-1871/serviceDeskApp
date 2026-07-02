import Link from "next/link";
import { ReceiptSearch } from "@/components/ReceiptSearch";

export default function HomePage() {
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          <Link href="/login" className="btn btn-ghost btn-sm">Staff sign in</Link>
        </div>
      </header>
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Find your hand receipt</h1>
          <p className="subtle">Search by item serial number or receipt number (HR-XXXXXXXX) to view and download your receipt.</p>
        </div>
        <ReceiptSearch />
      </main>
    </>
  );
}
