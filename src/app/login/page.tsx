import Link from "next/link";
import { LoginForm } from "./LoginForm";
import { turnstileWidgetSiteKey } from "@/lib/turnstile";

// Rendered per REQUEST, never prerendered. Today the root layout reads the
// session, so every route is already dynamic — but if that ever changed, the
// challenge's config gate would be evaluated at BUILD time while
// `verifyTurnstile` still reads its secret per request. The two halves could
// then disagree: a page built before the secret was added renders no widget and
// submits no token, while the server has the secret and refuses every sign-in.
// That is a total auth outage caused by deploy ORDER, so it is pinned here.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 380 }}>
        <Link href="/" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}>← Back to search</Link>
        <div className="stack-sm">
          <div className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Sign in</h1>
          <p className="subtle">Sign in to log items and create hand receipts.</p>
        </div>
        <LoginForm turnstileSiteKey={turnstileWidgetSiteKey()} />
      </div>
    </div>
  );
}
