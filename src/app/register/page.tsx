import Link from "next/link";
import { RegisterForm } from "./RegisterForm";
import { turnstileWidgetSiteKey } from "@/lib/turnstile";

// Rendered per REQUEST, for the same reason /login is: the Turnstile SECRET is
// read per request, so the page must not be prerendered into a state that
// disagrees with it. (The SITE key is inlined at build time regardless of
// rendering mode — see the note on login/page.tsx. Adding the Turnstile vars in
// Vercel without redeploying leaves the challenge silently off.)
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 420 }}>
        <Link href="/" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}>← Back to search</Link>
        <div className="stack-sm">
          <div className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Create an account</h1>
          <p className="subtle">
            A new account can look up equipment and see the hand receipts you are named on.
            Anything more — issuing receipts, editing items, processing returns — is requested
            from an administrator once you are signed in.
          </p>
        </div>
        <RegisterForm turnstileSiteKey={turnstileWidgetSiteKey()} />
      </div>
    </div>
  );
}
