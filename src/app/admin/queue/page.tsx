import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listActiveQueue, QUEUE_MAX_ROWS } from "@/modules/service-queue/service-queue.service";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";
import { ServiceQueueTable } from "@/components/ServiceQueueTable";
import type { QueueRowVM } from "@/components/service-queue-view";

export default async function AdminQueuePage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const { rows, truncated } = await listActiveQueue();
  const vms: QueueRowVM[] = rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    serialNumber: r.item.serialNumber,
    deviceName: r.item.deviceName,
    homeUnit: r.item.homeUnit,
    serviceTypeRaw: r.serviceType,
    serviceType: serviceTypeLabel(r.serviceType, r.serviceNote),
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
  }));

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Service queue</h1>
        <p className="subtle">
          Items flagged as needing service. Marking an item completed removes it from
          the queue — the record is retained and can be reopened from the item page.
        </p>
      </div>
      {/* Only ever rendered if the cap is actually hit. It has to name the
          consequence rather than just the number: the table's search, filter
          and sort all run in the browser over the rows it was given, so at the
          cap they cover this subset and NOT the whole queue — and "no matches"
          would otherwise be a confident wrong answer about a device that is
          sitting in service. */}
      {truncated && (
        <p role="status" className="alert-error">
          Showing the {QUEUE_MAX_ROWS} most recently flagged items. There are more in the
          queue, and the search, filter and sort below only cover the ones shown —
          mark items completed to bring the rest into view.
        </p>
      )}
      {vms.length === 0 ? (
        <div className="card">
          <p className="subtle">The queue is empty. Items flagged &ldquo;Needs service?&rdquo; appear here.</p>
        </div>
      ) : (
        <ServiceQueueTable rows={vms} />
      )}
    </div>
  );
}
