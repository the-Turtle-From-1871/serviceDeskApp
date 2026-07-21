import { redirect } from "next/navigation";
import { requireUser, AuthError } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { SiteHeader } from "@/components/SiteHeader";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { SignatureSettings } from "./SignatureSettings";
import { listSignatureNames } from "@/modules/signatures/signatures.service";
import { SignatureManager } from "./SignatureManager";

export default async function AccountPage() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) redirect("/login");
    throw e;
  }
  const isAdmin = user.role === "ADMIN";
  // Admins use named signatures; everyone else keeps the single saved signature.
  const [me, signatures] = await Promise.all([
    isAdmin ? Promise.resolve(null) : prisma.user.findUnique({ where: { id: user.id }, select: { signatureImage: true } }),
    isAdmin ? listSignatureNames(user.id) : Promise.resolve([]),
  ]);

  return (
    <>
      <SiteHeader />
      <main className="container container-narrow stack">
        <div>
          <h1 className="page-title">Account</h1>
          <p className="subtle">{user.name} · {user.email}</p>
        </div>
        <div className="card stack">
          <div className="card__title">Signature</div>
          {isAdmin ? (
            <>
              <p className="subtle">
                Save a signature for each technician. When you accept a return you pick who
                signed, and that name is printed on the hand receipt.
              </p>
              <SignatureManager signatures={signatures} />
            </>
          ) : (
            <>
              <p className="subtle">Save a signature to reuse it with one click when you accept returns.</p>
              <SignatureSettings current={me?.signatureImage ?? null} />
            </>
          )}
        </div>
        <div className="card stack">
          <div className="card__title">Change password</div>
          <ChangePasswordForm />
        </div>
      </main>
    </>
  );
}
