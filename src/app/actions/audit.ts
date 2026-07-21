"use server";
import { requireUser } from "@/lib/authz";
import { getAuditSignature } from "@/modules/audit/audit.service";

// Staff-only: return one audit's signature image on demand. The item-page audit
// history log keeps the signature blob out of its initial payload and reveals it
// through this action, so signatures aren't shipped to every viewer. requireUser
// re-reads role/isActive per request; the audit card is already staff-gated, and
// any signed-in staff member who can see it may reveal a signature.
export async function revealAuditSignatureAction(auditId: string): Promise<string | null> {
  await requireUser();
  return getAuditSignature(auditId);
}
