import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";

// Custom 404 with the app's chrome. Handles both `notFound()` calls (e.g. an
// unknown receipt/item) and any unmatched URL across the app.
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack" style={{ paddingBlock: 48 }}>
        <div className="card stack-sm">
          <h1 className="page-title" style={{ fontSize: 22 }}>Page not found</h1>
          <p className="subtle">
            That page, receipt, or item doesn&apos;t exist — or the link is wrong.
          </p>
          <div className="row">
            <Link className="btn btn-primary" href="/">Back to search</Link>
          </div>
        </div>
      </main>
    </>
  );
}
