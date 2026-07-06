import { redirect } from "next/navigation";
import { requireUser, AuthError } from "@/lib/authz";
import { SiteHeader } from "@/components/SiteHeader";
import { ChangePasswordForm } from "./ChangePasswordForm";

export default async function AccountPage() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) redirect("/login");
    throw e;
  }

  return (
    <>
      <SiteHeader />

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
