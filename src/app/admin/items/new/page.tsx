import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { NewItemForm } from "./NewItemForm";

export default async function NewItemPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">New item</h1>
        <p className="subtle">Log a new item into inventory.</p>
        <Link href="/admin/items/import" className="btn btn-ghost btn-sm">Import CSV instead</Link>
      </div>
      <NewItemForm />
    </div>
  );
}
