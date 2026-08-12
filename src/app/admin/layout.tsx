import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { SiteHeader } from "@/components/SiteHeader";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let isReadOnly = false;
  try {
    ({ isReadOnly } = await requireAdmin());
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <>
      <SiteHeader />
      <main className="container">
        {isReadOnly && <ReadOnlyBanner />}
        {children}
      </main>
    </>
  );
}
