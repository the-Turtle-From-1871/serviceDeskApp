import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { SiteHeader } from "@/components/SiteHeader";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <>
      <SiteHeader />
      <main className="container">{children}</main>
    </>
  );
}
