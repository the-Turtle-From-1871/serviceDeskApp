import type { ServiceType } from "@prisma/client";

export type ServiceSelection = { serviceType: ServiceType; note: string | null; overrideDays: number | null };

export const SERVICE_TYPE_OPTIONS: { value: ServiceType; label: string }[] = [
  { value: "REIMAGE", label: "Reimage" },
  { value: "REPAIR", label: "Repair" },
  { value: "OTHER", label: "Other" },
];

// Parse an optional per-item SLA override — the builder `service[<id>][days]`
// field or the item-page `overrideDays` field. Returns a whole 1..3650 day
// count, or undefined for anything blank / non-integer / out-of-range, so the
// caller falls back to the service type's default SLA. Deliberately graceful
// (never throws, never yields 0) so one bad value can't block a receipt build,
// a flag, or a reopen — every entry point clamps to the default identically.
// Bound mirrors returnDays (transfers.schema) and setReceiptDueAtAction.
export function parseOverrideDays(raw: unknown): number | undefined {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return undefined; // blank, decimals ("12.9"), or garbage ("12abc") → default
  const n = Number(s);
  return n >= 1 && n <= 3650 ? n : undefined; // 0 or out-of-range → default
}

const VALID_TYPES = new Set<string>(SERVICE_TYPE_OPTIONS.map((o) => o.value));
// Matches service[<itemId>][needs|type|note|days]. itemId is a cuid (no brackets).
const FIELD_RE = /^service\[([^\]]+)\]\[(needs|type|note|days)\]$/;

// Pure extraction of the per-item "Needs service?" selections from a receipt
// form. Only rows whose `needs` is on AND whose `type` is a known ServiceType
// are returned. For OTHER the trimmed note is carried; otherwise note is null.
// Note validity (OTHER requires a note) is enforced later by upsertServiceRequest.
export function parseServiceMap(fd: FormData): Map<string, ServiceSelection> {
  const rows = new Map<string, { needs: boolean; type?: string; note?: string; days?: string }>();
  for (const [key, value] of fd.entries()) {
    const m = FIELD_RE.exec(key);
    if (!m) continue;
    const [, itemId, field] = m;
    const row = rows.get(itemId) ?? { needs: false };
    if (field === "needs") row.needs = value === "on" || value === "true";
    else if (field === "type") row.type = String(value);
    else if (field === "days") row.days = String(value);
    else row.note = String(value);
    rows.set(itemId, row);
  }

  const result = new Map<string, ServiceSelection>();
  for (const [itemId, row] of rows) {
    if (!row.needs || !row.type || !VALID_TYPES.has(row.type)) continue;
    const serviceType = row.type as ServiceType;
    const note = serviceType === "OTHER" ? (row.note ?? "").trim() || null : null;
    const overrideDays = parseOverrideDays(row.days) ?? null;
    result.set(itemId, { serviceType, note, overrideDays });
  }
  return result;
}
