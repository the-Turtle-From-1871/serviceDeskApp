import { redirect } from "next/navigation";
import { requireUser, AuthError } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { SiteHeader } from "@/components/SiteHeader";
import { SignOutButton } from "@/components/SignOutButton";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { SignatureSettings } from "./SignatureSettings";
import { listSignatureNames } from "@/modules/signatures/signatures.service";
import { SignatureManager } from "./SignatureManager";
import { listDrafts } from "@/modules/receipts/drafts.service";
import { DraftList } from "./DraftList";
import { PermissionsCard } from "./PermissionsCard";
import { listRequestsForUser } from "@/modules/users/permissions.service";

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
  const [me, signatures, drafts, permissionRequests] = await Promise.all([
    isAdmin ? Promise.resolve(null) : prisma.user.findUnique({ where: { id: user.id }, select: { signatureImage: true } }),
    isAdmin ? listSignatureNames(user.id) : Promise.resolve([]),
    listDrafts(user.id),
    listRequestsForUser(user.id),
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
          <div className="card__title">Draft hand receipts</div>
          <p className="subtle">
            In-progress receipts you saved from the builder. Resuming one restores what you
            typed — the signature is never saved, so you sign again before filing. Drafts are
            private to you and are removed automatically after 30 days.
          </p>
          <DraftList drafts={drafts} />
        </div>
        {/*  is the RESOLVED effective set from requireUser,
            so what this lists and what the server admits cannot drift. */}
        <PermissionsCard held={user.capabilities} requests={permissionRequests} />

        <div className="card stack">
          <div className="card__title">Change password</div>
          <ChangePasswordForm />
        </div>
        {/* On mobile this is the ONLY sign-out: the bottom nav rail replaced
            the header dropdown that used to hold it, and the rail's Account tab
            lands here. Desktop keeps the header button as well. */}
        <div className="card stack">
          <div className="card__title">Sign out</div>
          <p className="subtle">Sign out of this device.</p>
          <div className="row">
            <SignOutButton />
          </div>
        </div>
      </main>
    </>
  );
}
