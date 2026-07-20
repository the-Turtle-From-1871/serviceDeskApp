import Link from "next/link";
import { LoginForm } from "./LoginForm";

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
        <LoginForm />
      </div>
    </div>
  );
}
