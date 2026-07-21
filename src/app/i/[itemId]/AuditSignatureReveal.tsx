"use client";
import { revealAuditSignatureAction } from "@/app/actions/audit";
import { SignatureReveal } from "@/components/SignatureReveal";

// Item-page audit history: reveal one auditor's signature on demand (staff-gated).
// Right-justified in the column, so the button trails the image (imageFirst) to
// keep it where the Show button was.
export function AuditSignatureReveal({ auditId, signerName }: { auditId: string; signerName: string }) {
  return (
    <SignatureReveal
      load={() => revealAuditSignatureAction(auditId)}
      alt={`Signature of ${signerName}`}
      imageFirst
    />
  );
}
