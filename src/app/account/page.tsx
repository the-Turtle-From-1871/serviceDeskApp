import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, AuthError } from "@/lib/authz";
import { SignOutButton } from "@/components/SignOutButton";
import { ChangePasswordForm } from "./ChangePasswordForm";

export default async function AccountPage() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) redirect("/login");
    throw e;
  }
  const home = user.role === "ADMIN" ? "/admin/items" : "/dashboard";

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href={home} className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </Link>
          <span className="spacer" />
          <Link href={home} className="btn btn-ghost btn-sm">Back</Link>
          <SignOutButton />
        </div>
      </header>

      <main className="container container-narrow stack">
        <div>
          <h1 className="page-title">Account</h1>
          <p className="subtle">{user.name} · {user.email}</p>
        </div>
        <div className="card stack">
          <div className="card__title">Change password</div>
          <ChangePasswordForm />
        </div>
      </main>
    </>
  );
}
