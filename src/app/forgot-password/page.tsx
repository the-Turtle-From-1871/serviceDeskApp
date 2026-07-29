import { ForgotPasswordForm } from "./ForgotPasswordForm";
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

export default function ForgotPasswordPage() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 380 }}>
        <ForgotPasswordForm turnstileSiteKey={turnstileWidgetSiteKey()} />
      </div>
    </div>
  );
}
