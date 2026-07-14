import type { ServiceType } from "@prisma/client";

export type ServiceSelection = { serviceType: ServiceType; note: string | null };

export const SERVICE_TYPE_OPTIONS: { value: ServiceType; label: string }[] = [
  { value: "REIMAGE", label: "Reimage" },
  { value: "REPAIR", label: "Repair" },
  { value: "OTHER", label: "Other" },
];

const VALID_TYPES = new Set<string>(SERVICE_TYPE_OPTIONS.map((o) => o.value));
// Matches service[<itemId>][needs|type|note]. itemId is a cuid (no brackets).
const FIELD_RE = /^service\[([^\]]+)\]\[(needs|type|note)\]$/;

// Pure extraction of the per-item "Needs service?" selections from a receipt
// form. Only rows whose `needs` is on AND whose `type` is a known ServiceType
// are returned. For OTHER the trimmed note is carried; otherwise note is null.
// Note validity (OTHER requires a note) is enforced later by upsertServiceRequest.
export function parseServiceMap(fd: FormData): Map<string, ServiceSelection> {
  const rows = new Map<string, { needs: boolean; type?: string; note?: string }>();
  for (const [key, value] of fd.entries()) {
    const m = FIELD_RE.exec(key);
    if (!m) continue;
    const [, itemId, field] = m;
    const row = rows.get(itemId) ?? { needs: false };
    if (field === "needs") row.needs = value === "on" || value === "true";
    else if (field === "type") row.type = String(value);
    else row.note = String(value);
    rows.set(itemId, row);
  }

  const result = new Map<string, ServiceSelection>();
  for (const [itemId, row] of rows) {
    if (!row.needs || !row.type || !VALID_TYPES.has(row.type)) continue;
    const serviceType = row.type as ServiceType;
    const note = serviceType === "OTHER" ? (row.note ?? "").trim() || null : null;
    result.set(itemId, { serviceType, note });
  }
  return result;
}
