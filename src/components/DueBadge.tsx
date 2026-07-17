import { dueState } from "@/modules/timers/due";

// Colored due/overdue pill shared by the queue table, dashboard, and receipt
// page. Takes an ISO string (RSC-serializable) and an optional `now` epoch so
// callers can pass a single stable timestamp for a whole list. No "use client"
// and no browser-only APIs — safe to render from a server component.
export function DueBadge({ dueAt, now }: { dueAt: string | null; now?: number }) {
  const state = dueState(dueAt ? new Date(dueAt) : null, now != null ? new Date(now) : undefined);
  if (state.state === "none") return <span className="subtle">—</span>;
  const label =
    state.state === "overdue" ? `Overdue ${Math.abs(state.days)}d`
    : `Due in ${state.days}d`;
  const cls =
    state.state === "overdue" ? "due-badge due-badge--overdue"
    : state.state === "soon" ? "due-badge due-badge--soon"
    : "due-badge due-badge--ontrack";
  return <span className={cls}>{label}</span>;
}
