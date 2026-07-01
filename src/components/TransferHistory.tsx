import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";

type Row = {
  id: string; status: string; isOverride: boolean;
  fromUserId: string | null; toUserId: string;
  fromUserName: string | null; toUserName: string;
  initiatedAt: Date; signedAt: Date | null;
};

export function TransferHistory({
  rows,
  viewerId,
  isAdmin = false,
}: {
  rows: Row[];
  viewerId?: string;
  isAdmin?: boolean;
}) {
  if (rows.length === 0) return <p className="empty">No transfers yet.</p>;
  return (
    <ul className="timeline">
      {rows.map((r) => {
        const canDownload =
          r.status === "COMPLETED" &&
          (isAdmin || r.fromUserId === viewerId || r.toUserId === viewerId);
        return (
          <li key={r.id}>
            <div className="row" style={{ gap: 8 }}>
              <span className="who">{r.fromUserName ?? "Initial assignment"} → {r.toUserName}</span>
              <StatusBadge status={r.status} />
              {r.isOverride && <span className="badge badge-override">Override</span>}
              {canDownload && (
                <a href={`/transfers/${r.id}/receipt`} className="btn btn-ghost btn-sm spacer">
                  Hand receipt (PDF)
                </a>
              )}
            </div>
            <div className="meta">
              Initiated {formatDateTimeHST(r.initiatedAt)}
              {r.signedAt ? ` · signed ${formatDateTimeHST(r.signedAt)}` : ""}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
