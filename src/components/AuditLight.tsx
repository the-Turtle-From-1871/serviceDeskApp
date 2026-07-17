import { auditStateDisplay, type AuditState } from "@/modules/audit/audit.status";

// A colored dot for an item's audit status. `null` means not applicable (e.g. a
// retired item) and renders a neutral dash. The label is exposed via aria-label +
// title so the signal is never color-only.
export function AuditLight({ state }: { state: AuditState | null }) {
  if (!state) return <span className="subtle">—</span>;
  const { label, className } = auditStateDisplay(state);
  return (
    <span
      className={`audit-dot ${className}`}
      role="img"
      aria-label={`Audit: ${label}`}
      title={`Audit: ${label}`}
    />
  );
}
