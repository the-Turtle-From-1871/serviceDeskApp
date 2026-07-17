import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listActiveQueue } from "@/modules/service-queue/service-queue.service";
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

  const rows = await listActiveQueue();
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
