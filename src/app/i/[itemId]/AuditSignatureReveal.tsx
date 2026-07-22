"use client";
import { revealAuditSignatureAction } from "@/app/actions/audit";
import { SignatureReveal } from "@/components/SignatureReveal";

// Item-page audit history: reveal one auditor's signature on demand (staff-gated).
// Right-justified in the audit column, so anchor the reveal to the right (align
// "end") — the button stays at the right edge and the image drops below it.
export function AuditSignatureReveal({ auditId, signerName }: { auditId: string; signerName: string }) {
  return (
    <SignatureReveal
      load={() => revealAuditSignatureAction(auditId)}
      alt={`Signature of ${signerName}`}
      align="end"
    />
  );
}
