import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 900, margin: "2rem auto" }}>
      <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <Link href="/admin/items">Items</Link>
        <Link href="/admin/items/new">New item</Link>
        <Link href="/admin/users">Users</Link>
        <Link href="/admin/audit">Audit</Link>
        <span style={{ marginLeft: "auto" }}><SignOutButton /></span>
      </nav>
      {children}
    </div>
  );
}
