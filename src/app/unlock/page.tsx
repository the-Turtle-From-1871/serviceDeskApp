import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { sanitizeNext } from "@/lib/public-access-cookie";
import { UnlockForm } from "./UnlockForm";

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = sanitizeNext(sp.next ?? "/");
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Enter the access PIN</h1>
          <p className="subtle">
            Access to hand receipts and item records is protected. Enter the 8-digit PIN to continue.
          </p>
        </div>
        <div className="card">
          <UnlockForm next={next} />
        </div>
        <p className="subtle">
          Staff? <Link href="/login">Log in</Link> instead.
        </p>
        {/* The wall is reachable directly (any /i/* or /receipts/* link lands
            here), so it needs a way to the page that explains what this
            application is — otherwise a first-time visitor's only impression of
            the site is a PIN prompt. */}
        <p className="subtle">
          New here? <Link href="/">Read what this application is for</Link>.
        </p>
      </main>
    </>
  );
}
