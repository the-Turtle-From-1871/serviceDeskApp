import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { turnstileWidgetSiteKey } from "@/lib/turnstile";

// Rendered per REQUEST, never prerendered. Today the root layout reads the
// session, so every route is already dynamic — but if that ever changed, the
// challenge's config gate would be evaluated at BUILD time while
// `verifyTurnstile` still reads its secret per request. The two halves could
// then disagree: a page built before the secret was added renders no widget and
// submits no token, while the server has the secret and refuses every sign-in.
// That is a total auth outage caused by deploy ORDER, so it is pinned here.
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
