import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/admin/items" className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </Link>
          <nav className="nav">
            <Link href="/admin/items">Items</Link>
            <Link href="/admin/items/new">New item</Link>
            <Link href="/admin/users">Users</Link>
            <Link href="/admin/audit">Audit</Link>
          </nav>
          <span className="spacer" />
          <Link href="/account" className="btn btn-ghost btn-sm">Account</Link>
          <SignOutButton />
        </div>
      </header>
      <main className="container">{children}</main>
    </>
  );
}
