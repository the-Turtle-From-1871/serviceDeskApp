import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { ImportItemsForm } from "./ImportItemsForm";

export default async function ImportItemsPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Import items</h1>
        <p className="subtle">Bulk-create items from a CSV. Duplicate serial numbers are skipped.</p>
      </div>
      <ImportItemsForm />
    </div>
  );
}
