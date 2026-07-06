import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { SignOutButton } from "@/components/SignOutButton";
import { AppHeader } from "@/components/AppHeader";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <>
      <AppHeader brandHref="/items">
        <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
        <Link href="/admin/items/new" className="btn btn-ghost btn-sm">New item</Link>
        <Link href="/admin/users" className="btn btn-ghost btn-sm">Users</Link>
        <Link href="/admin/audit" className="btn btn-ghost btn-sm">Audit</Link>
        <Link href="/account" className="btn btn-ghost btn-sm">Account</Link>
        <SignOutButton />
      </AppHeader>
      <main className="container">{children}</main>
    </>
  );
}
