import type { ServiceType } from "@prisma/client";
import { computeDueAt } from "@/modules/timers/due";

// Default completion SLA per service type (whole days from when the item is
// flagged). Overridable per item on the flag UI.
export const SLA_DAYS: Record<ServiceType, number> = { REIMAGE: 3, REPAIR: 7, OTHER: 5 };

/** The completion deadline for a service item: `from` + (override or type default) days. */
export function computeServiceDueAt(type: ServiceType, from: Date, overrideDays?: number | null): Date {
  const days = overrideDays != null ? overrideDays : SLA_DAYS[type];
  return computeDueAt(from, days);
}
