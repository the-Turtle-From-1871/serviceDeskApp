type Row = {
  id: string; status: string; isOverride: boolean;
  fromUserName: string | null; toUserName: string;
  initiatedAt: Date; signedAt: Date | null;
};
export function TransferHistory({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p>No transfers yet.</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id}>
          <strong>{r.fromUserName ?? "—"} → {r.toUserName}</strong>
          {" · "}{r.status}{r.isOverride ? " (admin override)" : ""}
          {" · "}initiated {new Date(r.initiatedAt).toLocaleString()}
          {r.signedAt ? ` · signed ${new Date(r.signedAt).toLocaleString()}` : ""}
        </li>
      ))}
    </ul>
  );
}
