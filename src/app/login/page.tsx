import Link from "next/link";
import { LoginForm } from "./LoginForm";
import { turnstileWidgetSiteKey } from "@/lib/turnstile";

// Rendered per REQUEST. Note this does NOT make the Turnstile SITE key
// request-time: Next inlines `process.env.NEXT_PUBLIC_*` at build time into the
// server bundle as well as the client one (`getNextPublicEnvironmentVariables`
// in next/dist/build/define-env.js), so the site key is a literal baked at build
// regardless of rendering mode.
//
// The consequence is operational, and DEPLOY.md now says so: adding the
// Turnstile vars in Vercel WITHOUT triggering a new build leaves the running
// server reading `undefined` for the site key — no widget renders,
// `verifyTurnstile` returns "skipped", and the challenge is silently off with
// nothing logged. Always redeploy after setting them.
//
// `force-dynamic` is kept for the SECRET half, which is read per request, and
// so the page cannot be prerendered into a state that disagrees with it.
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passwordChanged?: string }>;
}) {
  // Set by changePasswordAction, which signs the user out because changing a
  // password revokes every live session. Without this note the redirect reads
  // as "the app logged me out for no reason".
  const justChangedPassword = (await searchParams).passwordChanged === "1";

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
        {justChangedPassword && (
          <p className="alert-success">
            Your password has been changed, and you were signed out everywhere. Sign in with your new password.
          </p>
        )}
        <LoginForm turnstileSiteKey={turnstileWidgetSiteKey()} />
      </div>
    </div>
  );
}
