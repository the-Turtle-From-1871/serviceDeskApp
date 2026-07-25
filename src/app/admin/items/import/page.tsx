import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { ImportItemsForm } from "./ImportItemsForm";

// A full-fleet MDM refresh is an all-UPDATE import that runs a bounded but
// sequential per-row write loop inside commitImportAction (a Server Action of
// this route). Without this, the platform's default serverless function
// timeout (~10-15s) would kill it mid-transaction and roll the whole import
// back long before the DB-side transaction budget. 60s is the Hobby cap and is
// valid on Pro; the commitImport $transaction timeout is set just under it so a
// too-large import aborts cleanly rather than being killed. Very large imports
// (thousands of rows at high latency) still want the deferred chunking follow-up.
export const maxDuration = 60;

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
        <p className="subtle">Bulk-create or update items from a CSV. A row whose serial number already exists updates that item in place; a new serial creates one.</p>
      </div>
      <ImportItemsForm />
    </div>
  );
}
