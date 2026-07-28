import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { ImportItemsForm } from "./ImportItemsForm";

// A full-fleet MDM refresh is an all-UPDATE import running inside
// commitImportAction (a Server Action of this route). Without this, the
// platform's default serverless timeout (~10-15s) would kill it mid-transaction
// and roll the whole import back. 60s is the Hobby cap and is valid on Pro; the
// commitImport $transaction timeout sits just under it so a too-large import
// aborts cleanly rather than being killed.
//
// The headroom is far larger than it used to be: updates are now BATCHED by
// changed-column signature (UPDATE ... FROM (VALUES ...), chunked), so round
// trips no longer scale with row count. The previous per-row loop took ~1,000
// sequential round trips for a fleet refresh — 15-40s at hosted latency — and
// was what made a full re-import fail with a generic error.
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
        <p className="subtle">
          Bulk-create or update items from a CSV — including device category
          (<code>deviceType</code>), issuing unit (<code>deviceUIC</code>) and MDM
          telemetry. A row whose serial number already exists updates that item in place;
          a new serial creates one.
        </p>
      </div>
      <ImportItemsForm />
    </div>
  );
}
