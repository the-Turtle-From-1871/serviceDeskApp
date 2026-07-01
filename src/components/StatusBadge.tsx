// Maps an item or transfer status string to a coloured pill. Class names are
// defined in globals.css (.badge-active/.badge-pending/.badge-retired/...).
export function StatusBadge({ status }: { status: string }) {
  const cls = `badge badge-${status.toLowerCase()}`;
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return <span className={cls}>{label}</span>;
}
