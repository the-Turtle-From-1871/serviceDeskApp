import { StatusBadge } from "@/components/StatusBadge";

type Row = {
  id: string; status: string; isOverride: boolean;
  fromUserName: string | null; toUserName: string;
  initiatedAt: Date; signedAt: Date | null;
};
export function TransferHistory({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="empty">No transfers yet.</p>;
  return (
    <ul className="timeline">
      {rows.map((r) => (
        <li key={r.id}>
          <div className="row" style={{ gap: 8 }}>
            <span className="who">{r.fromUserName ?? "Initial assignment"} → {r.toUserName}</span>
            <StatusBadge status={r.status} />
            {r.isOverride && <span className="badge badge-override">Override</span>}
          </div>
          <div className="meta">
            Initiated {new Date(r.initiatedAt).toLocaleString()}
            {r.signedAt ? ` · signed ${new Date(r.signedAt).toLocaleString()}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}
