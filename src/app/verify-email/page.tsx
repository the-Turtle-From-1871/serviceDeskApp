import Link from "next/link";
import { verifyEmailWithToken } from "@/lib/email-verification";
import { ResendVerificationForm } from "@/components/ResendVerificationForm";

// Consumes the token, so it must never be cached or prerendered.
export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";
  // ONE generic failure for all four ways this can fail — unknown, expired,
  // already used, or lost to a concurrent claim. Distinguishing them would tell
  // a stranger which tokens exist.
  const result = token ? await verifyEmailWithToken(token) : { ok: false as const };

  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 420 }}>
        <div className="stack-sm">
          <div className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </div>
          <h1 className="page-title" style={{ fontSize: 20 }}>
            {result.ok ? "Email confirmed" : "This link didn’t work"}
          </h1>
        </div>

        {result.ok ? (
          <>
            <p className="alert-success">
              Your email address is confirmed. You can sign in now.
            </p>
            <Link href="/login" className="btn btn-primary btn-block">Sign in</Link>
          </>
        ) : (
          <>
            <p className="alert-error" role="alert">
              This confirmation link is invalid or has expired. Links last 24 hours and can only
              be used once.
            </p>
            <p className="subtle">
              Enter your email address and we&rsquo;ll send a new one.
            </p>
            <ResendVerificationForm />
            <Link href="/login" className="btn btn-ghost btn-block">Back to sign in</Link>
          </>
        )}
      </div>
    </div>
  );
}
