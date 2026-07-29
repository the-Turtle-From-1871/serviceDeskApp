import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { turnstileWidgetSiteKey } from "@/lib/turnstile";

export default function ForgotPasswordPage() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 380 }}>
        <ForgotPasswordForm turnstileSiteKey={turnstileWidgetSiteKey()} />
      </div>
    </div>
  );
}
