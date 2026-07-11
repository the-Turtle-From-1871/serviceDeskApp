import Link from "next/link";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="center-screen">
        <div className="card stack" style={{ width: "100%", maxWidth: 380 }}>
          <div className="brand"><span className="brand__mark">HR</span>Hand Receipt</div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Invalid link</h1>
          <p className="subtle">This reset link is missing its token. Request a new one.</p>
          <Link href="/forgot-password" className="btn btn-primary btn-block">Request a new link</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <div className="card stack" style={{ width: "100%", maxWidth: 380 }}>
        <div className="stack-sm">
          <div className="brand"><span className="brand__mark">HR</span>Hand Receipt</div>
          <h1 className="page-title" style={{ fontSize: 20 }}>Set a new password</h1>
          <p className="subtle">Choose a new password for your account.</p>
        </div>
        <ResetPasswordForm token={token} />
      </div>
    </div>
  );
}
