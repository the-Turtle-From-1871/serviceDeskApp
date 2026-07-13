import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listActiveQueue } from "@/modules/service-queue/service-queue.service";
import { groupByDate } from "@/modules/service-queue/service-queue.group";
import { removeFromQueueAction } from "@/app/admin/actions/queue";

// Render a YYYY-MM-DD (UTC) group key as a readable heading, holding the day
// fixed by formatting in UTC so it matches the grouping boundary.
function formatDateHeading(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function AdminQueuePage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const items = await listActiveQueue();
  const groups = groupByDate(items);

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Service queue</h1>
        <p className="subtle">
          Receipts requiring active service or intervention, grouped by date. Removing an item flags
          it &ldquo;Ready to issue when needed&rdquo; — it is retained, not deleted.
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="card">
          <p className="subtle">The queue is empty. Newly ingested receipts appear here automatically.</p>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.date} className="stack">
            <h2 className="card__title">{formatDateHeading(group.date)}</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Items</th>
                    <th>Recipient</th>
                    <th>Unit</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((qi) => (
                    <tr key={qi.id}>
                      <td className="mono" data-label="Receipt">{qi.transfer.receiptNumber}</td>
                      <td data-label="Items">{qi.transfer.itemSummary}</td>
                      <td data-label="Recipient">{qi.transfer.receiverName}</td>
                      <td data-label="Unit">{qi.transfer.receiverUnit ?? "—"}</td>
                      <td data-label="">
                        <div className="actions" style={{ justifyContent: "flex-end" }}>
                          <form action={removeFromQueueAction}>
                            <input type="hidden" name="id" value={qi.id} />
                            <button type="submit" className="btn btn-ghost btn-sm">
                              Ready to issue
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
